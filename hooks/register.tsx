// The hooks: when to snapshot, and where the time machine shows itself.
// Every use of `$` lives in this file (the engine follows `$` only within the
// hooks module); the other modules take plain values and functions.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { isReadOnlyCommand } from '../src/bash.ts'
import { runCommand, writeHeatPage } from '../src/commands.ts'
import type { Host } from '../src/commands.ts'
import { TimeMachine } from '../src/index.ts'
import type { Deps } from '../src/index.ts'
import { plural, summaryLine, turnSummary } from '../src/format.ts'
import { versionProblem } from '../src/version.ts'
import { alertLine } from '../src/sensitive.ts'
import { heatTree, turnsOf, viewOf } from '../src/heat.ts'
import type { Heat } from '../src/heat.ts'
import { bandView, heatView, paneView } from '../src/view.tsx'
import type { Band, Details, Entry, HeatMetric, HeatNode, HeatTurn, HeatView, Mode } from '../types'

const COMMAND = 'tm'
const PANE = 'time-machine'
const HEAT_PANE = 'time-machine-heat'
const HISTORY = 40
const SLOW_SNAPSHOT_MS = 2000
const SHOWN_FILES = 100
const DAY_MS = 24 * 60 * 60 * 1000
const OPEN_TIMEOUT_MS = 10_000

const entries = atom({ plugin: 'time-machine', key: 'entries' } as const, [] as Entry[])
const selected = atom({ plugin: 'time-machine', key: 'selected' } as const, null as string | null)
const details = atom({ plugin: 'time-machine', key: 'details' } as const, null as Details | null)
const confirm = atom({ plugin: 'time-machine', key: 'confirm' } as const, null as string | null)
const notice = atom({ plugin: 'time-machine', key: 'notice' } as const, '')
const band = atom({ plugin: 'time-machine', key: 'band' } as const, null as Band | null)
const heat = atom({ plugin: 'time-machine', key: 'heat' } as const, null as HeatView | null)

const machines = new Map<string, TimeMachine>()
let checkedVersion: Promise<string | undefined> | undefined
const gitProjects = new Map<string, boolean>()
// The whole heat tree stays out of the state, which holds the folder shown.
const heatTrees = new Map<string, HeatRead>()

