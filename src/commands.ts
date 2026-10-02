// `/tm` and its subcommands. What they need from the session comes in as a
// Host of plain functions, which register.tsx builds.

import type { Exec, TimeMachine } from './index.ts'
import { deleteProject, listProjects } from './index.ts'
import {
  clip,
  countsShort,
  kindLabel,
  logText,
  oneLine,
  plural,
  projectLine,
  restoreText,
  size,
  statusMark,
  stepLabel,
} from './format.ts'
import { METRICS, heatText, heatTree } from './heat.ts'
import type { Heat } from './heat.ts'
import { heatPage } from './heat-page.ts'
import { findingLines } from './sensitive.ts'
import type { Entry, HeatMetric, Mode } from '../types'

export type Host = {
  machine: () => Promise<TimeMachine>
  refresh: (tm: TimeMachine) => Promise<Entry[]>
  session: () => Promise<string>
  mode: () => Promise<Mode>
  setMode: (mode: Mode) => Promise<void>
  openPane: () => Promise<boolean>
  home: () => Promise<string>
  exec: Exec
  hasHistory: () => Promise<boolean>
  forget: (root: string) => void
  report: (error: unknown) => string
  writeFile: (path: string, text: string) => Promise<void>
  copy: (text: string) => Promise<boolean>
  retention: () => Promise<number | null>
  setRetention: (days: number | null) => Promise<void>
  /** Opens the Heat pane; false when it could not open here. */
  showHeat: (heat: Heat, from: number | null, metric: HeatMetric) => Promise<boolean>
  /** Opens a local file with the system's default app; false when it could not. */
  openFile: (path: string) => Promise<boolean>
  isKeepingSecrets: () => Promise<boolean>
  setKeepingSecrets: (isKeeping: boolean) => Promise<void>
}

const DAY_MS = 24 * 60 * 60 * 1000
const HEAT_FILES = 15

export const HELP = [
  'Usage: /tm [command]',
  '  (none)                    open the Time machine pane',
  '  log [N] [--session]       list snapshots, newest first',
  '  show N                    files, steps and answer of snapshot N',
  '  undo [N|N.k] [--force]    revert a turn (default: the latest) or one of its steps',
  '  undo [N] --sensitive      revert only what the security diff flags in it',
  '  redo                      undo the latest undo',
  '  travel N|name             put every file back to snapshot N or a saved checkpoint',
  '  save [name]               save the work tree now as a named checkpoint',
  '  on | off | manual         snapshot every turn, never, or only on /tm save',
  '  commit [N] [message] [--force]  commit what turn N changed to your current branch',
  '  branch N name             a new branch in your repo holding snapshot N',
  '  patch [N]                 turn N as a patch file (also copied to the clipboard)',
  '  secrets [keep | skip]     keep .env files and keys in snapshots, or leave them out (the default)',
  '  retain 30d | off          prune snapshots older than that, once a day',
  '  prune 30d | prune 50      forget old snapshots (by age, or keep the newest N)',
  '  heat [30d] [rework|undo|owner]  where Claude worked: a map of the project, hottest files',
  '  heat open [30d]           the same map as an interactive page in your browser',
  '  stats                     snapshots, disk use and mode for this project',
  '  projects [rm N --yes]     every project with a history; delete one',
  '  git                       the git command to browse the timeline yourself',
].join('\n')

