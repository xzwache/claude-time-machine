// The heat map: where in the project the timeline's changes landed. Lines
// Claude's steps changed, how often a file came back in a later turn, what was
// undone, and lines changed by anyone else, summed per file and folder.
//
// Reading it costs two kinds of git call: one log of commit headers, and
// `diff-tree --numstat` over the commits that count, in batches.

import type { EntryKind, HeatMetric, HeatNode, HeatView } from '../types'
import { TIMELINE } from './shadow.ts'
import type { ShadowRepo } from './shadow.ts'

/** Per file: what the timeline did to it. */
export type FileHeat = {
  path: string
  /** Lines added plus deleted by Claude's steps. */
  claude: number
  /** Claude's steps that changed it. */
  edits: number
  /** Distinct Claude turns that changed it. */
  turns: number
  /** Undos that put it back. */
  undos: number
  /** Lines added plus deleted by anything but Claude's tools. */
  human: number
}

export type Heat = {
  files: FileHeat[]
  /** Claude turns seen in the window. */
  turns: number
  /** The oldest commit read, ms. */
  since: number
}

export const METRICS: HeatMetric[] = ['churn', 'rework', 'undo', 'owner']

export const METRIC_LABELS: Record<HeatMetric, string> = {
  churn: 'Claude churn',
  rework: 'rework',
  undo: 'undone',
  owner: 'Claude vs you',
}

/** What a value of each metric counts, after the number. */
export const METRIC_UNITS: Record<HeatMetric, string> = {
  churn: 'lines',
  rework: 'reworked',
  undo: 'undone',
  owner: 'Claude',
}

/** `412 lines`, `3 reworked`, `80% Claude`: a node's value, as the map and list label it. */
export function valueLabel(node: HeatNode, metric: HeatMetric): string {
  const raw = value(node, metric)
  return metric === 'owner' ? `${Math.round(raw * 100)}% Claude` : `${raw} ${METRIC_UNITS[metric]}`
}

/** Header lines fit well within this; the free text after them is cut. */
const HEADER_CHARS = 300
const BATCH = 200
const BINARY_LINES = 1

type Head = { id: string; time: number; kind: EntryKind; session: string | undefined; title: string }

/** What the timeline did to each file since `sinceMs` (all of it when null). */
export async function readHeat(shadow: ShadowRepo, sinceMs: number | null): Promise<Heat> {
  const args = ['log', `--format=%x1e%H%x1f%ct%x1f%s%x1f%<(${HEADER_CHARS},trunc)%b`]
  if (sinceMs !== null) args.push(`--since=@${Math.floor(sinceMs / 1000)}`)
  const heads = parseHeads(await shadow.git([...args, TIMELINE], { trim: false }))

  // Newest first: a step belongs to the nearest later turn marker of its session.
  const turnOf = new Map<string, string>()
  const open = new Map<string, string>()
  for (const head of heads) {
    const session = head.session ?? ''
    if (head.kind === 'turn') open.set(session, head.id)
    else if (head.kind === 'step') turnOf.set(head.id, open.get(session) ?? `open:${session}`)
  }

  const counted = heads.filter(
    head =>
      head.kind === 'step' || head.kind === 'outside' || (head.kind === 'undo' && head.title.startsWith('Undo: ')),
  )
  const byId = new Map(counted.map(head => [head.id, head]))
  const files = new Map<string, FileHeat & { turnIds: Set<string> }>()
  const fileOf = (path: string) => {
    let found = files.get(path)
    if (!found) {
      found = { path, claude: 0, edits: 0, turns: 0, undos: 0, human: 0, turnIds: new Set() }
      files.set(path, found)
    }
    return found
  }

  for (let i = 0; i < counted.length; i += BATCH) {
    const ids = counted.slice(i, i + BATCH).map(head => head.id)
    const out = await shadow.git(['diff-tree', '-r', '-z', '--no-renames', '--numstat', '--stdin'], {
      stdin: `${ids.join('\n')}\n`,
      trim: false,
    })
    for (const [id, stats] of parseNumstat(out)) {
      const head = byId.get(id)
      if (!head) continue
      for (const stat of stats) {
        const file = fileOf(stat.path)
        if (head.kind === 'step') {
          file.claude += stat.lines
          file.edits++
          file.turnIds.add(turnOf.get(id) ?? id)
        } else if (head.kind === 'outside') {
          file.human += stat.lines
        } else {
          file.undos++
        }
      }
    }
  }

  return {
    files: [...files.values()].map(({ turnIds, ...file }) => ({ ...file, turns: turnIds.size })),
    turns: heads.filter(head => head.kind === 'turn').length,
    since: heads.at(-1)?.time ?? Date.now(),
  }
}

