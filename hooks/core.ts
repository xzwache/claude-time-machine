// The time machine itself: snapshots, history and restores, kept in a shadow
// Git repository outside the project. Nothing here reaches the model, and
// nothing here touches the project's own .git: the shadow repository has its
// own object store, its own index and its own refs under refs/tm/.
//
// The timeline is one linear chain of commits on refs/tm/timeline. A turn is
// a run of commits: a `step` per tool call of Claude's that changed files,
// `outside` for changes made between them by anything else, and a `turn`
// marker at the end naming the commit the turn started from (`tm-base`).
//
// This module runs both inside Claude Code (through `$.process.run`) and under
// Node for the tests, so it depends only on the two functions it is given.

import type { Change, Entry, EntryKind } from '../types'
import { ATTRIBUTES, GIT_FLAGS, GitError, chunks, diskUsage } from './git.ts'
import type { Deps, ExecInit, ExecResult } from './git.ts'
import { firstLine, message, undoTitle } from './message.ts'
import type { Meta } from './message.ts'
import {
  LOG_FORMAT,
  group,
  isDefined,
  logIds,
  missingBases,
  parseDiffTree,
  parseDiffTreeStdin,
  parseLog,
  planCommit,
  planTurn,
} from './timeline.ts'
import type { PathPlan, Raw } from './timeline.ts'

export type { Deps, Exec, ExecInit, ExecResult } from './git.ts'
export { deleteProject, listProjects } from './projects.ts'

export type RestoreReport = {
  restored: string[]
  removed: string[]
  recovered: string[]
  conflicts: string[]
  /** Paths already back at the state being restored: nothing to do. */
  unchanged: string[]
  entry: Entry | undefined
}

export type PruneReport = { removed: number; kept: number; bytesBefore: number; bytesAfter: number }

type PendingTurn = { turnId: string; prompt: string; startedAt: number; base: string; session: string }

type Timeline = { top: Entry[]; raws: Raw[]; byId: Map<string, Entry>; byRaw: Map<string, Raw> }

type GitOptions = {
  stdin?: string
  timeoutMs?: number
  trim?: boolean
  isLenient?: boolean
  env?: Record<string, string>
}

const TIMELINE = 'refs/tm/timeline'
const PENDING = 'refs/tm/pending/'
const SNAPSHOT_TIMEOUT_MS = 120_000
const STALE_PENDING_MS = 12 * 60 * 60 * 1000
const ANSWER_LIMIT = 4000
const IGNORED_FILE_LIMIT = '-1025k'
const TMIGNORE = '.tmignore'

// Ignored files a snapshot leaves out even when small: build and editor debris.
const IGNORED_JUNK = /(^|\/)\.DS_Store$|\.(pyc|pyo|class|o|obj|so|dylib|dll|log|tmp|swp|swo)$/

export class TimeMachine {
  readonly root: string
  readonly gitDir: string
  private deps: Deps
  private readonly window: number
  private chain: Promise<unknown> = Promise.resolve()
  private isReady = false
  private cache: { tip: string; timeline: Timeline } | undefined
  private excludes: string | undefined

  /** `window`: how many commits a history read starts with (tests shrink it). */
  constructor(deps: Deps, root: string, gitDir: string, window = 800) {
    this.deps = deps
    this.root = root.replace(/\/+$/, '')
    this.gitDir = gitDir.replace(/\/+$/, '')
    this.window = window
  }

  /** Swaps the functions it runs with, as each hook brings its own. */
  use(deps: Deps): this {
    this.deps = deps
    return this
  }

  /** The command a person runs to look at the timeline with plain git. */
  inspectCommand(): string {
    return `git --git-dir='${this.gitDir}' --work-tree='${this.root}' log --stat ${TIMELINE}`
  }

  /** Creates the shadow repository and its baseline snapshot when missing. */
  init(): Promise<void> {
    return this.serial(() => this.ensureReady())
  }

