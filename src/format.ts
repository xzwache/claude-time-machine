// The words and lines the time machine shows: the same in the pane, the band
// and /tm output.

import type { Change, Entry, Project } from '../types'
import type { RestoreReport } from './index.ts'

const DIFF_LIMIT = 9000
const DAY_MS = 24 * 60 * 60 * 1000

export function entryLine(entry: Entry): string {
  const date = new Date(entry.time)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const counts = entry.kind === 'baseline' || entry.kind === 'checkpoint' ? '' : `  ${countsShort(entry)}`
  return `${time} ${kindLabel(entry).padEnd(7)} ${entry.title}${counts}`
}

export function logText(list: Entry[]): string {
  if (list.length === 0) return 'No snapshots yet.'
  return list.map((one, i) => `${String(i + 1).padStart(2)}. ${entryLine(one)}  ${one.id.slice(0, 7)}`).join('\n')
}

export function stepLabel(step: Entry): string {
  return step.kind === 'step' ? step.title : `(not Claude) ${step.title}`
}

export function kindLabel(entry: Entry): string {
  switch (entry.kind) {
    case 'baseline':
      return 'start'
    case 'outside':
      return 'you'
    case 'turn':
      return entry.isInterrupted ? 'claude!' : 'claude'
    case 'checkpoint':
      return 'saved'
    case 'undo':
      return entry.title.startsWith('Redo: ') ? 'redo' : 'undo'
    default:
      return entry.kind
  }
}

export function countsShort(entry: Entry): string {
  const { added, modified, deleted } = entry.counts
  return [added && `+${added}`, modified && `~${modified}`, deleted && `-${deleted}`].filter(Boolean).join(' ')
}

/** `Claude edited 3 files, created 12 and deleted 4`: what a turn did, as the band says it. */
export function turnSummary(entry: Entry): string {
  const { added, modified, deleted } = entry.counts
  const done = (
    [
      ['edited', modified],
      ['created', added],
      ['deleted', deleted],
    ] as const
  ).filter(([, count]) => count > 0)
  if (done.length === 0) return 'Claude changed only files the time machine leaves out'
  const [verb, count] = done[0] ?? ['changed', 0]
  const parts = [`${verb} ${plural(count, 'file')}`, ...done.slice(1).map(([word, n]) => `${word} ${n}`)]
  const last = parts.pop()
  return `Claude ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}`
}

export function statusMark(change: Change): string {
  return change.status === 'added' ? 'A' : change.status === 'deleted' ? 'D' : 'M'
}

export function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`
}

export function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function projectLine(project: Project, i: number, isCurrent: boolean): string {
  const days = Math.max(0, Math.round((Date.now() - project.lastTime) / DAY_MS))
  const age = project.lastTime === 0 ? 'never' : `${days}d ago`
  const gone = project.isRootPresent ? '' : '  (folder gone)'
  const name = project.root || project.name
  return `${String(i + 1).padStart(2)}. ${isCurrent ? '▸' : ' '} ${name}  ${plural(project.entries, 'snapshot')}, ${size(project.bytes)}, last ${age}${gone}`
}

export function restoreText(done: RestoreReport, id: string): string {
  const lines: string[] = []
  if (done.restored.length) lines.push(`✓ Restored ${plural(done.restored.length, 'modified file')}`)
  if (done.removed.length) lines.push(`✓ Removed ${plural(done.removed.length, 'file')}`)
  if (done.recovered.length) lines.push(`✓ Brought back ${plural(done.recovered.length, 'file')}`)
  if (done.unchanged.length) lines.push(`· ${plural(done.unchanged.length, 'file')} already back as they were`)
  if (done.conflicts.length) {
    lines.push(`⚠ Left alone, changed by someone else since: ${done.conflicts.join(', ')}`)
    lines.push(`  /tm undo ${id.slice(0, 7)} --force overwrites them (still undoable).`)
  }
  return lines.join('\n') || 'Nothing to change: the files are already there.'
}

export function summaryLine(done: RestoreReport, id: string): string {
  return restoreText(done, id).split('\n').join('  ')
}

/**
 * The unified diff from its first hunk, whole hunks only, within the limit:
 * undefined when there is no hunk, '' when not even the first one fits.
 */
export function hunksOf(diff: string): string | undefined {
  const start = diff.search(/^@@ /m)
  if (start < 0) return undefined
  const hunks = diff
    .slice(start)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?')
    .split(/(?=^@@ )/m)
  let out = ''
  for (const hunk of hunks) {
    if (out.length + hunk.length > DIFF_LIMIT) break
    out += hunk
  }
  return out.replace(/\n$/, '')
}

export function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ')
}