function parseHeads(log: string): Head[] {
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
        session: header('session'),
        title,
      }
    })
}

/** `git diff-tree -r -z --numstat --stdin`: per commit, lines changed per path. */
export function parseNumstat(out: string): Map<string, { path: string; lines: number }[]> {
  const result = new Map<string, { path: string; lines: number }[]>()
  let current: { path: string; lines: number }[] | undefined
  for (const part of out.split('\0')) {
    if (/^[0-9a-f]{40,64}$/.test(part)) {
      current = []
      result.set(part, current)
      continue
    }
    const stat = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(part)
    if (!current || !stat) continue
    const [, added = '-', deleted = '-', path = ''] = stat
    const lines = added === '-' ? BINARY_LINES : Number(added) + Number(deleted)
    current.push({ path, lines: Math.max(lines, 1) })
  }
  return result
}

/** The folder tree of the heat, with every folder's sums. */
export function heatTree(files: FileHeat[]): HeatNode {
  const root = emptyNode('', '', true)
  for (const file of files) {
    if (file.claude + file.human + file.undos === 0) continue
    const parts = file.path.split('/')
    let node = root
    add(node, file)
    for (let i = 0; i < parts.length; i++) {
      const isDir = i < parts.length - 1
      const path = parts.slice(0, i + 1).join('/')
      node.children ??= []
      let child = node.children.find(one => one.name === parts[i])
      if (!child) {
        child = emptyNode(parts[i] ?? '', path, isDir)
        node.children.push(child)
      }
      add(child, file)
      node = child
    }
  }
  sortTree(root)
  return root
}

function emptyNode(name: string, path: string, isDir: boolean): HeatNode {
  return { name, path, isDir, claude: 0, human: 0, edits: 0, rework: 0, undos: 0, files: 0 }
}

function add(node: HeatNode, file: FileHeat): void {
  node.claude += file.claude
  node.human += file.human
  node.edits += file.edits
  node.rework += Math.max(0, file.turns - 1)
  node.undos += file.undos
  node.files++
}

function sortTree(node: HeatNode): void {
  if (!node.children) return
  node.children.sort((a, b) => size(b) - size(a) || a.name.localeCompare(b.name))
  for (const child of node.children) sortTree(child)
}

/** The node at `path` ('' is the root), or undefined. */
export function nodeAt(root: HeatNode, path: string): HeatNode | undefined {
  if (path === '') return root
  let node: HeatNode | undefined = root
  for (const part of path.split('/')) node = node?.children?.find(one => one.name === part)
  return node
}

/** A folder of one child is shown as that child: `src/app` instead of `src`. */
export function collapse(node: HeatNode): HeatNode {
  let at = node
  while (at.children?.length === 1 && at.children[0]?.isDir) at = at.children[0]
  return at
}

/** How big a node is drawn: every line changed, by anyone. */
export function size(node: HeatNode): number {
  return node.claude + node.human + node.undos
}

/** How hot a node is under `metric`: a raw value, compared with its siblings'. */
export function value(node: HeatNode, metric: HeatMetric): number {
  switch (metric) {
    case 'churn':
      return node.claude
    case 'rework':
      return node.rework
    case 'undo':
      return node.undos
    case 'owner':
      return node.claude + node.human === 0 ? 0 : node.claude / (node.claude + node.human)
  }
}

/** 0 to 1: log-scaled against the hottest sibling, or the share of Claude for `owner`. */
export function intensity(node: HeatNode, metric: HeatMetric, max: number): number {
  const raw = value(node, metric)
  if (metric === 'owner') return raw
  if (raw <= 0 || max <= 0) return 0
  return Math.log1p(raw) / Math.log1p(max)
}

export function maxValue(nodes: HeatNode[], metric: HeatMetric): number {
  return nodes.reduce((max, node) => Math.max(max, value(node, metric)), 0)
}

/** A heat color, `0xRRGGBB`: dark through red to yellow; for `owner`, blue (you) to orange (Claude). */
export function heatColor(t: number, metric: HeatMetric): number {
  const stops: [number, number, number][] =
    metric === 'owner'
      ? [
          [56, 116, 203],
          [120, 120, 130],
          [230, 126, 34],
        ]
      : [
          [44, 52, 72],
          [120, 40, 60],
          [200, 60, 40],
          [240, 150, 40],
          [250, 225, 90],
        ]
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const [r1, g1, b1] = stops[i] ?? [0, 0, 0]
  const [r2, g2, b2] = stops[i + 1] ?? [0, 0, 0]
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f)
  return (mix(r1, r2) << 16) | (mix(g1, g2) << 8) | mix(b1, b2)
}

