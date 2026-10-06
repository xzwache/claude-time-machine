// A snapshot's commit message: subject, `tm-*` header lines, then a blank
// line, the prompt and the answer. The headers come before the free text so a
// prompt cannot forge one.

import type { EntryKind } from '../types'

export type Meta = {
  kind: EntryKind
  title: string
  prompt?: string
  answer?: string
  session?: string
  base?: string | undefined
  target?: string | undefined
  isInterrupted?: boolean
  /** Secrets Claude's file tools wrote during a turn, left out of its snapshots. */
  secrets?: string[]
}

const ANSWER_MARK = '--- tm-answer ---'

export function message(meta: Meta): string {
  const lines = [meta.title.replace(/\s+/g, ' ').slice(0, 200), '', `tm-kind: ${meta.kind}`]
  if (meta.session) lines.push(`tm-session: ${meta.session.replace(/\s+/g, '')}`)
  if (meta.base) lines.push(`tm-base: ${meta.base}`)
  if (meta.target) lines.push(`tm-target: ${meta.target}`)
  if (meta.isInterrupted) lines.push('tm-interrupted: true')
  for (const path of meta.secrets ?? []) if (!/[\r\n]/.test(path)) lines.push(`tm-secret: ${path}`)
  if (meta.prompt || meta.answer) lines.push('', meta.prompt ?? '')
  if (meta.answer) lines.push(ANSWER_MARK, meta.answer)
  return `${lines.join('\n')}\n`
}

export function parseMessage(body: string): Meta {
  const lines = body.replace(/^\n+/, '').split('\n')
  const meta: Meta = { kind: 'outside', title: lines[0] ?? '' }
  let i = 2
  for (; i < lines.length; i++) {
    const header = /^tm-([a-z]+): (.*)$/.exec(lines[i] ?? '')
    if (!header) break
    const [, key, value = ''] = header
    if (key === 'kind') meta.kind = value as EntryKind
    else if (key === 'session') meta.session = value
    else if (key === 'base') meta.base = value
    else if (key === 'target') meta.target = value
    else if (key === 'interrupted') meta.isInterrupted = value === 'true'
    else if (key === 'secret') meta.secrets = [...(meta.secrets ?? []), value]
  }
  const text = lines
    .slice(i + 1)
    .join('\n')
    .replace(/\n+$/, '')
  const mark = text.lastIndexOf(`\n${ANSWER_MARK}\n`)
  const prompt = mark < 0 ? text : text.slice(0, mark)
  if (prompt) meta.prompt = prompt
  if (mark >= 0) meta.answer = text.slice(mark + ANSWER_MARK.length + 2)
  return meta
}

/** An undo of an undo is a redo, and an undo of a redo is an undo again. */
export function undoTitle(entryTitle: string): string {
  const title = entryTitle.replace(/ \(incomplete\)$/, '')
  if (title.startsWith('Undo: ')) return `Redo: ${title.slice(6)}`
  if (title.startsWith('Redo: ')) return `Undo: ${title.slice(6)}`
  return `Undo: ${title}`
}

const TITLE_CHARS = 80

/** The first non-empty line, cut at a word with `…` when longer than a title takes. */
export function firstLine(text: string): string {
  const line = (text.split('\n').find(one => one.trim() !== '') ?? '').trim()
  if (line.length <= TITLE_CHARS) return line
  const cut = line.slice(0, TITLE_CHARS - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}