type HeatRead = { from: number | null; heat: Heat; tree: HeatNode }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Time machine: review, undo or travel between Claude turns',
      argumentHint: '[log | show N | undo [N] | redo | travel N | save name | on | off | help]',
    })
    const problem = await versionCheck($)
    if (problem !== undefined) {
      $.ui.toast(`⏱ ${problem}`)
      $.ui.log(problem)
      return next(e)
    }
    if ((await modeOf($)) !== 'off') {
      const tm = await machine($)
      void tm
        .init()
        .then(() => pruneByRetention($, tm))
        .then(() => refresh($, tm))
        .then(() => tm.maintain())
        .catch(error => report($, error))
    }

    return next(e)
  })

  // The band belongs to the last turn until the person sends the next prompt: a
  // turn Claude starts by itself (a background task finishing) leaves it be.
  on('prompt.submit', async ($, e, next) => {
    await update($, band, () => null)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const started = Date.now()
    await quietly($, (tm, session) => tm.beginTurn(e.turnId, e.text, session))
    const took = Date.now() - started
    if (took > SLOW_SNAPSHOT_MS) {
      $.ui.toast(
        `⏱ Snapshot took ${(took / 1000).toFixed(1)}s. List big folders in .tmignore or .gitignore to speed it up.`,
      )
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await quietly($, async (tm, session) => {
      const entry = await tm.finishTurn(e.turnId, session, e.isAborted, e.answer)
      if (entry) {
        const findings = await tm.findings(entry.id).catch(error => {
          report($, error)
          return []
        })
        const alert = findings.length > 0 ? alertLine(findings) : null
        await update($, band, () => ({ id: entry.id, summary: turnSummary(entry), alert, confirm: null, result: null }))
        await refresh($, tm)
      }
      void tm.maintain().catch(error => report($, error))
    })

    return result
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    await quietly($, (tm, session) => tm.beforeFileWrite(e.file_path, session))
    const result = await next(e)
    await quietly($, (tm, session) => tm.afterFileWrite(e.file_path, 'Write', session))

    return result
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    await quietly($, (tm, session) => tm.beforeFileWrite(e.file_path, session))
    const result = await next(e)
    await quietly($, (tm, session) => tm.afterFileWrite(e.file_path, 'Edit', session))

    return result
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    await quietly($, (tm, session) => tm.beforeFileWrite(e.notebook_path, session))
    const result = await next(e)
    await quietly($, (tm, session) => tm.afterFileWrite(e.notebook_path, 'NotebookEdit', session))

    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A command that cannot write the work tree needs no snapshots around it.
    if (isReadOnlyCommand(e.command)) return next(e)
    await quietly($, (tm, session) => tm.beforeCommand(session))
    const result = await next(e)
    await quietly($, (tm, session) => tm.afterCommand(e.command, session))

    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({
    text: (await versionCheck($)) ?? (await runCommand(hostOf($), e.args)),
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, band)
    if (shown === null || e.props.hasSurvey || e.props.isWorking) return next(e)

    return bandView($.ui.resolve(e), shown, Math.max(20, e.props.bodyColumns), {
      undo: () => void update($, band, now => now && { ...now, confirm: 'turn' as const }),
      undoSensitive: () => void update($, band, now => now && { ...now, confirm: 'sensitive' as const }),
      confirm: () => void undoFromBand($, shown.id, shown.confirm === 'sensitive'),
      cancel: () => void update($, band, now => now && { ...now, confirm: null }),
      review: () => void openPane($, shown.id),
      close: () => void update($, band, () => null),
    })
  })

  on('ui.render', { component: 'Pane', requestId: HEAT_PANE }, async ($, e) => {
    const view = await read($, heat)
    const table = $.ui.resolve(e)
    if (view === null) {
      const { Text } = table
      return <Text dimColor>Run /tm heat to draw the map.</Text>
    }

    return heatView(table, e.surface, view, Math.max(30, e.props.bodyColumns), e.viewport?.rows ?? 40, {
      metric: metric => void update($, heat, now => now && { ...now, metric }),
      enter: node => void heatAction($, () => (node.isDir ? moveHeat($, view, node.path) : pickFile($, view, node))),
      up: path => void heatAction($, () => moveHeat($, view, path)),
      openPage: () => void heatAction($, () => openHeatPage($, view)),
      openTurn: id => void openPane($, id),
      closeFile: () => void update($, heat, now => now && { ...now, file: null }),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = {
      list: await read($, entries),
      chosen: await read($, selected),
      shown: await read($, details),
      asked: await read($, confirm),
      notice: await read($, notice),
      columns: Math.max(30, e.props.bodyColumns),
      rows: e.viewport?.rows ?? 30,
    }

    return paneView($.ui.resolve(e), data, {
      select: id => void select($, id),
      showStep: id => void showStep($, id),
      showFile: path => void showFile($, path),
      perform: (action, entry) => void perform($, action, entry),
    })
  })
}

function depsOf($: EngineInterface): Deps {
  return {
    exec: (argv, init) => $.process.run(argv, init),
    writeFile: (path, text) => $.fs.write(path, text),
  }
}

function hostOf($: EngineInterface): Host {
  return {
    machine: () => machine($),
    refresh: tm => refresh($, tm),
    session: () => $.session.id(),
    mode: () => modeOf($),
    setMode: mode => setMode($, mode),
    openPane: () => openPane($, undefined),
    home: () => historyHome($),
    exec: depsOf($).exec,
    hasHistory: async () => $.fs.exists((await machine($)).gitDir),
    forget: root => void machines.delete(root),
    report: error => report($, error),
    writeFile: (path, text) => $.fs.write(path, text),
    copy: async text => (await $.ui.copy({ text })).isCopied,
    retention: async () => {
      const days = await $.store.get(`retain:${await digest(await $.session.root())}`)
      return typeof days === 'number' ? days : null
    },
    setRetention: async days => $.store.set(`retain:${await digest(await $.session.root())}`, days),
    showHeat: (read, from, metric) => showHeat($, read, from, metric),
    showResult: async text => {
      await update($, band, now => now && { ...now, confirm: null, result: `⏱ ${text}` })
    },
    isKeepingSecrets: async () => (await $.store.get(`secrets:${await digest(await $.session.root())}`)) === 'keep',
    setKeepingSecrets: async isKeeping => {
      const key = `secrets:${await digest(await $.session.root())}`
      if (isKeeping) await $.store.set(key, 'keep')
      else await $.store.delete(key)
      ;(await machine($)).keepSecrets(isKeeping)
    },
    openFile: path => openFile($, path),
  }
}

async function showHeat($: EngineInterface, read: Heat, from: number | null, metric: HeatMetric): Promise<boolean> {
  const tree = heatTree(read.files)
  heatTrees.set(await $.session.root(), { from, heat: read, tree })
  await update($, heat, () => viewOf(tree, read, { path: '', metric, from }))
  return (await $.ui.open({ id: HEAT_PANE, title: 'Heat', focus: true })).isPlaced
}

/** The read the pane was drawn from; read again after a reload, over the same window. */
async function heatRead($: EngineInterface, from: number | null): Promise<HeatRead> {
  const root = await $.session.root()
  const known = heatTrees.get(root)
  if (known && known.from === from) return known
  const fresh = await (await machine($)).heat(from)
  const made = { from, heat: fresh, tree: heatTree(fresh.files) }
  heatTrees.set(root, made)
  return made
}

/** Runs a pane action; a failure shows as the pane's notice. */
async function heatAction($: EngineInterface, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    const notice = report($, error)
    await update($, heat, now => now && { ...now, notice })
  }
}

async function moveHeat($: EngineInterface, view: HeatView, path: string): Promise<void> {
  const { heat: known, tree } = await heatRead($, view.from)
  const next = viewOf(tree, known, { path, metric: view.metric, from: view.from })
  await update($, heat, () => ({ ...next, page: view.page }))
}

async function pickFile($: EngineInterface, view: HeatView, node: HeatNode): Promise<void> {
  const tm = await machine($)
  const { heat: known } = await heatRead($, view.from)
  const entries = await Promise.all(turnsOf(known, node.path).map(id => tm.entry(id)))
  const turns: HeatTurn[] = entries.flatMap(entry =>
    entry ? [{ id: entry.id, title: entry.title, time: entry.time }] : [],
  )
  await update($, heat, now => now && { ...now, file: { path: node.path, turns }, notice: '' })
}

async function openHeatPage($: EngineInterface, view: HeatView): Promise<void> {
  const { heat: known } = await heatRead($, view.from)
  const page = await writeHeatPage(hostOf($), await machine($), known)
  const notice = (await openFile($, page)) ? 'Opened in your browser.' : `Wrote ${page}; open it in a browser.`
  await update($, heat, now => now && { ...now, page, notice })
}

/** `open` on macOS, `xdg-open` elsewhere; false when neither worked. */
async function openFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    const system = (await $.process.run(['uname', '-s'], {})).stdout.trim()
    const opener = system === 'Darwin' ? 'open' : 'xdg-open'
    return (await $.process.run([opener, path], { timeoutMs: OPEN_TIMEOUT_MS })).exitCode === 0
  } catch {
    return false
  }
}