export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export type Rect = { x: number; y: number; w: number; h: number }

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): `weights` laid out in
 * `rect`, each rectangle as close to square as the row it joins allows.
 * Weights are sorted largest first by the caller; zero weights get nothing.
 */
export function squarify(weights: number[], rect: Rect): Rect[] {
  const out: Rect[] = weights.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }))
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0)
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out
  const scale = (rect.w * rect.h) / total
  const areas = weights.map(w => Math.max(0, w) * scale)
  let free = { ...rect }
  let start = 0
  while (start < areas.length && (areas[start] ?? 0) > 0) {
    const side = Math.min(free.w, free.h)
    let end = start + 1
    let best = worst(areas.slice(start, end), side)
    while (end < areas.length && (areas[end] ?? 0) > 0) {
      const next = worst(areas.slice(start, end + 1), side)
      if (next > best) break
      best = next
      end++
    }
    const row = areas.slice(start, end)
    const sum = row.reduce((a, b) => a + b, 0)
    if (free.w >= free.h) {
      const w = sum / free.h
      let y = free.y
      for (const [k, area] of row.entries()) {
        const h = area / w
        out[start + k] = { x: free.x, y, w, h }
        y += h
      }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h }
    } else {
      const h = sum / free.w
      let x = free.x
      for (const [k, area] of row.entries()) {
        const w = area / h
        out[start + k] = { x, y: free.y, w, h }
        x += w
      }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h }
    }
    start = end
  }
  return out
}

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0)
  const max = Math.max(...row)
  const min = Math.min(...row)
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
}

const DEFAULT_COLOR = 0x01000000
const LABEL_DARK = 0x111111
const LABEL_LIGHT = 0xf2f2f2

/**
 * The treemap as terminal cells, for a `Raster`: base64 of
 * `[codePoint, foreground, background]` u32 triplets, row-major. A terminal
 * cell is about twice as tall as wide, so the layout runs on half-rows.
 */
export function rasterCells(nodes: HeatNode[], metric: HeatMetric, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) words.set([0x20, DEFAULT_COLOR, DEFAULT_COLOR], i * 3)
  const max = maxValue(nodes, metric)
  const rects = squarify(nodes.map(size), { x: 0, y: 0, w: columns, h: rows * 2 })
  for (const [i, node] of nodes.entries()) {
    const rect = rects[i]
    if (!rect) continue
    const x0 = Math.round(rect.x)
    const x1 = Math.round(rect.x + rect.w)
    const y0 = Math.round(rect.y / 2)
    const y1 = Math.round((rect.y + rect.h) / 2)
    if (x1 - x0 < 1 || y1 - y0 < 1) continue
    const back = heatColor(intensity(node, metric, max), metric)
    const fore = brightness(back) > 140 ? LABEL_DARK : LABEL_LIGHT
    // A one-column gap on the right and, when tall enough, a row below
    // separates neighbours of the same color.
    const right = x1 - x0 > 2 ? x1 - 1 : x1
    const bottom = y1 - y0 > 2 ? y1 - 1 : y1
    for (let y = y0; y < bottom; y++) {
      for (let x = x0; x < right; x++) words.set([0x20, fore, back], (y * columns + x) * 3)
    }
    const label = `${node.name}${node.isDir ? '/' : ''}`
    const room = right - x0 - 1
    if (room >= 2) {
      const text = [...(label.length > room ? `${label.slice(0, room - 1)}…` : label)]
      for (const [k, char] of text.entries()) words[(y0 * columns + x0 + 1 + k) * 3] = printable(char)
    }
  }
  return base64(new Uint8Array(words.buffer))
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

function brightness(color: number): number {
  return ((color >> 16) & 255) * 0.299 + ((color >> 8) & 255) * 0.587 + (color & 255) * 0.114
}

/** One width-1 BMP code point a Raster accepts; anything else becomes `?`. */
function printable(char: string): number {
  const code = char.codePointAt(0) ?? 0x3f
  return code >= 0x20 && code < 0x7f ? code : code === 0x2026 ? code : 0x3f
}