export async function runCommand(host: Host, args: string): Promise<string> {
  const words = args
    .trim()
    .split(/\s+/)
    .filter(word => word !== '')
  const [verb = '', ...rest] = words
  const flags = new Set(rest.filter(word => word.startsWith('--')))
  const arg = rest.find(word => !word.startsWith('--'))
  try {
    // These work with no history, and never start one.
    switch (verb) {
      case 'on':
      case 'auto':
        await host.setMode('auto')
        await host.refresh(await host.machine())
        return 'Time machine on: every turn is snapshotted.'
      case 'off':
        await host.setMode('off')
        return 'Time machine off for this project: no snapshots until /tm on. The history stays.'
      case 'manual':
        await host.setMode('manual')
        await host.refresh(await host.machine())
        return 'Time machine manual: snapshots only on /tm save.'
      case 'projects':
        return await projectsCommand(host, await host.machine(), rest, flags)
      case 'secrets':
        return await secretsCommand(host, arg)
      case 'help':
        return HELP
    }
    if ((await host.mode()) === 'off' && !(await host.hasHistory())) {
      return 'The time machine is off here: it starts on its own only in git projects. /tm on starts it for this folder.'
    }
    const tm = await host.machine()
    const list = await host.refresh(tm)
    switch (verb) {
      case '':
      case 'open': {
        const isPlaced = await host.openPane()
        return isPlaced ? 'Time machine opened.' : `${logText(list.slice(0, 10))}\n\n(The pane could not open here.)`
      }
      case 'log': {
        const session = await host.session()
        const shown = flags.has('--session') ? list.filter(one => one.session === session) : list
        return logText(shown.slice(0, Number(arg) || 15))
      }
      case 'show':
      case 'steps':
        return await showText(tm, await resolveRef(tm, list, arg), arg ?? '1')
      case 'undo': {
        const entry = arg ? await resolveRef(tm, list, arg) : list.find(one => one.kind === 'turn')
        if (!entry) return 'No Claude turn to undo yet.'
        const isForced = flags.has('--force')
        if (flags.has('--sensitive')) {
          const done = await tm.undoSensitive(entry.id, isForced)
          if (!done) return `Nothing in ${kindLabel(entry)} "${entry.title}" is flagged as sensitive.`
          return `Undo the sensitive changes of ${kindLabel(entry)} "${entry.title}":\n${restoreText(done, entry.id)}`
        }
        const done = await tm.undo(entry.id, isForced)
        return `Undo ${kindLabel(entry)} "${entry.title}":\n${restoreText(done, entry.id)}`
      }
      case 'redo': {
        const last = list[0]
        if (!last || last.kind !== 'undo' || !last.title.startsWith('Undo: ')) {
          return 'Nothing to redo: the latest snapshot is not an undo.'
        }
        const done = await tm.undo(last.id, flags.has('--force'))
        return `Redo "${last.title.slice(6)}":\n${restoreText(done, last.id)}`
      }
      case 'travel': {
        if (!arg) return 'Name a snapshot: /tm travel 3, or a checkpoint: /tm travel "before refactor".'
        const entry = await resolveRef(tm, list, rest.join(' '))
        return `Travelled to "${entry.title}":\n${restoreText(await tm.travel(entry.id), entry.id)}`
      }
      case 'save': {
        const name = rest.join(' ').replace(/^["']|["']$/g, '')
        const saved = await tm.save(name, await host.session())
        await host.refresh(tm)
        return `Saved checkpoint "${saved?.title ?? name}" (${saved?.id.slice(0, 7) ?? ''}). /tm travel "${saved?.title ?? name}" comes back to it.`
      }
      case 'git':
        return `Inspect the timeline with plain git:\n  ${tm.inspectCommand()}\n  (git show <id>, git diff <a> <b> work with the same --git-dir.)`
      case 'stats': {
        const stats = await tm.stats()
        return `${plural(stats.entries, 'snapshot')}, ${size(stats.bytes)} at ${tm.gitDir}; mode ${await host.mode()}`
      }
      case 'heat':
        return await heatCommand(host, tm, rest)
      case 'prune':
        return await pruneCommand(host, tm, arg)
      case 'retain':
        return await retainCommand(host, tm, arg)
      case 'commit': {
        const words = rest.filter(word => !word.startsWith('--'))
        const hasRef = words[0] !== undefined && isRef(words[0])
        const entry = hasRef ? await resolveRef(tm, list, words[0]) : list.find(one => one.kind === 'turn')
        if (!entry) return 'No Claude turn to commit yet.'
        const message = (hasRef ? words.slice(1) : words).join(' ').replace(/^["']|["']$/g, '')
        const done = await tm.commitTo(entry.id, message || undefined, flags.has('--force'))
        const skipped = done.skipped.length > 0 ? `\nLeft out (ignored by your repo): ${done.skipped.join(', ')}` : ''
        return `Committed ${plural(done.committed.length, 'file')} to ${done.branch} as ${done.commit.slice(0, 7)}.${skipped}`
      }
      case 'branch': {
        const [ref, name] = rest.filter(word => !word.startsWith('--'))
        if (ref === undefined || name === undefined) return 'Usage: /tm branch N name (see /tm log).'
        const done = await tm.branchTo((await resolveRef(tm, list, ref)).id, name)
        const skipped = done.skipped.length > 0 ? `\nLeft out (ignored by your repo): ${done.skipped.join(', ')}` : ''
        return `Created branch ${done.branch} at ${done.commit.slice(0, 7)} (${plural(done.files, 'file')}). HEAD and your files did not change.${skipped}`
      }
      case 'patch': {
        const entry = arg ? await resolveRef(tm, list, arg) : list.find(one => one.kind === 'turn')
        if (!entry) return 'No Claude turn to export yet.'
        const patch = await tm.patch(entry.id)
        if (patch === '') return 'That snapshot changed no files.'
        const path = `${await host.home()}/patches/${entry.id.slice(0, 12)}.patch`
        await host.writeFile(path, patch)
        const copied = (await host.copy(patch)) ? ' and copied to the clipboard' : ''
        return `Wrote ${path}${copied}.\nApply it from the project root with: git apply ${path}`
      }
      default:
        return HELP
    }
  } catch (error) {
    return host.report(error)
  }
}

async function showText(tm: TimeMachine, entry: Entry, number: string): Promise<string> {
  const steps = entry.kind === 'turn' ? await tm.steps(entry.id) : []
  const findings = entry.kind === 'turn' || entry.kind === 'step' ? await tm.findings(entry.id) : []
  return [
    `${kindLabel(entry)} · ${entry.title} (${entry.id.slice(0, 7)})`,
    ...entry.changes.map(change => `  ${statusMark(change)} ${change.path}`),
    ...(steps.length > 0
      ? ['Steps:', ...steps.map((step, i) => `  ${number}.${i + 1} ${stepLabel(step)}  ${countsShort(step)}`)]
      : []),
    ...(findings.length > 0 ? ['Sensitive:', ...findingLines(findings)] : []),
    ...(entry.answer !== '' ? ['Answer:', `  ${clip(oneLine(entry.answer), 400)}`] : []),
  ].join('\n')
}

async function heatCommand(host: Host, tm: TimeMachine, rest: string[]): Promise<string> {
  const days = rest.map(daysOf).find(found => found !== undefined)
  const metric = METRICS.find(one => rest.includes(one)) ?? 'churn'
  const from = days === undefined ? null : Date.now() - days * DAY_MS
  const heat = await tm.heat(from)
  if (heat.files.length === 0) return 'Nothing to map yet: the heat map fills in as Claude changes files.'
  if (rest.includes('open')) {
    const page = await writeHeatPage(host, tm, heat)
    return (await host.openFile(page))
      ? `Opened the heat map in your browser: ${page}`
      : `Wrote the heat map to ${page}; open it in a browser.`
  }
  const where = (await host.showHeat(heat, from, metric))
    ? 'The map is in the Heat pane; /tm heat open shows it in your browser.'
    : '/tm heat open shows the map in your browser.'
  return `${heatText(heat, metric, HEAT_FILES)}\n\n${where}`
}

/** Writes the interactive page for this project; returns its path. */
export async function writeHeatPage(host: Host, tm: TimeMachine, heat: Heat): Promise<string> {
  const name = tm.gitDir.slice(tm.gitDir.lastIndexOf('/') + 1).replace(/\.git$/, '')
  const path = `${await host.home()}/heat/${name}.html`
  const page = heatPage({
    project: tm.root,
    tree: heatTree(heat.files),
    turns: heat.turns,
    since: heat.since,
    made: Date.now(),
  })
  await host.writeFile(path, page)
  return path
}

async function secretsCommand(host: Host, arg: string | undefined): Promise<string> {
  if (arg === 'keep') {
    await host.setKeepingSecrets(true)
    return "Secrets (.env files, keys, .npmrc…) are kept in this project's snapshots from now on, on this machine only, so a change to them can be undone. /tm secrets skip stops."
  }
  if (arg === 'skip') {
    await host.setKeepingSecrets(false)
    return 'Secrets are left out of new snapshots, and undo and travel never write them. Snapshots taken while they were kept still hold copies; /tm projects rm N --yes deletes the whole history.'
  }
  return (await host.isKeepingSecrets())
    ? "Secrets (.env files, keys, .npmrc…) are kept in this project's snapshots. /tm secrets skip leaves them out."
    : "Secrets (.env files, keys, .npmrc…) are left out of this project's snapshots: a change to them is flagged, not undoable. /tm secrets keep keeps them."
}

async function retainCommand(host: Host, tm: TimeMachine, arg: string | undefined): Promise<string> {
  if (arg === 'off') {
    await host.setRetention(null)
    return 'Automatic pruning off: snapshots are kept until /tm prune.'
  }
  const days = daysOf(arg)
  if (days === undefined) {
    const now = await host.retention()
    return `Usage: /tm retain 30d | off. Now: ${now === null ? 'off' : `${now} days`}.`
  }
  await host.setRetention(days)
  const done = await tm.prune({ olderThanMs: days * DAY_MS })
  await host.refresh(tm)
  return `Snapshots older than ${plural(days, 'day')} are pruned once a day. Pruned ${plural(done.removed, 'snapshot')} now.`
}

function daysOf(arg: string | undefined): number | undefined {
  const days = arg === undefined ? null : /^(\d+)d$/.exec(arg)
  return days ? Number(days[1]) : undefined
}

function isRef(word: string): boolean {
  return /^\d{1,3}(\.\d{1,3})?$/.test(word) || /^[0-9a-f]{7,64}$/.test(word)
}

async function pruneCommand(host: Host, tm: TimeMachine, arg: string | undefined): Promise<string> {
  const days = daysOf(arg)
  const options =
    days !== undefined
      ? { olderThanMs: days * DAY_MS }
      : arg !== undefined && /^\d+$/.test(arg)
        ? { keepLast: Number(arg) }
        : undefined
  if (!options) return 'Usage: /tm prune 30d (older than 30 days) or /tm prune 50 (keep the newest 50).'
  const done = await tm.prune(options)
  await host.refresh(tm)
  if (done.removed === 0) return 'Nothing to prune.'
  return `Pruned ${plural(done.removed, 'snapshot')}, kept ${done.kept}. ${size(done.bytesBefore)} → ${size(done.bytesAfter)}.`
}

async function projectsCommand(host: Host, tm: TimeMachine, rest: string[], flags: Set<string>): Promise<string> {
  const base = await host.home()
  const { exec } = host
  const projects = await listProjects(exec, base)
  if (rest[0] === 'rm') {
    const project = projects[Number(rest[1]) - 1]
    if (!project) return 'Name a project by its number in /tm projects.'
    const name = project.root || project.name
    if (!flags.has('--yes')) {
      return `This deletes the whole history of ${name} (${size(project.bytes)}).\nRun /tm projects rm ${rest[1]} --yes to confirm.`
    }
    await deleteProject(exec, base, project.name)
    if (project.gitDir === tm.gitDir) host.forget(tm.root)
    return `Deleted the history of ${name}.`
  }
  if (projects.length === 0) return 'No project has a history yet.'
  const total = projects.reduce((sum, one) => sum + one.bytes, 0)
  return [
    ...projects.map((one, i) => projectLine(one, i, one.gitDir === tm.gitDir)),
    `${plural(projects.length, 'project')}, ${size(total)} in ${base}`,
    'Delete one with /tm projects rm N; trim one with /tm prune inside it.',
  ].join('\n')
}

/** `3` (from /tm log), `3.2` (step 2 of it), a commit id, or a checkpoint name. */
async function resolveRef(tm: TimeMachine, list: Entry[], ref: string | undefined): Promise<Entry> {
  if (ref === undefined) {
    if (list[0]) return list[0]
    throw new Error('No snapshots yet')
  }
  const step = /^(\d{1,3})\.(\d{1,3})$/.exec(ref)
  if (step) {
    const turn = list[Number(step[1]) - 1]
    const found = turn ? (await tm.steps(turn.id))[Number(step[2]) - 1] : undefined
    if (!found) throw new Error(`No step ${ref} (see /tm show ${step[1]})`)
    return found
  }
  const byNumber = /^\d{1,3}$/.test(ref) ? list[Number(ref) - 1] : undefined
  const name = ref.replace(/^["']|["']$/g, '')
  const entry =
    byNumber ?? (/^[0-9a-f]{4,64}$/.test(ref) ? await tm.entry(ref) : undefined) ?? (await tm.findCheckpoint(name))
  if (!entry) throw new Error(`No snapshot or checkpoint "${name}" (see /tm log)`)
  return entry
}
