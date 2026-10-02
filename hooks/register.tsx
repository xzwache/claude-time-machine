import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { TimeMachine } from './core'
import type { RestoreReport } from './core'
import type { Change, Details, Entry } from '../types'

const PANE = 'time-machine'
const COMMAND = 'tm'
const HISTORY = 40
const DIFF_LIMIT = 9000

const entries = atom({ plugin: 'time-machine', key: 'entries' } as const, [] as Entry[])
const selected = atom({ plugin: 'time-machine', key: 'selected' } as const, null as string | null)
const details = atom({ plugin: 'time-machine', key: 'details' } as const, null as Details | null)
const confirm = atom({ plugin: 'time-machine', key: 'confirm' } as const, null as string | null)
const notice = atom({ plugin: 'time-machine', key: 'notice' } as const, '')

const machines = new Map<string, TimeMachine>()

/** The project's time machine, run through this hook's `$`. */
async function machine($: EngineInterface): Promise<TimeMachine> {
  const root = await $.session.root()
  const deps = {
    exec: (argv: readonly string[], init: Parameters<EngineInterface['process']['run']>[1]) =>
      $.process.run(argv, init),
    writeFile: (path: string, text: string) => $.fs.write(path, text),
  }
  const known = machines.get(root)
  if (known) return known.use(deps)
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const made = new TimeMachine(deps, root, `${home}/.claude/time-machine/${await digest(root)}.git`)
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
  return list
}

