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
   * Paths something else wrote while the restore ran (a formatter or codegen
   * still going): not at the state restored, so not counted as restored.
   */
  unsettled: string[]
  /** For the unsettled paths: the diff from the state restored to what is on disk. */
  drift: string
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
  const skipped = await applyPlans(shadow, apply, current.tree)
  const {
    entry: done,
    unsettled,
    drift,
  } = apply.length === 0
    ? { entry: undefined, unsettled: new Set<string>(), drift: '' }
    : await recordRestore(shadow, history, 'undo', undoTitle(entry.title), entry.id, apply, skipped)
  const settled = apply.filter(plan => !unsettled.has(plan.path))
  return {
    restored: settled.filter(plan => !plan.isNew && plan.lastStatus !== 'deleted').map(plan => plan.path),
    removed: settled.filter(plan => plan.isNew).map(plan => plan.path),
    recovered: settled.filter(plan => !plan.isNew && plan.lastStatus === 'deleted').map(plan => plan.path),
    conflicts: pending.filter(isConflict).map(plan => plan.path),
    unchanged: plans.filter(plan => !differsFromBefore.has(plan.path)).map(plan => plan.path),
    unsettled: apply.filter(plan => unsettled.has(plan.path)).map(plan => plan.path),
    drift,
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
  const skipped = await applyPlans(shadow, plans, current.tree)
  const title = `Travel to: ${entry.title}`
  const {
    entry: done,
    unsettled,
    drift,
  } = changes.length === 0
    ? { entry: undefined, unsettled: new Set<string>(), drift: '' }
    : await recordRestore(shadow, history, 'travel', title, entry.id, plans, skipped)
  const paths = (status: Change['status']) =>
    changes.filter(change => change.status === status && !unsettled.has(change.path)).map(change => change.path)
  return {
    restored: paths('modified'),
    removed: paths('deleted'),
    recovered: paths('added'),
    conflicts: [],
    unchanged: [],
    unsettled: changes.filter(change => unsettled.has(change.path)).map(change => change.path),
    drift,
    entry: done,
  }
}

async function recordCurrent(shadow: ShadowRepo): Promise<{ commit: string; tree: string }> {
  await shadow.snapshot()
  await shadow.commitIfChanged(null, 'outside', 'Changes outside Claude')
  return shadow.tip()
}

/**
 * Records the restore, and checks it against what landed: a path not at its
 * `before` state was skipped, or written by something else after it was put
 * back. Such a restore is recorded as incomplete.
 */
async function recordRestore(
  shadow: ShadowRepo,
  history: History,
  kind: 'undo' | 'travel',
  title: string,
  target: string,
  applied: PathPlan[],
  skipped: ReadonlySet<string>,
): Promise<{ entry: Entry | undefined; unsettled: Set<string>; drift: string }> {
  await shadow.snapshot()
  const tree = await shadow.writeTree()
  const unsettled = await changedAgainst(shadow, applied, plan => plan.before, tree)
  for (const path of skipped) unsettled.add(path)
  let drift = ''
  for (const [source, paths] of groupBy(
    applied.filter(plan => unsettled.has(plan.path)),
    plan => plan.before,
  )) {
    for (const chunk of chunks(paths)) {
      const args = ['diff', '--no-color', '--no-ext-diff', '--no-renames', source, tree, '--', ...chunk]
      drift += await shadow.git(args, { trim: false })
    }
  }
  const recorded = unsettled.size > 0 ? `${title} (incomplete)` : title
  const id = await shadow.commitIfChanged(null, kind, recorded, target)
  return { entry: id === undefined ? undefined : await history.entry(id), unsettled, drift }
}

/**
 * Writes each path back; returns the paths it left alone because something
 * wrote them after `base`, the tree the restore started from, was taken.
 */
async function applyPlans(shadow: ShadowRepo, plans: PathPlan[], base: string): Promise<Set<string>> {
  for (const plan of plans) assertSafePath(plan.path)
  const skipped = new Set<string>()
  // Checked again just before each write, so a write made since the restore
  // began is kept and reported instead of overwritten.
  const unmoved = async (paths: string[]) => {
    const moved = await movedSince(shadow, base, paths)
    for (const path of moved) skipped.add(path)
    return paths.filter(path => !moved.has(path))
  }
  // git rm refuses symlinked leading directories and prunes the ones it
  // empties; checkout restores content, mode and symlinks.
  for (const chunk of chunks(plans.filter(plan => plan.isNew).map(plan => plan.path))) {
    const paths = await unmoved(chunk)
    if (paths.length > 0) await shadow.git(['rm', '-q', '-f', '-r', '--ignore-unmatch', '--', ...paths])
  }
  for (const [source, all] of groupBy(
    plans.filter(plan => !plan.isNew),
    plan => plan.before,
  )) {
    for (const chunk of chunks(all)) {
      const paths = await unmoved(chunk)
      if (paths.length > 0) await shadow.git(['checkout', source, '--', ...paths])
    }
  }
  return skipped
}

/**
 * The paths whose work tree state differs from `tree`. update-index, unlike
 * add, takes paths that are gone from both the index and the disk.
 */
async function movedSince(shadow: ShadowRepo, tree: string, paths: string[]): Promise<Set<string>> {
  await shadow.git(['update-index', '-q', '--add', '--remove', '--', ...paths], { isLenient: true })
  const changes = await shadow.diffTrees(tree, await shadow.writeTree(), paths)
  return new Set(changes.map(change => change.path))
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