/** The same treemap as an SVG document, for surfaces that draw `Svg`. */
export function svgTreemap(nodes: HeatNode[], metric: HeatMetric, width: number, height: number): string {
  const max = maxValue(nodes, metric)
  const rects = squarify(nodes.map(size), { x: 0, y: 0, w: width, h: height })
  const shapes = nodes.map((node, i) => {
    const r = rects[i]
    if (!r || r.w < 1 || r.h < 1) return ''
    const back = heatColor(intensity(node, metric, max), metric)
    const fore = brightness(back) > 140 ? '#111' : '#f2f2f2'
    const label = r.w > 40 && r.h > 16 ? escapeXml(`${node.name}${node.isDir ? '/' : ''}`) : ''
    return (
      `<g><title>${escapeXml(`${node.path}: ${describe(node)}`)}</title>` +
      `<rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${Math.max(0, r.w - 2).toFixed(1)}" ` +
      `height="${Math.max(0, r.h - 2).toFixed(1)}" rx="3" fill="${hex(back)}"/>` +
      (label
        ? `<text x="${(r.x + 6).toFixed(1)}" y="${(r.y + 15).toFixed(1)}" fill="${fore}" font-size="12" ` +
          `font-family="ui-monospace,monospace">${label}</text>`
        : '') +
      '</g>'
    )
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${shapes.join('')}</svg>`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`)
}

/** `412 lines by Claude in 9 edits · 3 reworked · 1 undo · 20 by you` */
export function describe(node: HeatNode): string {
  const parts = [`${node.claude} lines by Claude in ${node.edits} ${node.edits === 1 ? 'edit' : 'edits'}`]
  if (node.rework > 0) parts.push(`${node.rework} reworked`)
  if (node.undos > 0) parts.push(`${node.undos} ${node.undos === 1 ? 'undo' : 'undos'}`)
  if (node.human > 0) parts.push(`${node.human} by you`)
  return parts.join(' · ')
}

/** The hottest files under `metric`, as `/tm heat` prints them. */
export function topFiles(files: FileHeat[], metric: HeatMetric, limit: number): FileHeat[] {
  // Claude's share alone would rank every one-line file Claude wrote first.
  const score = (file: FileHeat) =>
    metric === 'owner' ? topScore(file, metric) * Math.log1p(file.claude) : topScore(file, metric)
  return files
    .filter(file => score(file) > 0)
    .sort((a, b) => score(b) - score(a) || b.claude - a.claude || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** What the pane draws for the folder at `path`: its children, without theirs. */
export function viewOf(
  tree: HeatNode,
  path: string,
  metric: HeatMetric,
  heat: { turns: number; since: number },
  page: string | null,
): HeatView {
  const found = nodeAt(tree, path) ?? tree
  const at = found.isDir || found === tree ? collapse(found) : found
  const strip = ({ children, ...node }: HeatNode): HeatNode => node
  const nodes = (at.children ?? [at])
    .filter(node => size(node) > 0)
    .slice(0, VIEW_NODES)
    .map(strip)
  return { metric, path: at.path, nodes, total: strip(at), turns: heat.turns, since: heat.since, page, notice: '' }
}

const VIEW_NODES = 60

/** The heat as `/tm heat` prints it. */
export function heatText(heat: Heat, metric: HeatMetric, limit: number): string {
  const top = topFiles(heat.files, metric, limit)
  if (top.length === 0) return `No ${METRIC_LABELS[metric]} on the timeline yet.`
  const width = Math.max(...top.map(file => file.path.length))
  const shown = (file: FileHeat) =>
    metric === 'churn'
      ? `${file.claude} lines, ${file.edits} ${file.edits === 1 ? 'edit' : 'edits'}`
      : metric === 'rework'
        ? `back in ${file.turns - 1} later ${file.turns === 2 ? 'turn' : 'turns'}`
        : metric === 'undo'
          ? `${file.undos} ${file.undos === 1 ? 'undo' : 'undos'}`
          : `${Math.round((file.claude / (file.claude + file.human)) * 100)}% Claude`
  const max = Math.max(...top.map(file => topScore(file, metric)))
  return [
    `Hottest files by ${METRIC_LABELS[metric]} (${heat.turns} Claude turns since ${new Date(heat.since).toISOString().slice(0, 10)}):`,
    ...top.map(
      (file, i) =>
        `${String(i + 1).padStart(2)}. ${bar(topScore(file, metric) / max)} ${file.path.padEnd(width)}  ${shown(file)}`,
    ),
  ].join('\n')
}

function topScore(file: FileHeat, metric: HeatMetric): number {
  return metric === 'churn'
    ? file.claude
    : metric === 'rework'
      ? file.turns - 1
      : metric === 'undo'
        ? file.undos
        : file.claude / Math.max(1, file.claude + file.human)
}

function bar(t: number): string {
  const cells = Math.max(1, Math.round(t * 8))
  return `${'█'.repeat(cells)}${'░'.repeat(8 - cells)}`
}

/** The folder above `path`, past the folders `collapse` would skip back into. */
export function parentOf(tree: HeatNode, path: string): string {
  let at = path
  while (at !== '') {
    at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''
    const node = nodeAt(tree, at)
    if (!node || collapse(node).path !== path) return at
  }
  return ''
}
