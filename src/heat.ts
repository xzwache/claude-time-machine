// The heat map's numbers: what the timeline did to each file, summed into the
// project's folder tree. Lines Claude's steps changed, later turns that came
// back to a file, undos, and lines changed by anything else.

import type { EntryKind, HeatMetric, HeatNode, HeatView } from '../types'
import type { ShadowRepo } from './shadow.ts'
import { TIMELINE } from './shadow.ts'

export type FileHeat = {
  path: string
  claude: number
  edits: number
  /** Distinct Claude turns that changed it, the one still running included. */
  turns: number
  undos: number
  /** Lines changed by anything but Claude's tools: you, an editor, a pull or a checkout. */
  others: number
  /** The closed turns that changed it, newest first. */
  turnIds: string[]
}

export type Heat = {
  files: FileHeat[]
  turns: number
  /** The oldest commit read, ms. */
  since: number
}

export const METRICS: readonly HeatMetric[] = ['churn', 'rework', 'undo', 'owner']

export const METRIC_LABELS: Readonly<Record<HeatMetric, string>> = {
  churn: 'Claude churn',
  rework: 'rework',
  undo: 'undone',
  owner: 'Claude vs others',
}

export const METRIC_UNITS: Readonly<Record<HeatMetric, string>> = {
  churn: 'lines',
  rework: 'reworked',
  undo: 'undone',
  owner: 'Claude',
}

// The tm-* headers come first in the body and fit well within this.
const HEADER_CHARS = 300
const LOG_PAGE = 2000
const DIFF_BATCH = 200
const VIEW_NODES = 60
const FILE_TURNS = 8
const RUNNING = 'running:'

type Head = { id: string; time: number; kind: EntryKind; session: string; title: string }

type Stat = { path: string; lines: number }

type Tally = FileHeat & { turnSet: Set<string> }

/** What the timeline did to each file since `sinceMs`, or over all of it. */
export async function readHeat(shadow: ShadowRepo, sinceMs: number | null): Promise<Heat> {
  const heads = await readHeads(shadow, sinceMs)

  // Newest first: a step belongs to the nearest later turn marker of its session.
  const turnOf = new Map<string, string>()
  const openTurn = new Map<string, string>()
  for (const head of heads) {
    if (head.kind === 'turn') openTurn.set(head.session, head.id)
    else if (head.kind === 'step') turnOf.set(head.id, openTurn.get(head.session) ?? `${RUNNING}${head.session}`)
  }

  const counted = heads.filter(isCounted)
  const kinds = new Map(counted.map(head => [head.id, head.kind]))
  const files = new Map<string, Tally>()
  for (let i = 0; i < counted.length; i += DIFF_BATCH) {
    const ids = counted.slice(i, i + DIFF_BATCH).map(head => head.id)
    for (const [id, changed] of await readStats(shadow, ids)) {
      const kind = kinds.get(id)
      for (const { path, lines } of changed) {
        let file = files.get(path)
        if (!file) {
          file = { path, claude: 0, edits: 0, turns: 0, undos: 0, others: 0, turnIds: [], turnSet: new Set() }
          files.set(path, file)
        }
        if (kind === 'step') countStep(file, lines, turnOf.get(id) ?? id)
        else if (kind === 'outside') file.others += lines
        else file.undos++
      }
    }
  }

  return {
    files: [...files.values()].map(({ turnSet, ...file }) => ({ ...file, turns: turnSet.size })),
    turns: heads.filter(head => head.kind === 'turn').length,
    since: heads.at(-1)?.time ?? Date.now(),
  }
}

function countStep(file: Tally, lines: number, turn: string): void {
  file.claude += lines
  file.edits++
  if (file.turnSet.has(turn)) return
  file.turnSet.add(turn)
  if (!turn.startsWith(RUNNING)) file.turnIds.push(turn)
}

function isCounted(head: Head): boolean {
  return head.kind === 'step' || head.kind === 'outside' || (head.kind === 'undo' && head.title.startsWith('Undo: '))
}

async function readHeads(shadow: ShadowRepo, sinceMs: number | null): Promise<Head[]> {
  const args = ['log', `--format=%x1e%H%x1f%ct%x1f%s%x1f%<(${HEADER_CHARS},trunc)%b`, `--max-count=${LOG_PAGE}`]
  if (sinceMs !== null) args.push(`--since=@${Math.floor(sinceMs / 1000)}`)
  const heads: Head[] = []
  for (let skip = 0; ; skip += LOG_PAGE) {
    const page = parseHeads(await shadow.git([...args, `--skip=${skip}`, TIMELINE], { trim: false }))
    heads.push(...page)
    if (page.length < LOG_PAGE) return heads
  }
}

