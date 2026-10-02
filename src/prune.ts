// Forgetting old snapshots: the timeline is rewritten from a new baseline,
// then git drops what nothing reaches any more.

import { diskUsage } from './git.ts'
import type { History } from './history.ts'
import { message } from './message.ts'
import type { Meta } from './message.ts'
import type { ShadowRepo } from './shadow.ts'
import { TIMELINE } from './shadow.ts'

export type PruneOptions = { olderThanMs?: number; keepLast?: number }

export type PruneReport = { removed: number; kept: number; bytesBefore: number; bytesAfter: number }

/**
 * Forgets entries older than `olderThanMs` or beyond the newest `keepLast`,
 * whichever keeps less. The state every kept entry started from becomes the
 * new baseline, so each can still be undone.
 */
export async function prune(shadow: ShadowRepo, history: History, options: PruneOptions): Promise<PruneReport> {
  const bytesBefore = await diskUsage(shadow.exec, shadow.gitDir)
  const { top, raws } = await history.all()
  const cutoff = options.olderThanMs === undefined ? -Infinity : Date.now() - options.olderThanMs
  let keep = top.filter(entry => entry.time >= cutoff && entry.kind !== 'baseline')
  if (options.keepLast !== undefined) keep = keep.slice(0, options.keepLast)

  // The oldest state any kept entry starts from: a turn of another session
  // can start before an entry that ended after it.
  const indexOf = new Map(raws.map((raw, i) => [raw.id, i]))
  const starts = keep.map(entry => indexOf.get(entry.base ?? entry.parent ?? '') ?? raws.length - 1)
  const rootIndex = starts.length > 0 ? Math.max(...starts) : 0
  const root = raws[rootIndex]
  const removed = raws.length - rootIndex - 1
  if (root === undefined || removed === 0) return { removed: 0, kept: raws.length, bytesBefore, bytesAfter: bytesBefore }

  const tip = await shadow.tip()
  const rewritten = new Map<string, string>()
  const date = new Date(root.time).toISOString().slice(0, 10)
  const baseline = message({ kind: 'baseline', title: `Baseline (history before ${date} pruned)` })
  rewritten.set(root.id, await shadow.git(['commit-tree', `${root.id}^{tree}`], { stdin: baseline }))
  for (const raw of raws.slice(0, rootIndex).reverse()) {
    const parent = raw.parent === null ? undefined : rewritten.get(raw.parent)
    const meta: Meta = {
      ...raw.meta,
      base: raw.meta.base && rewritten.get(raw.meta.base),
      target: raw.meta.target && rewritten.get(raw.meta.target),
    }
    const args = ['commit-tree', `${raw.id}^{tree}`, ...(parent ? ['-p', parent] : [])]
    rewritten.set(raw.id, await shadow.git(args, { stdin: message(meta), env: commitTime(raw.time) }))
  }
  await shadow.git(['update-ref', TIMELINE, rewritten.get(tip.commit) ?? '', tip.commit])
  await shadow.collect()
  return { removed, kept: rootIndex + 1, bytesBefore, bytesAfter: await diskUsage(shadow.exec, shadow.gitDir) }
}

function commitTime(time: number): Record<string, string> {
  const stamp = `${Math.floor(time / 1000)} +0000`
  return { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
}
