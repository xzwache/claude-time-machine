// Laying the heat map out and painting it: a squarified treemap, its colors,
// and the two drawings the pane uses, terminal cells and SVG.
//
// `squarify`, `heatColor`, `hex`, `isLight`, `intensity` and `maxValue` also run in the
// browser page, embedded by their source: each refers to nothing outside
// itself but the others and heat.ts's `value`.

import type { HeatMetric, HeatNode } from '../types'
import { describe, size, value } from './heat.ts'

export type Rect = { x: number; y: number; w: number; h: number }

/**
 * Squarified treemap (Bruls, Huizing and van Wijk): `weights`, biggest first,
 * laid out in `rect`, each rectangle as near square as its row allows. A
 * weight of zero or less gets an empty rectangle.
 */
export function squarify(weights: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = weights.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }))
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0)
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out
  const areas = weights.map(w => (Math.max(0, w) * rect.w * rect.h) / total)
  const worst = (from: number, to: number, side: number) => {
    let sum = 0
    let max = 0
    let min = Infinity
    for (let i = from; i < to; i++) {
      const area = areas[i] ?? 0
      sum += area
      max = Math.max(max, area)
      min = Math.min(min, area)
    }
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
  }
  let free = { ...rect }
  let start = 0
  while (start < areas.length && (areas[start] ?? 0) > 0) {
    const side = Math.min(free.w, free.h)
    let end = start + 1
    while (end < areas.length && (areas[end] ?? 0) > 0 && worst(start, end + 1, side) <= worst(start, end, side)) end++
    let sum = 0
    for (let i = start; i < end; i++) sum += areas[i] ?? 0
    const isColumn = free.w >= free.h
    const thick = sum / (isColumn ? free.h : free.w)
    let offset = isColumn ? free.y : free.x
    for (let i = start; i < end; i++) {
      const long = (areas[i] ?? 0) / thick
      out[i] = isColumn ? { x: free.x, y: offset, w: thick, h: long } : { x: offset, y: free.y, w: long, h: thick }
      offset += long
    }
    free = isColumn
      ? { x: free.x + thick, y: free.y, w: free.w - thick, h: free.h }
      : { x: free.x, y: free.y + thick, w: free.w, h: free.h - thick }
    start = end
  }
  return out
}

/** `0xRRGGBB` for `t` from 0 to 1: dark through red to yellow; for `owner`, blue (others) to orange (Claude). */
export function heatColor(t: number, metric: HeatMetric): number {
  const stops =
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
  const from = stops[i] ?? [0, 0, 0]
  const to = stops[i + 1] ?? from
  const [r, g, b] = from.map((c, k) => Math.round(c + ((to[k] ?? c) - c) * (x - i)))
  return ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0)
}

export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** 0 to 1: log-scaled against the hottest sibling's value; Claude's share for `owner`. */
export function intensity(node: HeatNode, metric: HeatMetric, max: number): number {
  const raw = value(node, metric)
  if (metric === 'owner') return raw
  return raw <= 0 || max <= 0 ? 0 : Math.log1p(raw) / Math.log1p(max)
}

export function maxValue(nodes: readonly HeatNode[], metric: HeatMetric): number {
  let max = 0
  for (const node of nodes) max = Math.max(max, value(node, metric))
  return max
}

export function isLight(color: number): boolean {
  return ((color >> 16) & 255) * 0.299 + ((color >> 8) & 255) * 0.587 + (color & 255) * 0.114 > 140
}

const TERMINAL_DEFAULT = 0x01000000
const INK_DARK = 0x111111
const INK_LIGHT = 0xf2f2f2
const ELLIPSIS = 0x2026

/**
 * The treemap as `Raster` cells: base64 of `[codePoint, foreground,
 * background]` u32 triplets, row-major. A cell is about twice as tall as it
 * is wide, so the layout runs on half rows.
 */
export function rasterCells(nodes: readonly HeatNode[], metric: HeatMetric, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) words.set([0x20, TERMINAL_DEFAULT, TERMINAL_DEFAULT], i * 3)
  const max = maxValue(nodes, metric)
  const rects = squarify(nodes.map(size), { x: 0, y: 0, w: columns, h: rows * 2 })
  for (const [i, node] of nodes.entries()) {
    const rect = rects[i]
    if (!rect) continue
    const x0 = Math.round(rect.x)
    const y0 = Math.round(rect.y / 2)
    let x1 = Math.round(rect.x + rect.w)
    let y1 = Math.round((rect.y + rect.h) / 2)
    if (x1 - x0 < 1 || y1 - y0 < 1) continue
    // A gap on the right and below keeps neighbours of one color apart.
    if (x1 - x0 > 2) x1--
    if (y1 - y0 > 2) y1--
    const back = heatColor(intensity(node, metric, max), metric)
    const ink = isLight(back) ? INK_DARK : INK_LIGHT
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) words.set([0x20, ink, back], (y * columns + x) * 3)
    const label = [...`${node.name}${node.isDir ? '/' : ''}`]
    const room = x1 - x0 - 1
    if (room < 2) continue
    const shown = label.length > room ? [...label.slice(0, room - 1), '…'] : label
    for (const [k, char] of shown.entries()) words[(y0 * columns + x0 + 1 + k) * 3] = cellChar(char)
  }
  return base64(new Uint8Array(words.buffer))
}

/** A code point a `Raster` cell takes: printable ASCII or the ellipsis, else `?`. */
function cellChar(char: string): number {
  const code = char.codePointAt(0) ?? 0x3f
  return (code >= 0x20 && code < 0x7f) || code === ELLIPSIS ? code : 0x3f
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

export function svgTreemap(nodes: readonly HeatNode[], metric: HeatMetric, width: number, height: number): string {
  const max = maxValue(nodes, metric)
  const rects = squarify(nodes.map(size), { x: 0, y: 0, w: width, h: height })
  const shapes = nodes.map((node, i) => {
    const r = rects[i]
    if (!r || r.w < 1 || r.h < 1) return ''
    const back = heatColor(intensity(node, metric, max), metric)
    const name = `${node.name}${node.isDir ? '/' : ''}`
    const label =
      r.w > 40 && r.h > 16
        ? `<text x="${(r.x + 6).toFixed(1)}" y="${(r.y + 15).toFixed(1)}" fill="${isLight(back) ? '#111' : '#f2f2f2'}" ` +
          `font-size="12" font-family="ui-monospace,monospace">${escapeXml(name)}</text>`
        : ''
    return (
      `<g><title>${escapeXml(`${node.path}: ${describe(node)}`)}</title>` +
      `<rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${Math.max(0, r.w - 2).toFixed(1)}" ` +
      `height="${Math.max(0, r.h - 2).toFixed(1)}" rx="3" fill="${hex(back)}"/>${label}</g>`
    )
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${shapes.join('')}</svg>`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`)
}