/**
 * Lines changed per path, per commit. A batch whose output is too large to
 * read whole is split; a single commit that still is (a checkout of
 * thousands of files) is left out.
 */
async function readStats(shadow: ShadowRepo, ids: string[]): Promise<Map<string, Stat[]>> {
  const out = await shadow.gitComplete(['diff-tree', '-r', '-z', '--no-renames', '--numstat', '--stdin'], {
    stdin: `${ids.join('\n')}\n`,
  })
  if (out !== undefined) return parseNumstat(out)
  if (ids.length === 1) return new Map()
  const half = Math.ceil(ids.length / 2)
  const first = await readStats(shadow, ids.slice(0, half))
  const second = await readStats(shadow, ids.slice(half))
  return new Map([...first, ...second])
}

export function parseHeads(log: string): Head[] {
  return log
    .split('\x1e')
    .filter(record => record.trim() !== '')
    .map(record => {
      const [id = '', time = '0', title = '', body = ''] = record.split('\x1f')
      const header = (key: string) => new RegExp(`^tm-${key}: (.*)$`, 'm').exec(body)?.[1]?.trim()
      return {
        id: id.trim(),
        time: Number(time) * 1000,
        kind: (header('kind') ?? 'outside') as EntryKind,
        session: header('session') ?? '',
        title,
      }
    })
}

/** `git diff-tree -r -z --numstat --stdin` output; a binary file counts as one line. */
export function parseNumstat(out: string): Map<string, Stat[]> {
  const result = new Map<string, Stat[]>()
  let current: Stat[] | undefined
  for (const part of out.split('\0')) {
    if (/^[0-9a-f]{40,64}$/.test(part)) {
      current = []
      result.set(part, current)
      continue
    }
    const stat = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(part)
    if (!current || !stat) continue
    const [, added = '-', deleted = '-', path = ''] = stat
    current.push({ path, lines: added === '-' ? 1 : Math.max(1, Number(added) + Number(deleted)) })
  }
  return result
}

type Building = { node: HeatNode; children: Map<string, Building> }

/** The folder tree, every folder holding the sums of what is under it; biggest first. */
export function heatTree(files: readonly FileHeat[]): HeatNode {
  const root: Building = { node: emptyNode('', '', true), children: new Map() }
  for (const file of files) {
    if (file.claude + file.others + file.undos === 0) continue
    const parts = file.path.split('/')
    let at = root
    addFile(at.node, file)
    for (const [i, name] of parts.entries()) {
      let child = at.children.get(name)
      if (!child) {
        const path = parts.slice(0, i + 1).join('/')
        child = { node: emptyNode(name, path, i < parts.length - 1), children: new Map() }
        at.children.set(name, child)
      }
      addFile(child.node, file)
      at = child
    }
  }
  return finish(root)
}

function finish({ node, children }: Building): HeatNode {
  if (children.size === 0) return node
  const sorted = [...children.values()].map(finish).sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name))
  return { ...node, children: sorted }
}

function emptyNode(name: string, path: string, isDir: boolean): HeatNode {
  return { name, path, isDir, claude: 0, others: 0, edits: 0, rework: 0, undos: 0, files: 0 }
}

function addFile(node: HeatNode, file: FileHeat): void {
  node.claude += file.claude
  node.others += file.others
  node.edits += file.edits
  node.rework += Math.max(0, file.turns - 1)
  node.undos += file.undos
  node.files++
}

export function nodeAt(root: HeatNode, path: string): HeatNode | undefined {
  if (path === '') return root
  let node: HeatNode | undefined = root
  for (const part of path.split('/')) node = node?.children?.find(child => child.name === part)
  return node
}

/** A folder whose only child is a folder is shown as that child: `src/app`, not `src`. */
export function collapse(node: HeatNode): HeatNode {
  let at = node
  while (at.children?.length === 1 && at.children[0]?.isDir) at = at.children[0]
  return at
}

/** The folder above `path`, past those `collapse` would lead back to it; null at the top. */
export function parentOf(tree: HeatNode, path: string): string | null {
  if (collapse(tree).path === path) return null
  let at = path
  while (at !== '') {
    at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''
    const node = nodeAt(tree, at)
    if (!node || collapse(node).path !== path) return at
  }
  return ''
}

