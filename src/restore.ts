// Putting files back: undoing what one entry changed, or travelling the
// whole work tree to a snapshot. Both record the current state first, so
// every restore is itself on the timeline and can be undone.

import type { Change, Entry } from '../types'
import { chunks } from './git.ts'
import type { History } from './history.ts'
import { undoTitle } from './message.ts'
import type { ShadowRepo } from './shadow.ts'
import type { PathPlan } from './timeline.ts'

export type RestoreReport = {
  restored: string[]
  removed: string[]
  recovered: string[]
  conflicts: string[]
  /** Paths already back at the state being restored: nothing to do. */
  unchanged: string[]
  entry: Entry | undefined
}

/**
 * Reverts what `entry` changed and leaves everything else as it is now. For
 * a turn, that is what Claude's steps changed. A file changed again since is
 * a conflict and stays as it is, unless `isForced`.
 */
export async function undo(
  shadow: ShadowRepo,
  history: History,
  entry: Entry,
  isForced: boolean,
): Promise<RestoreReport> {
  if (!entry.parent) throw new Error('The baseline has nothing before it to go back to')
  const plans = await history.plan(entry)
  const current = await recordCurrent(shadow)
  const changedSince = await changedAgainst(shadow, plans, plan => plan.after, current.tree)
  const differsFromBefore = await changedAgainst(shadow, plans, plan => plan.before, current.tree)
  const pending = plans.filter(plan => differsFromBefore.has(plan.path))
  const isConflict = (plan: PathPlan) => !isForced && (changedSince.has(plan.path) || plan.isTainted)
  const apply = pending.filter(plan => !isConflict(plan))
  await applyPlans(shadow, apply)
  const done =
    apply.length === 0 ? undefined : await recordRestore(shadow, history, 'undo', undoTitle(entry.title), entry.id)
  return {
    restored: apply.filter(plan => !plan.isNew && plan.lastStatus !== 'deleted').map(plan => plan.path),
    removed: apply.filter(plan => plan.isNew).map(plan => plan.path),
    recovered: apply.filter(plan => !plan.isNew && plan.lastStatus === 'deleted').map(plan => plan.path),
    conflicts: pending.filter(isConflict).map(plan => plan.path),
    unchanged: plans.filter(plan => !differsFromBefore.has(plan.path)).map(plan => plan.path),
    entry: done,
  }
}

/** Puts every tracked file back to how it was at `entry`. */
export async function travel(shadow: ShadowRepo, history: History, entry: Entry): Promise<RestoreReport> {
  const current = await recordCurrent(shadow)
  const changes = await shadow.diffTrees(current.tree, entry.id)
  // From now to the target: a path the target lacks is removed.
  await applyPlans(
    shadow,
    changes.map(change => ({
      path: change.path,
      before: entry.id,
      after: current.commit,
      isNew: change.status === 'deleted',
      lastStatus: change.status,
      isTainted: false,
    })),
  )
  const title = `Travel to: ${entry.title}`
  const done = changes.length === 0 ? undefined : await recordRestore(shadow, history, 'travel', title, entry.id)
  const paths = (status: Change['status']) =>
    changes.filter(change => change.status === status).map(change => change.path)
  return {
    restored: paths('modified'),
    removed: paths('deleted'),
    recovered: paths('added'),
    conflicts: [],
    unchanged: [],
    entry: done,
  }
}

async function recordCurrent(shadow: ShadowRepo): Promise<{ commit: string; tree: string }> {
  await shadow.snapshot()
  await shadow.commitIfChanged(null, 'outside', 'Changes outside Claude')
  return shadow.tip()
}

async function recordRestore(
  shadow: ShadowRepo,
  history: History,
  kind: 'undo' | 'travel',
  title: string,
  target: string,
): Promise<Entry | undefined> {
  await shadow.snapshot()
  const id = await shadow.commitIfChanged(null, kind, title, target)
  return id === undefined ? undefined : history.entry(id)
}

async function applyPlans(shadow: ShadowRepo, plans: PathPlan[]): Promise<void> {
  for (const plan of plans) assertSafePath(plan.path)
  // git rm refuses symlinked leading directories and prunes the ones it
  // empties; checkout restores content, mode and symlinks.
  for (const chunk of chunks(plans.filter(plan => plan.isNew).map(plan => plan.path))) {
    await shadow.git(['rm', '-q', '-f', '-r', '--ignore-unmatch', '--', ...chunk])
  }
  for (const [source, paths] of groupBy(
    plans.filter(plan => !plan.isNew),
    plan => plan.before,
  )) {
    for (const chunk of chunks(paths)) await shadow.git(['checkout', source, '--', ...chunk])
  }
}

/** The paths whose state at `tree` differs from the snapshot `pick` names. */
async function changedAgainst(
  shadow: ShadowRepo,
  plans: PathPlan[],
  pick: (plan: PathPlan) => string,
  tree: string,
): Promise<Set<string>> {
  const changed = new Set<string>()
  for (const [commit, paths] of groupBy(plans, pick)) {
    for (const chunk of chunks(paths)) {
      for (const change of await shadow.diffTrees(commit, tree, chunk)) changed.add(change.path)
    }
  }
  return changed
}

function groupBy(plans: PathPlan[], key: (plan: PathPlan) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const plan of plans) groups.set(key(plan), [...(groups.get(key(plan)) ?? []), plan.path])
  return groups
}

function assertSafePath(path: string): void {
  const parts = path.split('/')
  const isSafe =
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    parts[0] !== '.git' &&
    parts.every(part => part !== '..' && part !== '')
  if (!isSafe) throw new Error(`Refusing to restore an unsafe path: ${JSON.stringify(path)}`)
}
