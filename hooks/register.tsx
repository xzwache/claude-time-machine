import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { TimeMachine, deleteProject, listProjects } from './core'
import type { Deps, RestoreReport } from './core'
import type { Band, Change, Details, Entry, Project } from '../types'

const PANE = 'time-machine'
const COMMAND = 'tm'
const HISTORY = 40
const DIFF_LIMIT = 9000
const SLOW_SNAPSHOT_MS = 2000
const DAY_MS = 24 * 60 * 60 * 1000

const entries = atom({ plugin: 'time-machine', key: 'entries' } as const, [] as Entry[])
const selected = atom({ plugin: 'time-machine', key: 'selected' } as const, null as string | null)
const details = atom({ plugin: 'time-machine', key: 'details' } as const, null as Details | null)
const confirm = atom({ plugin: 'time-machine', key: 'confirm' } as const, null as string | null)
const notice = atom({ plugin: 'time-machine', key: 'notice' } as const, '')
const band = atom({ plugin: 'time-machine', key: 'band' } as const, null as Band | null)

const machines = new Map<string, TimeMachine>()

function depsOf($: EngineInterface): Deps {
  return {
    exec: (argv, init) => $.process.run(argv, init),
    writeFile: (path, text) => $.fs.write(path, text),
  }
}

async function home($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/time-machine`
}

/** The project's time machine, run through this hook's `$`. */
async function machine($: EngineInterface): Promise<TimeMachine> {
  const root = await $.session.root()
  const known = machines.get(root)
  if (known) return known.use(depsOf($))
  const made = new TimeMachine(depsOf($), root, `${await home($)}/${await digest(root)}.git`)
  machines.set(root, made)
  return made
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

async function refresh($: EngineInterface, tm: TimeMachine): Promise<Entry[]> {
  const list = await tm.history(HISTORY)
  await update($, entries, () => list)
  const turns = list.filter(entry => entry.kind === 'turn').length
  $.ui.status(`⏱ ${plural(turns, 'turn')} on the timeline`)
  return list
}

function report($: EngineInterface, error: unknown): string {
  const text = `Time machine: ${error instanceof Error ? error.message : String(error)}`
  $.ui.log(text)
  return text
}

/** Runs time machine work for a hook without ever failing the hook. */
async function quietly($: EngineInterface, work: (tm: TimeMachine, session: string) => Promise<unknown>): Promise<void> {
  try {
    await work(await machine($), await $.session.id())
  } catch (error) {
    report($, error)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Time machine: review, undo or travel between Claude turns',
      argumentHint: '[log | show N | undo [N] | redo | travel N | projects | prune 30d | help]',
    })
    const tm = await machine($)
    void tm
      .init()
      .then(() => refresh($, tm))
      .then(() => tm.maintain())
      .catch(error => report($, error))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, band, () => null)
    const started = Date.now()
    await quietly($, (tm, session) => tm.beginTurn(e.turnId, e.text, session))
    const took = Date.now() - started
    if (took > SLOW_SNAPSHOT_MS) {
      $.ui.toast(`⏱ Snapshot took ${(took / 1000).toFixed(1)}s. Ignore big generated folders in .gitignore to speed it up.`)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await quietly($, async (tm, session) => {
      const entry = await tm.finishTurn(e.turnId, session, e.isAborted, e.answer)
      if (entry) {
        await update($, band, () => ({ id: entry.id, summary: countsText(entry), result: null }))
        await refresh($, tm)
      }
      void tm.maintain().catch(error => report($, error))
    })

    return result
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => fileStep($, 'Write', e.file_path, () => next(e)))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => fileStep($, 'Edit', e.file_path, () => next(e)))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    fileStep($, 'NotebookEdit', e.notebook_path, () => next(e)),
  )
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await quietly($, (tm, session) => tm.beforeCommand(session))
    const result = await next(e)
    await quietly($, (tm, session) => tm.afterCommand(e.command, session))

    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, band)
    if (shown === null || e.props.hasSurvey || e.props.isWorking) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = Math.max(20, e.props.bodyColumns)

    if (shown.result !== null) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text color="green">{clip(shown.result, columns - 6)}</Text>
          <Button key="tm-close" role="dismiss" label="×" onPress={() => void update($, band, () => null)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{clip(`⏱ Claude changed ${shown.summary}`, Math.max(10, columns - 34))}</Text>
        <Button key="tm-undo" variant="primary" hotkey="u" label="Undo turn" onPress={() => void undoFromBand($, shown.id)} />
        <Button key="tm-review" hotkey="r" label="Review" onPress={() => void openPane($, shown.id)} />
        <Button key="tm-close" role="dismiss" label="×" onPress={() => void update($, band, () => null)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, entries)
    const chosen = await read($, selected)
    const shown = await read($, details)
    const asked = await read($, confirm)
    const line = await read($, notice)
    const columns = Math.max(30, e.props.bodyColumns)
    const room = Math.max(4, Math.min(12, Math.floor(((e.viewport?.rows ?? 30) - 8) / 3)))
    const entry = list.find(one => one.id === chosen)
    const focus = shown?.id === entry?.id ? entry : shown?.steps.find(step => step.id === shown.id)

    return (
      <Box flexDirection="column">
        {line !== '' && <Text color="yellow">{clip(line, columns)}</Text>}
        {list.length === 0 && <Text dimColor>No snapshots yet. They appear after Claude changes files.</Text>}
        {list.slice(0, room).map((one, i) => (
          <Button
            key={`e-${i}`}
            plain
            dimColor={one.id !== chosen}
            label={clip(`${one.id === chosen ? '▸' : ' '} ${i + 1}. ${entryLine(one)}`, columns)}
            onPress={() => void select($, one.id)}
          />
        ))}
        {entry && shown && focus && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{clip(`${kindLabel(entry)} · ${entry.title}`, columns)}</Text>
            {entry.prompt !== '' && entry.prompt !== entry.title && (
              <Text dimColor>{clip(`› ${entry.prompt.replace(/\s+/g, ' ')}`, columns * 2)}</Text>
            )}
            {entry.answer !== '' && <Text dimColor>{clip(`‹ ${entry.answer.replace(/\s+/g, ' ')}`, columns * 2)}</Text>}
            {shown.steps.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Button
                  key="s-all"
                  plain
                  dimColor={shown.id !== entry.id}
                  label={`${shown.id === entry.id ? '▸' : ' '} whole turn  ${countsShort(entry)}`}
                  onPress={() => void showStep($, entry.id)}
                />
                {shown.steps.slice(0, 15).map((step, i) => (
                  <Button
                    key={`s-${i}`}
                    plain
                    dimColor={shown.id !== step.id}
                    label={clip(`${shown.id === step.id ? '▸' : ' '}   ${i + 1}. ${stepLabel(step)}  ${countsShort(step)}`, columns)}
                    onPress={() => void showStep($, step.id)}
                  />
                ))}
              </Box>
            )}
            <Box flexDirection="column" marginTop={1}>
              {shown.changes.length === 0 && <Text dimColor>No file changes.</Text>}
              {shown.changes.slice(0, 30).map((change, i) => (
                <Button
                  key={`f-${i}`}
                  plain
                  dimColor={change.path !== shown.file}
                  label={clip(`${statusMark(change)} ${change.path}`, columns)}
                  onPress={() => void showFile($, change.path)}
                />
              ))}
              {shown.changes.length > 30 && <Text dimColor>…and {shown.changes.length - 30} more</Text>}
            </Box>
            {focus.parent !== null && (
              <Box flexDirection="row" gap={1} marginTop={1}>
                <Button
                  key="undo"
                  variant="primary"
                  label={focus.id === entry.id ? 'Undo this' : 'Undo this step'}
                  onPress={() => void perform($, 'undo', focus.id)}
                />
                <Button
                  key="before"
                  label={asked === `before:${focus.id}` ? 'Confirm: travel before' : 'Travel to before'}
                  onPress={() => void perform($, 'before', focus.id)}
                />
                <Button
                  key="after"
                  label={asked === `after:${focus.id}` ? 'Confirm: travel after' : 'Travel to after'}
                  onPress={() => void perform($, 'after', focus.id)}
                />
              </Box>
            )}
            {shown.file !== null && <DiffView Code={Code} Text={Text} diff={shown.diff} path={shown.file} />}
          </Box>
        )}
      </Box>
    )
  })
}

type Table = ReturnType<EngineInterface['ui']['resolve']>

function DiffView(props: { Code: Table['Code']; Text: Table['Text']; diff: string; path: string }) {
  const { Code, Text } = props
  const hunks = hunksOf(props.diff)
  if (hunks === undefined) return <Text dimColor>Binary file, or only its mode changed.</Text>
  if (hunks === '') return <Text dimColor>Diff too large to show here: see /tm git.</Text>

  return <Code source={hunks} format="diff" path={props.path} />
}

async function fileStep<T>($: EngineInterface, tool: string, path: string, run: () => Promise<T>): Promise<T> {
  await quietly($, (tm, session) => tm.beforeFileWrite(path, session))
  const result = await run()
  await quietly($, (tm, session) => tm.afterFileWrite(path, tool, session))

  return result
}

async function openPane($: EngineInterface, id: string | undefined): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Time machine', focus: true })
  const target = id ?? (await read($, entries))[0]?.id
  if (target !== undefined) await select($, target)
  return opened.isPlaced
}

async function undoFromBand($: EngineInterface, id: string): Promise<void> {
  try {
    const tm = await machine($)
    const done = await tm.undo(id)
    await update($, band, shown => shown && { ...shown, result: `⏱ ${summaryLine(done, id)}  (/tm redo brings it back)` })
    await refresh($, tm)
  } catch (error) {
    const text = report($, error)
    await update($, band, shown => shown && { ...shown, result: text })
  }
}

async function select($: EngineInterface, id: string): Promise<void> {
  await update($, selected, () => id)
  await update($, confirm, () => null)
  const tm = await machine($)
  const entry = await tm.entry(id)
  const steps = entry?.kind === 'turn' ? await tm.steps(id) : []
  await update($, details, () => ({ id, steps, changes: [], file: null, diff: '' }))
  await showStep($, id)
}

async function showStep($: EngineInterface, id: string): Promise<void> {
  const tm = await machine($)
  const changes = await tm.changes(id)
  const file = changes[0]?.path ?? null
  const diff = file === null ? '' : await tm.fileDiff(id, file)
  await update($, details, shown => (shown ? { ...shown, id, changes, file, diff } : shown))
}

async function showFile($: EngineInterface, path: string): Promise<void> {
  const shown = await read($, details)
  if (!shown) return
  const diff = await (await machine($)).fileDiff(shown.id, path)
  await update($, details, now => (now && now.id === shown.id ? { ...now, file: path, diff } : now))
}

/** A pane button: undo now; travel only on a second press. */
async function perform($: EngineInterface, action: string, id: string): Promise<void> {
  const key = `${action}:${id}`
  if (action !== 'undo' && (await read($, confirm)) !== key) {
    await update($, confirm, () => key)
    return
  }
  await update($, confirm, () => null)
  try {
    const tm = await machine($)
    const entry = await tm.entry(id)
    if (!entry) throw new Error('That snapshot is gone')
    const before = entry.base ?? entry.parent
    const done =
      action === 'undo' ? await tm.undo(id) : await tm.travel(action === 'before' && before !== null ? before : id)
    await update($, notice, () => summaryLine(done, id))
    const list = await refresh($, tm)
    if (list[0]) await select($, list[0].id)
  } catch (error) {
    await update($, notice, () => report($, error))
  }
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const [verb = '', ...rest] = words
  const isForced = rest.includes('--force')
  const arg = rest.find(word => !word.startsWith('--'))
  try {
    const tm = await machine($)
    const list = await refresh($, tm)
    switch (verb) {
      case '':
      case 'open': {
        const isPlaced = await openPane($, undefined)
        return isPlaced ? 'Time machine opened.' : `${logText(list.slice(0, 10))}\n\n(The pane could not open here.)`
      }
      case 'log': {
        const session = await $.session.id()
        const shown = rest.includes('--session') ? list.filter(one => one.session === session) : list
        return logText(shown.slice(0, Number(arg) || 15))
      }
      case 'show':
      case 'steps': {
        const entry = await resolveRef(tm, list, arg)
        const steps = entry.kind === 'turn' ? await tm.steps(entry.id) : []
        return [
          `${kindLabel(entry)} · ${entry.title} (${entry.id.slice(0, 7)})`,
          ...entry.changes.map(change => `  ${statusMark(change)} ${change.path}`),
          ...(steps.length > 0 ? ['Steps:', ...steps.map((step, i) => `  ${arg ?? '1'}.${i + 1} ${stepLabel(step)}  ${countsShort(step)}`)] : []),
          ...(entry.answer !== '' ? ['Answer:', `  ${clip(entry.answer.replace(/\s+/g, ' '), 400)}`] : []),
        ].join('\n')
      }
      case 'undo': {
        const entry = arg ? await resolveRef(tm, list, arg) : list.find(one => one.kind === 'turn')
        if (!entry) return 'No Claude turn to undo yet.'
        return `Undo ${kindLabel(entry)} "${entry.title}":\n${restoreText(await tm.undo(entry.id, isForced), entry.id)}`
      }
      case 'redo': {
        const last = list[0]
        if (!last || last.kind !== 'undo' || !last.target) return 'Nothing to redo: the latest snapshot is not an undo.'
        return `Redo "${last.title.replace(/^(Undo|Redo): /, '')}":\n${restoreText(await tm.undo(last.id, isForced), last.id)}`
      }
      case 'travel': {
        if (!arg) return 'Name a snapshot: /tm travel 3 (see /tm log).'
        const entry = await resolveRef(tm, list, arg)
        return `Travelled to "${entry.title}":\n${restoreText(await tm.travel(entry.id), entry.id)}`
      }
      case 'git':
        return `Inspect the timeline with plain git:\n  ${tm.inspectCommand()}\n  (git show <id>, git diff <a> <b> work with the same --git-dir.)`
      case 'stats': {
        const stats = await tm.stats()
        return `${plural(stats.entries, 'snapshot')}, ${size(stats.bytes)} on disk at ${tm.gitDir}`
      }
      case 'prune': {
        const options = pruneOptions(arg)
        if (!options) return 'Usage: /tm prune 30d (older than 30 days) or /tm prune 50 (keep the newest 50).'
        const done = await tm.prune(options)
        await refresh($, tm)
        return done.removed === 0
          ? 'Nothing to prune.'
          : `Pruned ${plural(done.removed, 'snapshot')}, kept ${done.kept}. ${size(done.bytesBefore)} → ${size(done.bytesAfter)}.`
      }
      case 'projects':
        return await projectsCommand($, tm, rest)
      case 'forget':
        return 'To delete this project\'s whole history: /tm projects rm <N> (see /tm projects).'
      default:
        return HELP
    }
  } catch (error) {
    return report($, error)
  }
}

const HELP = [
  'Usage: /tm [command]',
  '  (none)               open the Time machine pane',
  '  log [N] [--session]  list snapshots, newest first',
  '  show N               files, steps and answer of snapshot N',
  '  undo [N|N.k] [--force]  revert a turn (default: the latest) or one of its steps',
  '  redo                 undo the latest undo',
  '  travel N             put every file back to snapshot N',
  '  prune 30d | prune 50 forget old snapshots (by age, or keep the newest N)',
  '  stats                snapshots and disk use for this project',
  '  projects [rm N]      every project with a history; delete one',
  '  git                  the git command to browse the timeline yourself',
].join('\n')

async function projectsCommand($: EngineInterface, tm: TimeMachine, rest: string[]): Promise<string> {
  const base = await home($)
  const projects = await listProjects(depsOf($).exec, base)
  if (rest[0] === 'rm') {
    const project = projects[Number(rest[1]) - 1]
    if (!project) return 'Name a project by its number in /tm projects.'
    if (rest[2] !== '--yes') {
      return `This deletes the whole history of ${project.root || project.name} (${size(project.bytes)}).\nRun /tm projects rm ${rest[1]} --yes to confirm.`
    }
    await deleteProject(depsOf($).exec, base, project.name)
    if (project.gitDir === tm.gitDir) machines.delete(tm.root)
    return `Deleted the history of ${project.root || project.name}.`
  }
  if (projects.length === 0) return 'No project has a history yet.'
  const total = projects.reduce((sum, one) => sum + one.bytes, 0)
  return [
    ...projects.map((one, i) => projectLine(one, i, one.gitDir === tm.gitDir)),
    `${plural(projects.length, 'project')}, ${size(total)} in ${base}`,
    'Delete one with /tm projects rm N; trim one with /tm prune inside it.',
  ].join('\n')
}

function projectLine(project: Project, i: number, isCurrent: boolean): string {
  const age = project.lastTime === 0 ? 'never' : `${Math.max(0, Math.round((Date.now() - project.lastTime) / DAY_MS))}d ago`
  const gone = project.isRootPresent ? '' : '  (folder gone)'
  return `${String(i + 1).padStart(2)}. ${isCurrent ? '▸' : ' '} ${project.root || project.name}  ${plural(project.entries, 'snapshot')}, ${size(project.bytes)}, last ${age}${gone}`
}

function pruneOptions(arg: string | undefined): { olderThanMs?: number; keepLast?: number } | undefined {
  const days = arg === undefined ? null : /^(\d+)d$/.exec(arg)
  if (days) return { olderThanMs: Number(days[1]) * DAY_MS }
  if (arg !== undefined && /^\d+$/.test(arg)) return { keepLast: Number(arg) }
  return undefined
}

async function resolveRef(tm: TimeMachine, list: Entry[], ref: string | undefined): Promise<Entry> {
  const step = ref === undefined ? null : /^(\d{1,3})\.(\d{1,3})$/.exec(ref)
  if (step) {
    const turn = list[Number(step[1]) - 1]
    const found = turn ? (await tm.steps(turn.id))[Number(step[2]) - 1] : undefined
    if (!found) throw new Error(`No step ${ref} (see /tm show ${step[1]})`)
    return found
  }
  const index = ref !== undefined && /^\d{1,3}$/.test(ref) ? list[Number(ref) - 1] : undefined
  const entry = index ?? (ref ? await tm.entry(ref) : list[0])
  if (!entry) throw new Error(`No snapshot ${ref ?? ''} (see /tm log)`)
  return entry
}

function logText(list: Entry[]): string {
  if (list.length === 0) return 'No snapshots yet.'
  return list.map((one, i) => `${String(i + 1).padStart(2)}. ${entryLine(one)}  ${one.id.slice(0, 7)}`).join('\n')
}

function entryLine(entry: Entry): string {
  const date = new Date(entry.time)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const counts = entry.kind === 'baseline' ? '' : `  ${countsShort(entry)}`
  return `${time} ${kindLabel(entry).padEnd(7)} ${entry.title}${counts}`
}

function stepLabel(step: Entry): string {
  return step.kind === 'step' ? step.title : `(not Claude) ${step.title}`
}

function kindLabel(entry: Entry): string {
  const labels: Record<Entry['kind'], string> = {
    baseline: 'start',
    outside: 'you',
    turn: entry.isInterrupted ? 'claude!' : 'claude',
    step: 'step',
    capture: 'capture',
    undo: entry.title.startsWith('Redo: ') ? 'redo' : 'undo',
    travel: 'travel',
  }
  return labels[entry.kind]
}

function countsShort(entry: Entry): string {
  const { added, modified, deleted } = entry.counts
  return [added && `+${added}`, modified && `~${modified}`, deleted && `-${deleted}`].filter(Boolean).join(' ')
}

function countsText(entry: Entry): string {
  const { added, modified, deleted } = entry.counts
  const parts = [
    modified && `${modified} modified`,
    added && `${added} created`,
    deleted && `${deleted} deleted`,
  ].filter(Boolean)
  return parts.length === 0 ? 'no files' : parts.join(' · ')
}

function statusMark(change: Change): string {
  return change.status === 'added' ? 'A' : change.status === 'deleted' ? 'D' : 'M'
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function restoreText(done: RestoreReport, id: string): string {
  const lines: string[] = []
  if (done.restored.length) lines.push(`✓ Restored ${plural(done.restored.length, 'modified file')}`)
  if (done.removed.length) lines.push(`✓ Removed ${plural(done.removed.length, 'file')}`)
  if (done.recovered.length) lines.push(`✓ Brought back ${plural(done.recovered.length, 'file')}`)
  if (done.unchanged.length) lines.push(`· ${plural(done.unchanged.length, 'file')} already back as they were`)
  if (done.conflicts.length) {
    lines.push(`⚠ Left alone, changed by someone else since: ${done.conflicts.join(', ')}`)
    lines.push(`  /tm undo ${id.slice(0, 7)} --force overwrites them (still undoable).`)
  }
  if (lines.length === 0) lines.push('Nothing to change: the files are already there.')
  return lines.join('\n')
}

function summaryLine(done: RestoreReport, id: string): string {
  return restoreText(done, id).split('\n').join('  ')
}

/**
 * The unified diff from its first hunk, whole hunks only, within the limit:
 * undefined when there is no hunk, '' when not even the first one fits.
 */
function hunksOf(diff: string): string | undefined {
  const start = diff.search(/^@@ /m)
  if (start < 0) return undefined
  const clean = diff.slice(start).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?')
  const hunks = clean.split(/(?=^@@ )/m)
  let out = ''
  for (const hunk of hunks) {
    if (out.length + hunk.length > DIFF_LIMIT) break
    out += hunk
  }
  return out.replace(/\n$/, '')
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}