/** What the pane shows for the folder at `path`: its children, without theirs. */
export function viewOf(
  tree: HeatNode,
  heat: Heat,
  at: { path: string; metric: HeatMetric; from: number | null },
): HeatView {
  const shown = collapse(nodeAt(tree, at.path) ?? tree)
  const strip = ({ children, ...node }: HeatNode): HeatNode => node
  return {
    metric: at.metric,
    path: shown.path,
    parent: parentOf(tree, shown.path),
    from: at.from,
    nodes: (shown.children ?? [shown])
      .filter(node => size(node) > 0)
      .slice(0, VIEW_NODES)
      .map(strip),
    total: strip(shown),
    turns: heat.turns,
    since: heat.since,
    file: null,
    page: null,
    notice: '',
  }
}

/** The closed turns that changed `path`, newest first. */
export function turnsOf(heat: Heat, path: string): string[] {
  return heat.files.find(file => file.path === path)?.turnIds.slice(0, FILE_TURNS) ?? []
}

/** How big a node is drawn: every line changed, by anyone. */
export function size(node: HeatNode): number {
  return node.claude + node.others + node.undos
}

export function value(node: HeatNode, metric: HeatMetric): number {
  switch (metric) {
    case 'churn':
      return node.claude
    case 'rework':
      return node.rework
    case 'undo':
      return node.undos
    case 'owner':
      return node.claude + node.others === 0 ? 0 : node.claude / (node.claude + node.others)
  }
}

/** `412 lines`, `3 reworked`, `80% Claude`. */
export function valueLabel(node: HeatNode, metric: HeatMetric, units: Readonly<Record<HeatMetric, string>>): string {
  const raw = value(node, metric)
  return metric === 'owner' ? `${Math.round(raw * 100)}% ${units.owner}` : `${raw} ${units[metric]}`
}

/** `412 lines by Claude in 9 edits · 3 reworked · 1 undo · 20 by others · 4 files` */
export function describe(node: HeatNode): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [`${count(node.claude, 'line', 'lines')} by Claude in ${count(node.edits, 'edit', 'edits')}`]
  if (node.rework > 0) parts.push(`${node.rework} reworked`)
  if (node.undos > 0) parts.push(count(node.undos, 'undo', 'undos'))
  if (node.others > 0) parts.push(`${node.others} by others`)
  if (node.isDir) parts.push(count(node.files, 'file', 'files'))
  return parts.join(' · ')
}

function fileScore(file: FileHeat, metric: HeatMetric): number {
  switch (metric) {
    case 'churn':
      return file.claude
    case 'rework':
      return file.turns - 1
    case 'undo':
      return file.undos
    case 'owner':
      return file.claude / Math.max(1, file.claude + file.others)
  }
}

/** The hottest files under `metric`; ties go to the file with more of Claude's lines. */
export function topFiles(files: readonly FileHeat[], metric: HeatMetric, limit: number): FileHeat[] {
  return files
    .filter(file => fileScore(file, metric) > 0)
    .sort((a, b) => fileScore(b, metric) - fileScore(a, metric) || b.claude - a.claude || a.path.localeCompare(b.path))
    .slice(0, limit)
}

export function heatText(heat: Heat, metric: HeatMetric, limit: number): string {
  const top = topFiles(heat.files, metric, limit)
  const first = top[0]
  if (first === undefined) return `No ${METRIC_LABELS[metric]} on the timeline yet.`
  const max = fileScore(first, metric)
  const width = Math.max(...top.map(file => file.path.length))
  const since = new Date(heat.since).toISOString().slice(0, 10)
  const rows = top.map(
    (file, i) =>
      `${String(i + 1).padStart(2)}. ${bar(fileScore(file, metric) / max)} ${file.path.padEnd(width)}  ${fileLine(file, metric)}`,
  )
  return [`Hottest files by ${METRIC_LABELS[metric]} (${heat.turns} Claude turns since ${since}):`, ...rows].join('\n')
}

function fileLine(file: FileHeat, metric: HeatMetric): string {
  switch (metric) {
    case 'churn':
      return `${file.claude} lines, ${file.edits} ${file.edits === 1 ? 'edit' : 'edits'}`
    case 'rework':
      return `back in ${file.turns - 1} later ${file.turns === 2 ? 'turn' : 'turns'}`
    case 'undo':
      return `${file.undos} ${file.undos === 1 ? 'undo' : 'undos'}`
    case 'owner':
      return `${Math.round(fileScore(file, metric) * 100)}% Claude`
  }
}

function bar(share: number): string {
  const cells = Math.max(1, Math.round(share * 8))
  return `${'█'.repeat(cells)}${'░'.repeat(8 - cells)}`
}