function report($: EngineInterface, error: unknown): string {
  const text = `Time machine: ${error instanceof Error ? error.message : String(error)}`
  $.ui.log(text)
  return text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Time machine: review, undo or travel between Claude turns',
      argumentHint: '[log | show N | undo [N] [--force] | redo | travel N | git]',
    })
    const tm = await machine($)
    void tm
      .init()
      .then(() => refresh($, tm))
      .catch(error => report($, error))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      await (await machine($)).beginTurn(e.turnId, e.text)
    } catch (error) {
      report($, error)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      const tm = await machine($)
      const entry = await tm.finishTurn(e.turnId, e.isAborted)
      if (entry) {
        $.ui.toast(`⏱ Turn saved: ${countsText(entry)}. /tm to review, /tm undo to revert`)
        await refresh($, tm)
      }
    } catch (error) {
      report($, error)
    }

    return result
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => guardWrite($, e.file_path, () => next(e)))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => guardWrite($, e.file_path, () => next(e)))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => guardWrite($, e.notebook_path, () => next(e)))

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, entries)
    const chosen = await read($, selected)
    const shown = await read($, details)
    const asked = await read($, confirm)
    const line = await read($, notice)
    const columns = Math.max(30, e.props.bodyColumns ?? e.viewport?.columns ?? 80)
    const room = Math.max(4, Math.min(12, Math.floor(((e.viewport?.rows ?? 30) - 6) / 3)))
    const entry = list.find(one => one.id === chosen)

    const pick = (id: string) => void select($, id)
    const act = (action: string, ref: string) => void perform($, action, ref)

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
            onPress={() => pick(one.id)}
          />
        ))}
        {entry && shown?.id === entry.id && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{clip(`${kindLabel(entry)} · ${entry.title}`, columns)}</Text>
            {entry.prompt !== '' && entry.prompt !== entry.title && (
              <Text dimColor>{clip(entry.prompt.replace(/\s+/g, ' '), columns * 2)}</Text>
            )}
            {shown.changes.length === 0 && <Text dimColor>No file changes.</Text>}
            {shown.changes.slice(0, 30).map((change, i) => (
              <Button
                key={`f-${i}`}
                plain
                dimColor={change.path !== shown.file}
                label={clip(`${statusMark(change)} ${change.path}`, columns)}
                onPress={() => void showFile($, entry.id, change.path)}
              />
            ))}
            {shown.changes.length > 30 && <Text dimColor>…and {shown.changes.length - 30} more</Text>}
            {entry.parent !== null && (
              <Box flexDirection="row" gap={1} marginTop={1}>
                <Button key="undo" variant="primary" label="Undo this" onPress={() => act('undo', entry.id)} />
                <Button
                  key="before"
                  label={asked === `before:${entry.id}` ? 'Confirm: travel before' : 'Travel to before'}
                  onPress={() => act('before', entry.id)}
                />
                <Button
                  key="after"
                  label={asked === `after:${entry.id}` ? 'Confirm: travel after' : 'Travel to after'}
                  onPress={() => act('after', entry.id)}
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

async function guardWrite<T>($: EngineInterface, path: string, run: () => Promise<T>): Promise<T> {
  let tm: TimeMachine | undefined
  try {
    tm = await machine($)
    await tm.beforeFileWrite(path)
  } catch (error) {
    report($, error)
  }
  const result = await run()
  try {
    await tm?.afterFileWrite(path)
  } catch (error) {
    report($, error)
  }

  return result
}

async function select($: EngineInterface, id: string): Promise<void> {
  await update($, selected, () => id)
  await update($, confirm, () => null)
  const tm = await machine($)
  const changes = await tm.changes(id)
  const first = changes[0]?.path ?? null
  const diff = first === null ? '' : await tm.fileDiff(id, first)
  await update($, details, () => ({ id, changes, file: first, diff }))
}

async function showFile($: EngineInterface, id: string, path: string): Promise<void> {
  const diff = await (await machine($)).fileDiff(id, path)
  await update($, details, shown => (shown && shown.id === id ? { ...shown, file: path, diff } : shown))
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
    const done =
      action === 'undo'
        ? await tm.undo(id)
        : await tm.travel(action === 'before' && entry.parent !== null ? entry.parent : id)
    await update($, notice, () => summaryLine(done, id.slice(0, 7)))
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
  const arg = rest.find(word => word !== '--force')
  try {
    const tm = await machine($)
    const list = await refresh($, tm)
    switch (verb) {
      case '':
      case 'open': {
        const opened = await $.ui.open({ id: PANE, title: 'Time machine', focus: true })
        if (list[0]) await select($, list[0].id)
        return opened.isPlaced ? 'Time machine opened.' : `${logText(list.slice(0, 10))}\n\n(The pane could not open here.)`
      }
      case 'log':
        return logText(list.slice(0, Number(arg) || 15))
      case 'show': {
        const entry = await resolveRef(tm, list, arg)
        const changes = await tm.changes(entry.id)
        return [`${kindLabel(entry)} · ${entry.title} (${entry.id.slice(0, 7)})`, ...changes.map(change => `  ${statusMark(change)} ${change.path}`)].join('\n')
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
      default:
        return 'Usage: /tm [log [N] | show N | undo [N] [--force] | redo | travel N | git]'
    }
  } catch (error) {
    return report($, error)
  }
}

async function resolveRef(tm: TimeMachine, list: Entry[], ref: string | undefined): Promise<Entry> {
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

function kindLabel(entry: Entry): string {
  const labels: Record<Entry['kind'], string> = {
    baseline: 'start',
    outside: 'you',
    turn: entry.isInterrupted ? 'claude!' : 'claude',
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
  return parts.length === 0 ? 'no file changes' : parts.join(' · ')
}

function statusMark(change: Change): string {
  return change.status === 'added' ? 'A' : change.status === 'deleted' ? 'D' : 'M'
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`
}

function restoreText(done: RestoreReport, id: string): string {
  const lines: string[] = []
  if (done.restored.length) lines.push(`✓ Restored ${plural(done.restored.length, 'modified file')}`)
  if (done.removed.length) lines.push(`✓ Removed ${plural(done.removed.length, 'file')}`)
  if (done.recovered.length) lines.push(`✓ Brought back ${plural(done.recovered.length, 'file')}`)
  if (done.unchanged.length) lines.push(`· ${plural(done.unchanged.length, 'file')} already back as they were`)
  if (done.conflicts.length) {
    lines.push(`⚠ Left alone, changed after that snapshot: ${done.conflicts.join(', ')}`)
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
