// Reading the timeline: commits as git prints them, folded into turns, and
// the plan for putting each path a turn touched back the way it was.

import type { Change, ChangeStatus, Counts, Entry } from '../types'
import { parseMessage } from './message.ts'
import type { Meta } from './message.ts'

/** A commit as read off the timeline, before turns are grouped. */
export type Raw = {
  id: string
  parent: string | null
  time: number
  meta: Meta
  changes: Change[]
}

/** How one path goes back: from which snapshot, and what to check first. */
export type PathPlan = {
  path: string
  before: string
  after: string
  isNew: boolean
  lastStatus: ChangeStatus
  isTainted: boolean
}

/** The `git log --format=` that `parseLog` reads. */
export const LOG_FORMAT = '--format=%x1e%H%x1f%P%x1f%ct%x1f%B'

export function parseLog(log: string, changes: Map<string, Change[]>): Raw[] {
  return log
    .split('\x1e')
    .filter(record => record.trim() !== '')
    .map(record => {
      const [id = '', parents = '', time = '0', body = ''] = record.split('\x1f')
      return {
        id,
        parent: parents.trim().split(' ')[0] || null,
        time: Number(time) * 1000,
        meta: parseMessage(body),
        changes: changes.get(id) ?? [],
      }
    })
}

export function logIds(log: string): string[] {
  return log
    .split('\x1e')
    .filter(record => record.trim() !== '')
    .map(record => record.split('\x1f')[0] ?? '')
}

/** `git diff-tree -r -z --name-status --always --stdin` output, per commit. */
export function parseDiffTreeStdin(out: string): Map<string, Change[]> {
  const result = new Map<string, Change[]>()
  const parts = out.split('\0')
  let current: Change[] | undefined
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (/^[0-9a-f]{40,64}$/.test(part)) {
      current = []
      result.set(part, current)
    } else if (current && /^[ADMT]$/.test(part)) {
      current.push({ status: statusOf(part), path: parts[++i] ?? '' })
    }
  }
  return result
}

/** `git diff-tree -r -z --name-status <a> <b>` output. */
export function parseDiffTree(out: string): Change[] {
  const parts = out.split('\0')
  const changes: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const path = parts[i + 1] ?? ''
    if (path !== '') changes.push({ status: statusOf(parts[i] ?? ''), path })
  }
  return changes
}

/** The turn markers in `raws` whose base is not among them. */
export function missingBases(raws: Raw[]): string[] {
  const ids = new Set(raws.map(raw => raw.id))
  return raws.flatMap(raw =>
    raw.meta.kind === 'turn' && raw.meta.base && !ids.has(raw.meta.base) ? [raw.meta.base] : [],
  )
}

/**
 * Folds each turn's steps into it. Reading newest first, a turn marker claims
 * the commits back to its base: its session's steps, and every commit there
 * not claimed by another session's turn (outside changes, captures).
 */
export function group(raws: Raw[]): { top: Entry[]; byId: Map<string, Entry> } {
  const byId = new Map<string, Entry>()
  const claimed = new Set<string>()
  const indexOf = new Map(raws.map((raw, i) => [raw.id, i]))
  const byRaw = new Map(raws.map(raw => [raw.id, raw]))
  for (const [i, raw] of raws.entries()) {
    const entry = toEntry(raw)
    byId.set(raw.id, entry)
    const baseIndex = raw.meta.base === undefined ? undefined : indexOf.get(raw.meta.base)
    if (raw.meta.kind !== 'turn' || baseIndex === undefined) continue
    const range = raws.slice(i + 1, baseIndex).reverse()
    const mine = range.filter(one => !claimed.has(one.id) && isTurnPart(one, raw.meta.session))
    for (const one of mine) claimed.add(one.id)
    entry.steps = mine.filter(one => one.meta.kind !== 'capture').map(one => one.id)
    entry.changes = netChanges(planTurn(entry, byRaw))
    entry.counts = countsOf(entry.changes)
  }
  const top = raws.filter(raw => !claimed.has(raw.id) && raw.meta.kind !== 'capture').map(raw => byId.get(raw.id))
  return { top: top.filter(isDefined), byId }
}

function isTurnPart(raw: Raw, session: string | undefined): boolean {
  const kind = raw.meta.kind
  return kind === 'outside' || kind === 'capture' || (kind === 'step' && raw.meta.session === session)
}

/**
 * A turn's paths: each goes back to its state before the first step that
 * touched it. A change by anything else after that taints the path, so undo
 * treats it as a conflict instead of discarding that change.
 */
export function planTurn(turn: Entry, byRaw: Map<string, Raw>): PathPlan[] {
  const range: Raw[] = []
  let at = turn.parent
  while (at !== null && at !== turn.base) {
    const raw = byRaw.get(at)
    if (!raw) throw new Error(`The history of turn ${turn.id.slice(0, 7)} is incomplete`)
    range.unshift(raw)
    at = raw.parent
  }
  const plans = new Map<string, PathPlan>()
  for (const raw of range) {
    const isClaude = raw.meta.kind === 'step' && raw.meta.session === turn.session
    for (const change of raw.changes) {
      const plan = plans.get(change.path)
      if (isClaude && !plan) {
        plans.set(change.path, {
          path: change.path,
          before: raw.parent ?? '',
          after: raw.id,
          isNew: change.status === 'added',
          lastStatus: change.status,
          isTainted: false,
        })
      } else if (isClaude && plan) {
        plan.after = raw.id
        plan.lastStatus = change.status
      } else if (plan) {
        plan.isTainted = true
      }
    }
  }
  return [...plans.values()]
}

/** One commit's own changes, as a plan back to its parent. */
export function planCommit(id: string, parent: string, changes: Change[]): PathPlan[] {
  return changes.map(change => ({
    path: change.path,
    before: parent,
    after: id,
    isNew: change.status === 'added',
    lastStatus: change.status,
    isTainted: false,
  }))
}

function netChanges(plans: PathPlan[]): Change[] {
  const changes: Change[] = []
  for (const plan of plans) {
    if (plan.isNew && plan.lastStatus === 'deleted') continue
    const status: ChangeStatus = plan.isNew ? 'added' : plan.lastStatus === 'deleted' ? 'deleted' : 'modified'
    changes.push({ status, path: plan.path })
  }
  return changes
}

function countsOf(changes: Change[]): Counts {
  const counts: Counts = { added: 0, modified: 0, deleted: 0 }
  for (const change of changes) counts[change.status]++
  return counts
}

function toEntry(raw: Raw): Entry {
  return {
    id: raw.id,
    parent: raw.parent,
    time: raw.time,
    kind: raw.meta.kind,
    title: raw.meta.title,
    prompt: raw.meta.prompt ?? '',
    answer: raw.meta.answer ?? '',
    session: raw.meta.session ?? null,
    base: raw.meta.base ?? null,
    target: raw.meta.target ?? null,
    isInterrupted: raw.meta.isInterrupted === true,
    secrets: raw.meta.secrets ?? [],
    changes: raw.changes,
    counts: countsOf(raw.changes),
    steps: [],
  }
}

function statusOf(code: string): ChangeStatus {
  return code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
