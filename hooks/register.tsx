// The hooks: when to snapshot, and where the time machine shows itself.
// Every use of `$` lives in this file (the engine follows `$` only within the
// hooks module); the other modules take plain values and functions.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { isReadOnlyCommand } from '../src/bash.ts'
import { runCommand } from '../src/commands.ts'
import type { Host } from '../src/commands.ts'
import { TimeMachine } from '../src/index.ts'
import type { Deps } from '../src/index.ts'
import { countsText, plural, summaryLine } from '../src/format.ts'
import { bandView, paneView } from '../src/view.tsx'
import type { Band, Details, Entry, Mode } from '../types'

const COMMAND = 'tm'
const PANE = 'time-machine'
const HISTORY = 40
const SLOW_SNAPSHOT_MS = 2000
const SHOWN_FILES = 100
const DAY_MS = 24 * 60 * 60 * 1000

const entries = atom({ plugin: 'time-machine', key: 'entries' } as const, [] as Entry[])
const selected = atom({ plugin: 'time-machine', key: 'selected' } as const, null as string | null)
const details = atom({ plugin: 'time-machine', key: 'details' } as const, null as Details | null)
const confirm = atom({ plugin: 'time-machine', key: 'confirm' } as const, null as string | null)
const notice = atom({ plugin: 'time-machine', key: 'notice' } as const, '')
const band = atom({ plugin: 'time-machine', key: 'band' } as const, null as Band | null)

const machines = new Map<string, TimeMachine>()
const gitProjects = new Map<string, boolean>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Time machine: review, undo or travel between Claude turns',
      argumentHint: '[log | show N | undo [N] | redo | travel N | save name | on | off | help]',
    })
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

  on('turn.start', async ($, e, next) => {
    await update($, band, () => null)
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
        await update($, band, () => ({ id: entry.id, summary: countsText(entry), result: null }))
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

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand(hostOf($), e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, band)
    if (shown === null || e.props.hasSurvey || e.props.isWorking) return next(e)

    return bandView($.ui.resolve(e), shown, Math.max(20, e.props.bodyColumns), {
      undo: () => void undoFromBand($, shown.id),
      review: () => void openPane($, shown.id),
      close: () => void update($, band, () => null),
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
  const made = new TimeMachine(depsOf($), root, `${await historyHome($)}/${await digest(root)}.git`)
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
  const turns = list.filter(entry => entry.kind === 'turn').length
  $.ui.status(mode === 'auto' ? `⏱ ${plural(turns, 'turn')} on the timeline` : `⏱ time machine: ${mode}`)
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
async function quietly(
  $: EngineInterface,
  work: (tm: TimeMachine, session: string) => Promise<unknown>,
): Promise<void> {
  try {
    if ((await modeOf($)) !== 'auto') return
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

async function undoFromBand($: EngineInterface, id: string): Promise<void> {
  let result: string
  try {
    const tm = await machine($)
    result = `⏱ ${summaryLine(await tm.undo(id), id)}  (/tm redo brings it back)`
    await refresh($, tm)
  } catch (error) {
    result = report($, error)
  }
  await update($, band, shown => shown && { ...shown, result })
}

async function select($: EngineInterface, id: string): Promise<void> {
  await update($, selected, () => id)
  await update($, confirm, () => null)
  const tm = await machine($)
  const entry = await tm.entry(id)
  const steps = entry?.kind === 'turn' ? await tm.steps(id) : []
  await update($, details, () => ({ id, steps, changes: [], more: 0, file: null, diff: '' }))
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
    await update($, notice, () => summaryLine(done, entry.id))
    const list = await refresh($, tm)
    if (list[0]) await select($, list[0].id)
  } catch (error) {
    await update($, notice, () => report($, error))
  }
}