  /**
   * Called as a turn starts. Records whatever changed since the last snapshot
   * as outside work, then remembers the turn as pending for this session. A
   * turn this session left pending (a crash) is closed first, interrupted.
   */
  beginTurn(turnId: string, prompt: string, session: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureReady()
      const stale = await this.readPending(session)
      if (stale) await this.closeTurn(stale, true, '')
      await this.dropStalePending()
      const base = await this.recordOutside(session, 'Changes outside Claude')
      const pending: PendingTurn = { turnId, prompt, startedAt: Date.now(), base: base.commit, session }
      const blob = await this.git(['hash-object', '-w', '--stdin'], { stdin: JSON.stringify(pending) })
      await this.git(['update-ref', pendingRef(session), blob])
    })
  }

  /** Called as a turn ends: closes it with a marker, if it changed anything. */
  finishTurn(turnId: string, session: string, isInterrupted: boolean, answer = ''): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ensureReady()
      const pending = await this.readPending(session)
      if (!pending || pending.turnId !== turnId) return undefined
      return this.closeTurn(pending, isInterrupted, answer)
    })
  }

  /**
   * Called before a file tool writes `path`: records an edit someone else made
   * to it since the last snapshot, and captures an ignored file's content so
   * the turn's edit to it can be undone.
   */
  beforeFileWrite(path: string, session: string): Promise<void> {
    return this.serial(async () => {
      const rel = await this.turnPath(path, session)
      if (rel === undefined) return
      if (await this.isIgnoredAndUntracked(rel)) {
        if (!(await this.existsInWorkTree(rel))) return
        await this.git(['add', '-f', '--', rel])
        await this.commitIfChanged(session, 'capture', `Captured ignored ${rel}`)
        return
      }
      await this.git(['add', '-A', '--', rel], { isLenient: true })
      await this.commitIfChanged(session, 'outside', `Changed outside Claude's tools: ${rel}`)
    })
  }

  /** Called after a file tool wrote `path`: records the write as a step. */
  afterFileWrite(path: string, tool: string, session: string): Promise<void> {
    return this.serial(async () => {
      const rel = await this.turnPath(path, session)
      if (rel === undefined) return
      const isIgnored = await this.isIgnoredAndUntracked(rel)
      if (isIgnored && (await this.existsInWorkTree(rel))) await this.git(['add', '-f', '--', rel])
      else if (!isIgnored) await this.git(['add', '-A', '--', rel], { isLenient: true })
      await this.commitIfChanged(session, 'step', `${tool} ${rel}`)
    })
  }

  /** Called before a shell command: records outside changes up to now. */
  beforeCommand(session: string): Promise<void> {
    return this.serial(async () => {
      if (!this.isReady || !(await this.readPending(session))) return
      await this.recordOutside(session, "Changes outside Claude's tools")
    })
  }

  /** Called after a shell command: records what it changed as a step. */
  afterCommand(command: string, session: string): Promise<void> {
    return this.serial(async () => {
      if (!this.isReady || !(await this.readPending(session))) return
      await this.snapshot()
      await this.commitIfChanged(session, 'step', `Bash: ${firstLine(command) || '(command)'}`)
    })
  }

  /** Saves the work tree now under `name`, changed or not: a bookmark. */
  save(name: string, session: string | null): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ensureReady()
      const tree = await this.snapshot()
      const tip = await this.tip()
      const meta: Meta = { kind: 'checkpoint', title: name.trim() || 'Checkpoint' }
      if (session !== null) meta.session = session
      return this.readEntry(await this.commit(tree, tip.commit, meta))
    })
  }

  /** The newest checkpoint saved under `name` (any case), if there is one. */
  findCheckpoint(name: string): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ensureReady()
      const out = await this.git(['log', '--format=%H%x1f%s', '--grep=^tm-kind: checkpoint$', TIMELINE])
      const wanted = name.trim().toLowerCase()
      const found = out.split('\n').find(line => (line.split('\x1f')[1] ?? '').toLowerCase() === wanted)
      return found === undefined ? undefined : this.readEntry(found.split('\x1f')[0] ?? '')
    })
  }

  /** The timeline, newest first: turns with their steps folded in. */
  history(limit = 50): Promise<Entry[]> {
    return this.serial(async () => {
      await this.ensureReady()
      return (await this.readTimeline()).top.slice(0, limit)
    })
  }

  /** The steps and outside changes of a turn, oldest first. */
  steps(id: string): Promise<Entry[]> {
    return this.serial(async () => {
      await this.ensureReady()
      const turn = await this.readEntry(id)
      if (!turn || turn.steps.length === 0) return []
      const { byId } = await this.readTimeline(turn.id)
      return turn.steps.map(step => byId.get(step)).filter(isDefined)
    })
  }

  /** One entry by id, short id, or `~n` back along the timeline. */
  entry(ref: string): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ensureReady()
      return this.readEntry(ref)
    })
  }

  /** What an entry changed: a turn's steps together, else its own commit. */
  changes(id: string): Promise<Change[]> {
    return this.serial(async () => (await this.readEntry(id))?.changes ?? [])
  }

  /** The unified diff of one file in an entry. */
  fileDiff(id: string, path: string): Promise<string> {
    return this.serial(async () => {
      const plan = (await this.planFor(id)).find(one => one.path === path)
      if (!plan) return ''
      const args = ['diff', '--no-color', '--no-ext-diff', '--no-renames', plan.before, plan.after, '--', path]
      return this.git(args, { trim: false })
    })
  }

  /**
   * Reverts what one entry changed, leaving everything else as it is now. For
   * a turn, that is what Claude's steps changed; edits made by anything else
   * during the turn stay. A file changed again since is a conflict and is left
   * alone unless `isForced`. The current state is recorded first, so the undo
   * is itself on the timeline and can be undone.
   */
  undo(ref: string, isForced = false): Promise<RestoreReport> {
    return this.serial(async () => {
      await this.ensureReady()
      const entry = await this.readEntry(ref)
      if (!entry) throw new Error(`No snapshot named ${ref}`)
      if (!entry.parent) throw new Error('The baseline has nothing before it to go back to')
      const plans = await this.planFor(entry.id)
      const current = await this.recordOutside(null, 'Changes outside Claude')
      const changedSince = await this.changedAgainst(plans, plan => plan.after, current.tree)
      const differsFromBefore = await this.changedAgainst(plans, plan => plan.before, current.tree)
      const pending = plans.filter(plan => differsFromBefore.has(plan.path))
      const isConflict = (plan: PathPlan) => !isForced && (changedSince.has(plan.path) || plan.isTainted)
      const apply = pending.filter(plan => !isConflict(plan))
      await this.applyPlans(apply)
      const done = apply.length === 0 ? undefined : await this.recordRestore('undo', undoTitle(entry.title), entry.id)
      return {
        restored: apply.filter(plan => !plan.isNew && plan.lastStatus !== 'deleted').map(plan => plan.path),
        removed: apply.filter(plan => plan.isNew).map(plan => plan.path),
        recovered: apply.filter(plan => !plan.isNew && plan.lastStatus === 'deleted').map(plan => plan.path),
        conflicts: pending.filter(isConflict).map(plan => plan.path),
        unchanged: plans.filter(plan => !differsFromBefore.has(plan.path)).map(plan => plan.path),
        entry: done,
      }
    })
  }

  /**
   * Puts every tracked file back to how it was at one snapshot. The current
   * state is recorded first, so travelling is itself undoable.
   */
  travel(ref: string): Promise<RestoreReport> {
    return this.serial(async () => {
      await this.ensureReady()
      const entry = await this.readEntry(ref)
      if (!entry) throw new Error(`No snapshot named ${ref}`)
      const current = await this.recordOutside(null, 'Changes outside Claude')
      const changes = await this.diffTrees(current.tree, entry.id)
      // Going from now to the target: a path the target lacks is removed.
      await this.applyPlans(
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
      const done = changes.length === 0 ? undefined : await this.recordRestore('travel', title, entry.id)
      const paths = (status: Change['status']) => changes.filter(change => change.status === status).map(change => change.path)
      return {
        restored: paths('modified'),
        removed: paths('deleted'),
        recovered: paths('added'),
        conflicts: [],
        unchanged: [],
        entry: done,
      }
    })
  }

  /** How many snapshots there are and how much disk they take. */
  stats(): Promise<{ entries: number; bytes: number }> {
    return this.serial(async () => {
      await this.ensureReady()
      const entries = Number(await this.git(['rev-list', '--count', TIMELINE])) || 0
      return { entries, bytes: await diskUsage(this.deps.exec, this.gitDir) }
    })
  }

  /** Packs loose objects when there are enough of them; quick otherwise. */
  maintain(): Promise<void> {
    return this.serial(async () => {
      if (!this.isReady) return
      await this.git(['-c', 'gc.auto=1000', '-c', 'gc.autoPackLimit=20', 'gc', '--auto', '--quiet'], {
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
        isLenient: true,
      })
    })
  }

  /**
   * Forgets snapshots older than `olderThanMs` or beyond the newest `keepLast`
   * top-level entries, whichever keeps less. The state every kept entry
   * started from stays, as the new baseline, so each can still be undone.
   */
  prune(options: { olderThanMs?: number; keepLast?: number }): Promise<PruneReport> {
    return this.serial(async () => {
      await this.ensureReady()
      if ((await this.pendingRefs()).length > 0) throw new Error('A turn is running; prune when it ends')
      const bytesBefore = await diskUsage(this.deps.exec, this.gitDir)
      const { top, raws } = await this.readAll()
      const cutoff = options.olderThanMs === undefined ? -Infinity : Date.now() - options.olderThanMs
      let keep = top.filter(entry => entry.time >= cutoff && entry.kind !== 'baseline')
      if (options.keepLast !== undefined) keep = keep.slice(0, options.keepLast)
      const indexOf = new Map(raws.map((raw, i) => [raw.id, i]))
      // The new baseline: the oldest state any kept entry starts from. A turn
      // of another session can start before an entry that ended after it.
      const starts = keep.map(entry => indexOf.get(entry.base ?? entry.parent ?? '') ?? raws.length - 1)
      const rootIndex = starts.length > 0 ? Math.max(...starts) : 0
      const rootId = raws[rootIndex]?.id
      const removed = raws.length - rootIndex - 1
      if (rootId === undefined || removed === 0) {
        return { removed: 0, kept: raws.length, bytesBefore, bytesAfter: bytesBefore }
      }
      const tip = await this.tip()
      const map = new Map<string, string>()
      const date = new Date(raws[rootIndex]?.time ?? 0).toISOString().slice(0, 10)
      const baseline = message({ kind: 'baseline', title: `Baseline (history before ${date} pruned)` })
      map.set(rootId, await this.git(['commit-tree', `${rootId}^{tree}`], { stdin: baseline }))
      for (const raw of raws.slice(0, rootIndex).reverse()) {
        const parent = raw.parent === null ? undefined : map.get(raw.parent)
        const meta: Meta = { ...raw.meta, base: raw.meta.base && map.get(raw.meta.base), target: raw.meta.target && map.get(raw.meta.target) }
        const args = ['commit-tree', `${raw.id}^{tree}`, ...(parent ? ['-p', parent] : [])]
        map.set(raw.id, await this.git(args, { stdin: message(meta), env: commitTime(raw.time) }))
      }
      await this.git(['update-ref', TIMELINE, map.get(tip.commit) ?? '', tip.commit])
      await this.git(['gc', '--prune=now', '--quiet'], { timeoutMs: SNAPSHOT_TIMEOUT_MS, isLenient: true })
      return { removed, kept: rootIndex + 1, bytesBefore, bytesAfter: await diskUsage(this.deps.exec, this.gitDir) }
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async ensureReady(): Promise<void> {
    if (this.isReady) return
    const home = this.gitDir.slice(0, this.gitDir.lastIndexOf('/'))
    await this.run(['mkdir', '-p', home], {})
    await this.run(['chmod', '700', home], {})
    await this.run(['git', 'init', '-q', '--bare', this.gitDir], {})
    await this.deps.writeFile(`${this.gitDir}/info/attributes`, ATTRIBUTES)
    await this.git(['config', 'tm.root', this.root])
    await this.git(['config', 'core.untrackedCache', 'true'])
    await this.git(['config', 'index.version', '4'])
    const has = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', TIMELINE], { env: this.env() })
    if (has.exitCode !== 0) {
      const tree = await this.snapshot()
      const id = await this.git(['commit-tree', tree], { stdin: message({ kind: 'baseline', title: 'Baseline' }) })
      await this.git(['update-ref', TIMELINE, id])
    }
    this.isReady = true
  }

  /** The path a file tool names, relative to the root, while a turn runs. */
  private async turnPath(path: string, session: string): Promise<string | undefined> {
    if (!this.isReady || !(await this.readPending(session))) return undefined
    return this.relative(path)
  }

  private async closeTurn(pending: PendingTurn, isInterrupted: boolean, answer: string): Promise<Entry | undefined> {
    await this.recordOutside(pending.session, "Changes not made by Claude's tools")
    const range = await this.readRaws([`${pending.base}..${TIMELINE}`])
    const hasSteps = range.some(raw => raw.meta.kind === 'step' && raw.meta.session === pending.session)
    let recorded: Entry | undefined
    if (hasSteps) {
      const tip = await this.tip()
      const id = await this.commit(tip.tree, tip.commit, {
        kind: 'turn',
        title: firstLine(pending.prompt) || '(turn without a prompt)',
        prompt: pending.prompt,
        answer: answer.slice(0, ANSWER_LIMIT),
        session: pending.session,
        base: pending.base,
        isInterrupted,
      })
      recorded = await this.readEntry(id)
    }
    await this.git(['update-ref', '-d', pendingRef(pending.session)])
    return recorded
  }

  /** Snapshots the work tree and records any change since the tip. */
  private async recordOutside(session: string | null, title: string): Promise<{ commit: string; tree: string }> {
    await this.snapshot()
    await this.commitIfChanged(session, 'outside', title)
    return this.tip()
  }

  private async recordRestore(kind: 'undo' | 'travel', title: string, target: string): Promise<Entry | undefined> {
    await this.snapshot()
    const id = await this.commitIfChanged(null, kind, title, target)
    return id === undefined ? undefined : this.readEntry(id)
  }

  /** Commits the index on the timeline when it differs from the tip. */
  private async commitIfChanged(
    session: string | null,
    kind: EntryKind,
    title: string,
    target?: string,
  ): Promise<string | undefined> {
    const tree = await this.git(['write-tree'])
    const tip = await this.tip()
    if (tree === tip.tree) return undefined
    const meta: Meta = { kind, title }
    if (session !== null) meta.session = session
    if (target !== undefined) meta.target = target
    return this.commit(tree, tip.commit, meta)
  }

  private async applyPlans(plans: PathPlan[]): Promise<void> {
    for (const plan of plans) assertSafePath(plan.path)
    // git rm checks for symlinked leading directories and prunes the
    // directories it empties; checkout restores content, mode and symlinks.
    for (const chunk of chunks(plans.filter(plan => plan.isNew).map(plan => plan.path))) {
      await this.git(['rm', '-q', '-f', '-r', '--ignore-unmatch', '--', ...chunk])
    }
    const bySource = new Map<string, string[]>()
    for (const plan of plans.filter(one => !one.isNew)) {
      bySource.set(plan.before, [...(bySource.get(plan.before) ?? []), plan.path])
    }
    for (const [source, paths] of bySource) {
      for (const chunk of chunks(paths)) await this.git(['checkout', source, '--', ...chunk])
    }
  }

  /** The paths whose state at `tree` differs from the snapshot each plan names. */
  private async changedAgainst(plans: PathPlan[], pick: (plan: PathPlan) => string, tree: string): Promise<Set<string>> {
    const groups = new Map<string, string[]>()
    for (const plan of plans) groups.set(pick(plan), [...(groups.get(pick(plan)) ?? []), plan.path])
    const changed = new Set<string>()
    for (const [commit, paths] of groups) {
      for (const chunk of chunks(paths)) {
        for (const change of await this.diffTrees(commit, tree, chunk)) changed.add(change.path)
      }
    }
    return changed
  }

  /** For each path an entry changed: where it goes back to, and from what. */
  private async planFor(id: string): Promise<PathPlan[]> {
    const entry = await this.readEntry(id)
    if (!entry?.parent) return []
    if (entry.kind === 'turn' && entry.base !== null) {
      const { byRaw } = await this.readTimeline(entry.id)
      return planTurn(entry, byRaw)
    }
    return planCommit(entry.id, entry.parent, entry.changes)
  }

  private async snapshot(): Promise<string> {
    await this.syncExcludes()
    await this.git(['add', '-A', '--ignore-errors'], { timeoutMs: SNAPSHOT_TIMEOUT_MS, isLenient: true })
    await this.addSmallIgnoredFiles()
    await this.dropExcluded()
    return this.git(['write-tree'])
  }

  /**
   * Ignored files outside ignored directories (`.env`, local config) are small
   * and easy to lose, so a snapshot keeps them; ignored directories
   * (`node_modules/`, `dist/`) and anything over 1 MiB stay out.
   */
  private async addSmallIgnoredFiles(): Promise<void> {
    const listed = await this.git(
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'],
      { trim: false, isLenient: true, env: { GIT_LITERAL_PATHSPECS: '0' } },
    )
    const files = listed.split('\0').filter(path => path !== '' && !path.endsWith('/') && !IGNORED_JUNK.test(path))
    for (const chunk of chunks(files)) {
      const small = await this.run(
        ['find', ...chunk.map(path => `./${path}`), '-prune', '-type', 'f', '-size', IGNORED_FILE_LIMIT, '-print0'],
        { cwd: this.root },
      )
      const keep = small.stdout.split('\0').filter(Boolean).map(path => path.slice(2))
      if (keep.length > 0) await this.git(['add', '-f', '--', ...keep], { isLenient: true })
    }
  }

  /**
   * `.tmignore` at the project root, in .gitignore syntax, names paths the
   * time machine never snapshots. It becomes the shadow repository's
   * info/exclude, so `git add -A` does not even walk them.
   */
  private async syncExcludes(): Promise<void> {
    const read = await this.run(['cat', '--', `${this.root}/${TMIGNORE}`], {})
    const text = read.exitCode === 0 ? read.stdout : ''
    if (text === this.excludes) return
    await this.deps.writeFile(`${this.gitDir}/info/exclude`, text)
    this.excludes = text
  }

  /** Drops from the index what `.tmignore` names, force-added files included. */
  private async dropExcluded(): Promise<void> {
    if (!this.excludes) return
    const listed = await this.git(['ls-files', '-z', '--cached', '--ignored', `--exclude-from=${this.gitDir}/info/exclude`], {
      trim: false,
      isLenient: true,
      env: { GIT_LITERAL_PATHSPECS: '0' },
    })
    const paths = listed.split('\0').filter(Boolean)
    for (const chunk of chunks(paths)) await this.git(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...chunk])
  }

  private async tip(): Promise<{ commit: string; tree: string }> {
    const [commit = '', tree = ''] = (await this.git(['rev-parse', TIMELINE, `${TIMELINE}^{tree}`])).split('\n')
    return { commit, tree }
  }

  /** Commits on the timeline; retries when another session moved it first. */
  private async commit(tree: string, parent: string, meta: Meta): Promise<string> {
    let onto = parent
    for (let attempt = 0; ; attempt++) {
      const id = await this.git(['commit-tree', tree, '-p', onto], { stdin: message(meta) })
      const moved = await this.run(['git', ...GIT_FLAGS, 'update-ref', TIMELINE, id, onto], { cwd: this.root, env: this.env() })
      if (moved.exitCode === 0) return id
      if (attempt >= 5) throw new GitError(['update-ref', TIMELINE], moved)
      onto = (await this.tip()).commit
    }
  }

  private async readPending(session: string): Promise<PendingTurn | undefined> {
    const ref = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', pendingRef(session)], { env: this.env() })
    return ref.exitCode === 0 ? this.readPendingBlob(ref.stdout.trim()) : undefined
  }

  private async readPendingBlob(blob: string): Promise<PendingTurn | undefined> {
    try {
      return JSON.parse(await this.git(['cat-file', 'blob', blob])) as PendingTurn
    } catch {
      return undefined
    }
  }

  private async pendingRefs(): Promise<{ ref: string; blob: string }[]> {
    const out = await this.git(['for-each-ref', '--format=%(refname) %(objectname)', PENDING])
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [ref = '', blob = ''] = line.split(' ')
        return { ref, blob }
      })
  }

  /** Forgets turns other sessions left open long ago (a crashed session). */
  private async dropStalePending(): Promise<void> {
    for (const { ref, blob } of await this.pendingRefs()) {
      const pending = await this.readPendingBlob(blob)
      if (!pending || Date.now() - pending.startedAt > STALE_PENDING_MS) await this.git(['update-ref', '-d', ref])
    }
  }

  private async readEntry(ref: string): Promise<Entry | undefined> {
    const spelled = /^~\d+$/.test(ref) ? `${TIMELINE}${ref}` : ref
    const found = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', `${spelled}^{commit}`], {
      env: this.env(),
    })
    if (found.exitCode !== 0) return undefined
    return (await this.readTimeline(found.stdout.trim())).byId.get(found.stdout.trim())
  }

  /**
   * The newest commits on the timeline, grouped into turns. Reads `window`
   * commits, and reads further back while `including` is not among them or a
   * turn's base is missing, so every turn read is whole.
   */
  private async readTimeline(including?: string): Promise<Timeline> {
    const tip = await this.git(['rev-parse', TIMELINE])
    let timeline = this.cache?.tip === tip ? this.cache.timeline : undefined
    for (let window = this.window; ; window *= 4) {
      const isWhole = timeline !== undefined && (including === undefined || timeline.byRaw.has(including))
      if (isWhole && timeline !== undefined && missingBases(timeline.raws).length === 0) break
      timeline = this.toTimeline(await this.readRaws([TIMELINE, '-n', String(window)]))
      if (timeline.raws.length < window) break
    }
    this.cache = { tip, timeline }
    return timeline
  }

  private async readAll(): Promise<Timeline> {
    return this.toTimeline(await this.readRaws([TIMELINE]))
  }

  private toTimeline(raws: Raw[]): Timeline {
    const { top, byId } = group(raws)
    return { top, raws, byId, byRaw: new Map(raws.map(raw => [raw.id, raw])) }
  }

  /** Commits and their changes, in two git calls. */
  private async readRaws(range: string[]): Promise<Raw[]> {
    const log = await this.git(['log', LOG_FORMAT, ...range], { trim: false })
    const ids = logIds(log)
    if (ids.length === 0) return []
    const args = ['diff-tree', '-r', '-z', '--no-renames', '--name-status', '--always', '--stdin']
    const changes = parseDiffTreeStdin(await this.git(args, { stdin: `${ids.join('\n')}\n`, trim: false }))
    return parseLog(log, changes)
  }

  private async diffTrees(from: string, to: string, paths: string[] = []): Promise<Change[]> {
    const args = ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]
    return parseDiffTree(await this.git(paths.length > 0 ? [...args, '--', ...paths] : args, { trim: false }))
  }

  private async isIgnoredAndUntracked(rel: string): Promise<boolean> {
    // Without --no-index, a path already in the shadow index is never reported.
    // check-ignore refuses literal pathspecs, and takes the path verbatim anyway.
    const result = await this.run(['git', ...GIT_FLAGS, 'check-ignore', '-q', '--', rel], {
      cwd: this.root,
      env: { ...this.env(), GIT_LITERAL_PATHSPECS: '0' },
    })
    return result.exitCode === 0
  }

  private async existsInWorkTree(rel: string): Promise<boolean> {
    return (await this.run(['test', '-e', rel, '-o', '-L', rel], { cwd: this.root })).exitCode === 0
  }

  /** The path relative to the project root, or undefined when outside it. */
  private relative(path: string): string | undefined {
    const absolute = path.startsWith('/') ? path : `${this.root}/${path}`
    const parts: string[] = []
    for (const part of absolute.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    const normal = `/${parts.join('/')}`
    if (!normal.startsWith(`${this.root}/`)) return undefined
    const rel = normal.slice(this.root.length + 1)
    return rel === '' || rel === '.git' || rel.startsWith('.git/') ? undefined : rel
  }

  private env(): Record<string, string> {
    return {
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_INDEX_FILE: `${this.gitDir}/index`,
      GIT_LITERAL_PATHSPECS: '1',
      GIT_AUTHOR_NAME: 'Claude Time Machine',
      GIT_AUTHOR_EMAIL: 'time-machine@localhost',
      GIT_COMMITTER_NAME: 'Claude Time Machine',
      GIT_COMMITTER_EMAIL: 'time-machine@localhost',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    }
  }

  private async git(args: string[], options: GitOptions = {}): Promise<string> {
    const init: ExecInit = { cwd: this.root, env: { ...this.env(), ...options.env } }
    if (options.stdin !== undefined) init.stdin = options.stdin
    if (options.timeoutMs !== undefined) init.timeoutMs = options.timeoutMs
    const result = await this.run(['git', ...GIT_FLAGS, ...args], init)
    if (result.exitCode !== 0 && !options.isLenient) throw new GitError(args, result)
    return options.trim === false ? result.stdout : result.stdout.trim()
  }

  private run(argv: readonly string[], init: ExecInit): Promise<ExecResult> {
    return this.deps.exec(argv, init)
  }
}

function pendingRef(session: string): string {
  return `${PENDING}${session.replace(/[^A-Za-z0-9_-]/g, '') || 'default'}`
}

function commitTime(time: number): Record<string, string> {
  const stamp = `${Math.floor(time / 1000)} +0000`
  return { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
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
