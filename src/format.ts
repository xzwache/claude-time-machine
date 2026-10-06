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
  const done = actions([
    ['edited', modified],
    ['created', added],
    ['deleted', deleted],
  ])
  return done === undefined ? 'Claude changed only files the time machine leaves out' : `Claude ${done}`
}

/** `edited 3 files, created 12 and deleted 4`: the counts above zero, the first naming files; undefined when none is. */
function actions(counts: readonly (readonly [verb: string, count: number])[]): string | undefined {
  const [first, ...rest] = counts.filter(([, count]) => count > 0)
  if (first === undefined) return undefined
  const parts = [`${first[0]} ${plural(first[1], 'file')}`, ...rest.map(([verb, count]) => `${verb} ${count}`)]
  const last = parts.pop()
  return parts.length > 0 ? `${parts.join(', ')} and ${last}` : last
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
  const age = project.lastTime === 0 ? 'never' : ago(Date.now() - project.lastTime)
  const gone = project.isRootPresent ? '' : '  (folder gone)'
  const name = project.root || project.name
  return `${String(i + 1).padStart(2)}. ${isCurrent ? '▸' : ' '} ${name}  ${plural(project.entries, 'snapshot')}, ${size(project.bytes)}, last change ${age}${gone}`
}

/** `just now`, `42s ago`, `5m ago`, `3h ago`, `12d ago`. */
export function ago(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(elapsedMs / DAY_MS)}d ago`
}

export function restoreText(done: RestoreReport, id: string, hasDrift = true): string {
  const lines: string[] = []
  const did = actions([
    ['restored', done.restored.length],
    ['removed', done.removed.length],
    ['brought back', done.recovered.length],
  ])
  if (done.unsettled.length) {
    const changed = `${plural(done.unsettled.length, 'file')} changed by something else while restoring`
    lines.push(`⚠ Incomplete: ${changed}, not at the snapshot: ${done.unsettled.join(', ')}`)
    if (did !== undefined) lines.push(`· The other files: ${did}`)
  } else if (did !== undefined) {
    lines.push(`✓ ${did.charAt(0).toUpperCase()}${did.slice(1)}`)
  }
  if (done.unchanged.length) {
    lines.push(
      `· ${plural(done.unchanged.length, 'file')} ${done.unchanged.length === 1 ? 'was' : 'were'} already back`,
    )
  }
  if (done.conflicts.length) {
    lines.push(`⚠ Left alone, changed by someone else since: ${done.conflicts.join(', ')}`)
    lines.push(`  /tm undo ${id.slice(0, 7)} --force overwrites them (still undoable).`)
  }
  if (done.unsettled.length) {
    if (hasDrift && done.drift !== '') lines.push(clipDiff(done.drift).replace(/\n$/, ''))
    lines.push('  Something may still be writing them. Stop it, then run this again (an undo needs --force).')
  }
  return lines.join('\n') || 'Nothing to change: the files are already there.'
}

/** A diff cut at a line within the limit, saying so when cut. */
function clipDiff(diff: string): string {
  if (diff.length <= DIFF_LIMIT) return diff
  const cut = diff.slice(0, DIFF_LIMIT)
  return `${cut.slice(0, cut.lastIndexOf('\n') + 1)}… (diff cut; /tm show has the files)\n`
}

export function summaryLine(done: RestoreReport, id: string): string {
  return restoreText(done, id, false).split('\n').join('  ')
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