/** Prunes by the project's retention, at most once a day. */
async function pruneByRetention($: EngineInterface, tm: TimeMachine): Promise<void> {
  const key = await digest(await $.session.root())
  const days = await $.store.get(`retain:${key}`)
  const last = await $.store.get(`pruned:${key}`)
  if (typeof days !== 'number' || (typeof last === 'number' && Date.now() - last < DAY_MS)) return
  try {
    await tm.prune({ olderThanMs: days * DAY_MS })
    await $.store.set(`pruned:${key}`, Date.now())
  } catch (error) {
    // Another session's turn is running: try again next session.
    report($, error)
  }
}

async function historyHome($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/time-machine`
}

/** The project's time machine, run through this hook's `$`. */
async function machine($: EngineInterface): Promise<TimeMachine> {
  const root = await $.session.root()
  const known = machines.get(root)
  if (known) return known.use(depsOf($))
  const id = await digest(root)
  const isKeeping = (await $.store.get(`secrets:${id}`)) === 'keep'
  const made = new TimeMachine(depsOf($), root, `${await historyHome($)}/${id}.git`).keepSecrets(isKeeping)
  machines.set(root, made)
  return made
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/**
 * The project's mode, kept across sessions. Until set, a git project is
 * `auto` and any other folder `off`: Claude started in a home folder or in
 * /tmp must not snapshot everything under it.
 */
async function modeOf($: EngineInterface): Promise<Mode> {
  const root = await $.session.root()
  const stored = await $.store.get(`mode:${await digest(root)}`)
  if (stored === 'auto' || stored === 'manual' || stored === 'off') return stored
  return (await isGitProject($, root)) ? 'auto' : 'off'
}

async function setMode($: EngineInterface, mode: Mode): Promise<void> {
  const root = await $.session.root()
  if (mode !== 'off' && (await isHomeOrRoot($, root))) {
    throw new Error(`${root} is your home folder or the file system root; the time machine stays off here`)
  }
  await $.store.set(`mode:${await digest(root)}`, mode)
  $.ui.status(mode === 'auto' ? '⏱ time machine on' : `⏱ time machine: ${mode}`)
}

async function isHomeOrRoot($: EngineInterface, root: string): Promise<boolean> {
  const home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
  return root === '/' || root === home
}

/** Whether the root is inside a git work tree (and not the home folder). */
async function isGitProject($: EngineInterface, root: string): Promise<boolean> {
  const known = gitProjects.get(root)
  if (known !== undefined) return known
  const isGit =
    !(await isHomeOrRoot($, root)) &&
    (await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: root })).stdout.trim() === 'true'
  gitProjects.set(root, isGit)
  return isGit
}

/** Re-reads the timeline into the pane's state and the status line. */
async function refresh($: EngineInterface, tm: TimeMachine): Promise<Entry[]> {
  const list = await tm.history(HISTORY)
  // File lists stay out of the state (it has a size limit); the pane reads
  // one entry's files when it is selected.
  await update($, entries, () => list.map(entry => ({ ...entry, changes: [] })))
  const mode = await modeOf($)
  const session = await $.session.id()
  const turns = list.filter(entry => entry.kind === 'turn' && entry.session === session).length
  const status = turns === 0 ? '⏱ time machine on' : `⏱ ${plural(turns, 'turn')} this session, undoable`
  $.ui.status(mode === 'auto' ? status : `⏱ time machine: ${mode}`)
  return list
}

function report($: EngineInterface, error: unknown): string {
  const text = `Time machine: ${error instanceof Error ? error.message : String(error)}`
  $.ui.log(text)
  return text
}

/**
 * Runs snapshot work for a hook, only in `auto` mode, never failing the hook:
 * a time machine error must not stop Claude's turn.
 */
/** Why this Claude Code cannot run the time machine, once per load; undefined when it can. */
function versionCheck($: EngineInterface): Promise<string | undefined> {
  checkedVersion ??= (async () => {
    // Every release with this call answers it; one that cannot is older than it.
    try {
      const { base, version } = await $.session.version()
      return versionProblem(base ?? version)
    } catch {
      return versionProblem(undefined)
    }
  })()
  return checkedVersion
}

async function quietly(
  $: EngineInterface,
  work: (tm: TimeMachine, session: string) => Promise<unknown>,
): Promise<void> {
  try {
    if ((await versionCheck($)) !== undefined || (await modeOf($)) !== 'auto') return
    await work(await machine($), await $.session.id())
  } catch (error) {
    report($, error)
  }
}

async function openPane($: EngineInterface, id: string | undefined): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Time machine', focus: true })
  const target = id ?? (await read($, entries))[0]?.id
  if (target !== undefined) await select($, target)
  return opened.isPlaced
}

async function undoFromBand($: EngineInterface, id: string, isSensitiveOnly: boolean): Promise<void> {
  let result: string
  try {
    const tm = await machine($)
    const done = isSensitiveOnly ? await tm.undoSensitive(id) : await tm.undo(id)
    result = done ? `⏱ ${summaryLine(done, id)}  (/tm redo brings it back)` : '⏱ Nothing flagged to undo.'
    await refresh($, tm)
  } catch (error) {
    result = report($, error)
  }
  await update($, band, shown => shown && { ...shown, confirm: null, result })
}

async function select($: EngineInterface, id: string): Promise<void> {
  await update($, selected, () => id)
  await update($, confirm, () => null)
  const tm = await machine($)
  const entry = await tm.entry(id)
  const steps = entry?.kind === 'turn' ? await tm.steps(id) : []
  const shown = entry ? { ...entry, changes: [] } : null
  await update($, details, () => ({ id, entry: shown, steps, changes: [], more: 0, file: null, diff: '' }))
  await showStep($, id)
}

async function showStep($: EngineInterface, id: string): Promise<void> {
  const tm = await machine($)
  const all = await tm.changes(id)
  const changes = all.slice(0, SHOWN_FILES)
  const more = all.length - changes.length
  const file = changes[0]?.path ?? null
  const diff = file === null ? '' : await tm.fileDiff(id, file)
  await update($, details, shown => (shown ? { ...shown, id, changes, more, file, diff } : shown))
}

async function showFile($: EngineInterface, path: string): Promise<void> {
  const shown = await read($, details)
  if (!shown) return
  const diff = await (await machine($)).fileDiff(shown.id, path)
  await update($, details, now => (now && now.id === shown.id ? { ...now, file: path, diff } : now))
}

/** A pane button: undo now; travel only on a second press. */
async function perform($: EngineInterface, action: 'undo' | 'before' | 'after', entry: Entry): Promise<void> {
  const key = `${action}:${entry.id}`
  if (action !== 'undo' && (await read($, confirm)) !== key) {
    await update($, confirm, () => key)
    return
  }
  await update($, confirm, () => null)
  try {
    const tm = await machine($)
    const before = entry.base ?? entry.parent
    const target = action === 'before' && before !== null ? before : entry.id
    const done = action === 'undo' ? await tm.undo(entry.id) : await tm.travel(target)
    const said = summaryLine(done, entry.id)
    await update($, notice, () => said)
    await update($, band, now => now && { ...now, confirm: null, result: `⏱ ${said}` })
    const list = await refresh($, tm)
    if (list[0]) await select($, list[0].id)
  } catch (error) {
    await update($, notice, () => report($, error))
  }
}
