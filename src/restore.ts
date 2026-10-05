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
  /**
   * Paths written again while the restore ran (a formatter or codegen still
   * going): not at the state restored, so not counted as restored.
   */
  unsettled: string[]
  entry: Entry | undefined
}

/**
 * Reverts what `entry` changed and leaves everything else as it is now. For
 * a turn, that is what Claude's steps changed; `only` narrows it to those
 * paths. A file changed again since is a conflict and stays as it is, unless
 * `isForced`. A secret snapshots leave out is never written, even from an
 * older snapshot that still holds it.
 */
export async function undo(
  shadow: ShadowRepo,
  history: History,
  entry: Entry,
  isForced: boolean,
  only?: ReadonlySet<string>,
): Promise<RestoreReport> {
  if (!entry.parent) throw new Error('The baseline has nothing before it to go back to')
  const all = (await history.plan(entry)).filter(plan => !shadow.isUnkeptSecret(plan.path))
  const plans = only === undefined ? all : all.filter(plan => only.has(plan.path))
  const current = await recordCurrent(shadow)
  const changedSince = await changedAgainst(shadow, plans, plan => plan.after, current.tree)
  const differsFromBefore = await changedAgainst(shadow, plans, plan => plan.before, current.tree)
  const pending = plans.filter(plan => differsFromBefore.has(plan.path))
  const isConflict = (plan: PathPlan) => !isForced && (changedSince.has(plan.path) || plan.isTainted)
  const apply = pending.filter(plan => !isConflict(plan))
  await applyPlans(shadow, apply)
  const { entry: done, unsettled } =
    apply.length === 0
      ? { entry: undefined, unsettled: new Set<string>() }
      : await recordRestore(shadow, history, 'undo', undoTitle(entry.title), entry.id, apply)
  const settled = apply.filter(plan => !unsettled.has(plan.path))
  return {
    restored: settled.filter(plan => !plan.isNew && plan.lastStatus !== 'deleted').map(plan => plan.path),
    removed: settled.filter(plan => plan.isNew).map(plan => plan.path),
    recovered: settled.filter(plan => !plan.isNew && plan.lastStatus === 'deleted').map(plan => plan.path),
    conflicts: pending.filter(isConflict).map(plan => plan.path),
    unchanged: plans.filter(plan => !differsFromBefore.has(plan.path)).map(plan => plan.path),
    unsettled: apply.filter(plan => unsettled.has(plan.path)).map(plan => plan.path),
    entry: done,
  }
}

/** Puts every tracked file back to how it was at `entry`; never a secret snapshots leave out. */
export async function travel(shadow: ShadowRepo, history: History, entry: Entry): Promise<RestoreReport> {
  const current = await recordCurrent(shadow)
  const changes = (await shadow.diffTrees(current.tree, entry.id)).filter(change => !shadow.isUnkeptSecret(change.path))
  // From now to the target: a path the target lacks is removed.
  const plans = changes.map(change => ({
    path: change.path,
    before: entry.id,
    after: current.commit,
    isNew: change.status === 'deleted',
    lastStatus: change.status,
    isTainted: false,
  }))
  await applyPlans(shadow, plans)
  const title = `Travel to: ${entry.title}`
  const { entry: done, unsettled } =
    changes.length === 0
      ? { entry: undefined, unsettled: new Set<string>() }
      : await recordRestore(shadow, history, 'travel', title, entry.id, plans)
  const paths = (status: Change['status']) =>
    changes.filter(change => change.status === status && !unsettled.has(change.path)).map(change => change.path)
  return {
    restored: paths('modified'),
    removed: paths('deleted'),
    recovered: paths('added'),
    conflicts: [],
    unchanged: [],
    unsettled: changes.filter(change => unsettled.has(change.path)).map(change => change.path),
    entry: done,
  }
}

async function recordCurrent(shadow: ShadowRepo): Promise<{ commit: string; tree: string }> {
  await shadow.snapshot()
  await shadow.commitIfChanged(null, 'outside', 'Changes outside Claude')
  return shadow.tip()
}

/**
 * Records the restore, and checks what it wrote against what landed: a path
 * not at its `before` state was written again by something still running.
 */
async function recordRestore(
  shadow: ShadowRepo,
  history: History,
  kind: 'undo' | 'travel',
  title: string,
  target: string,
  applied: PathPlan[],
): Promise<{ entry: Entry | undefined; unsettled: Set<string> }> {
  await shadow.snapshot()
  const unsettled = await changedAgainst(shadow, applied, plan => plan.before, await shadow.writeTree())
  const id = await shadow.commitIfChanged(null, kind, title, target)
  return { entry: id === undefined ? undefined : await history.entry(id), unsettled }
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
