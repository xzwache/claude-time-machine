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

import type { Change, ChangeStatus, Counts, Entry, EntryKind, Project } from '../types'

export type { Change, ChangeStatus, Counts, Entry, EntryKind, Project }

export type ExecInit = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

export type Exec = (argv: readonly string[], init: ExecInit) => Promise<ExecResult>

export type Deps = {
  exec: Exec
  writeFile: (path: string, text: string) => Promise<void>
}

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

/** A commit as read off the timeline, before turns are grouped. */
type Raw = {
  id: string
  parent: string | null
  time: number
  meta: Meta
  changes: Change[]
}

type Timeline = {
  top: Entry[]
  raws: Raw[]
  byId: Map<string, Entry>
  byRaw: Map<string, Raw>
}

/** How one path goes back: from which snapshot, and what to check first. */
type PathPlan = {
  path: string
  before: string
  after: string
  isNew: boolean
  lastStatus: ChangeStatus
  isTainted: boolean
}

const TIMELINE = 'refs/tm/timeline'
const PENDING = 'refs/tm/pending/'
const SNAPSHOT_TIMEOUT_MS = 120_000
const STALE_PENDING_MS = 12 * 60 * 60 * 1000
const READ_WINDOW = 800
const CHUNK = 100
const IGNORED_FILE_LIMIT = '-1025k'
const ANSWER_MARK = '--- tm-answer ---'
const ANSWER_LIMIT = 4000
const PROJECT_NAME = /^[0-9a-f]{16}\.git$/

// Ignored files a snapshot leaves out even when small: build and editor debris.
const IGNORED_JUNK = /(^|\/)\.DS_Store$|\.(pyc|pyo|class|o|obj|so|dylib|dll|log|tmp|swp|swo)$/

// Settings that would make a snapshot or a restore differ from the bytes on
// disk, or make git do more than it is asked, are pinned for every call.
const GIT_FLAGS = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.symlinks=true',
  '-c', 'core.fileMode=true',
  '-c', 'core.quotePath=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgSign=false',
  '-c', 'gc.auto=0',
  '-c', 'advice.addEmbeddedRepo=false',
]

// Highest-precedence attributes: no line-ending, LFS or ident conversion, so
// what is restored is byte for byte what was snapshotted.
const ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n'

export class GitError extends Error {
  constructor(argv: readonly string[], result: ExecResult) {
    super(`git ${argv.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`)
  }
}

export class TimeMachine {
  readonly root: string
  readonly gitDir: string
  private deps: Deps
  private chain: Promise<unknown> = Promise.resolve()
  private isReady = false
  private cache: { tip: string; window: number; timeline: Timeline } | undefined

  constructor(deps: Deps, root: string, gitDir: string) {
    this.deps = deps
    this.root = root.replace(/\/+$/, '')
    this.gitDir = gitDir.replace(/\/+$/, '')
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
      if (!this.isReady || !(await this.readPending(session))) return
      const rel = this.relative(path)
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
      if (!this.isReady || !(await this.readPending(session))) return
      const rel = this.relative(path)
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
      const { byId } = await this.readTimeline()
      const turn = byId.get(id)
      return (turn?.steps ?? []).map(step => byId.get(step)).filter(isDefined)
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
      return this.git(['diff', '--no-color', '--no-ext-diff', '--no-renames', plan.before, plan.after, '--', path], {
        trim: false,
      })
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
      const settled = plans.filter(plan => !differsFromBefore.has(plan.path))
      const isConflict = (plan: PathPlan) => !isForced && (changedSince.has(plan.path) || plan.isTainted)
      const conflicts = pending.filter(isConflict)
      const apply = pending.filter(plan => !isConflict(plan))
      await this.applyPlans(apply)
      const title = entry.kind === 'undo' ? `Redo: ${entry.title.replace(/^(Undo|Redo): /, '')}` : `Undo: ${entry.title}`
      const done = apply.length === 0 ? undefined : await this.recordRestore('undo', title, entry.id)
      return {
        restored: apply.filter(plan => !plan.isNew && plan.lastStatus !== 'deleted').map(plan => plan.path),
        removed: apply.filter(plan => plan.isNew).map(plan => plan.path),
        recovered: apply.filter(plan => !plan.isNew && plan.lastStatus === 'deleted').map(plan => plan.path),
        conflicts: conflicts.map(plan => plan.path),
        unchanged: settled.map(plan => plan.path),
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
      const done = changes.length === 0 ? undefined : await this.recordRestore('travel', `Travel to: ${entry.title}`, entry.id)
      return {
        restored: changes.filter(change => change.status === 'modified').map(change => change.path),
        removed: changes.filter(change => change.status === 'deleted').map(change => change.path),
        recovered: changes.filter(change => change.status === 'added').map(change => change.path),
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
   * top-level entries, whichever keeps less. The oldest kept state becomes the
   * new baseline, so every kept entry can still be undone and travelled to.
   */
  prune(options: { olderThanMs?: number; keepLast?: number }): Promise<PruneReport> {
    return this.serial(async () => {
      await this.ensureReady()
      if ((await this.pendingRefs()).length > 0) throw new Error('A turn is running; prune when it ends')
      const bytesBefore = await diskUsage(this.deps.exec, this.gitDir)
      const { top, raws } = await this.readTimeline(Number.MAX_SAFE_INTEGER)
      const cutoff = options.olderThanMs === undefined ? -Infinity : Date.now() - options.olderThanMs
      let keep = top.filter(entry => entry.time >= cutoff && entry.kind !== 'baseline')
      if (options.keepLast !== undefined) keep = keep.slice(0, options.keepLast)
      const oldestKept = keep.at(-1)
      // The new baseline is the state the oldest kept entry started from.
      const rootId = oldestKept ? (oldestKept.base ?? oldestKept.parent) : top[0]?.id
      const rootIndex = raws.findIndex(raw => raw.id === rootId)
      if (rootId === undefined || rootId === null || rootIndex < 0) throw new Error('Nothing to prune')
      const removed = raws.length - rootIndex - 1
      if (removed === 0) {
        return { removed: 0, kept: raws.length, bytesBefore, bytesAfter: bytesBefore }
      }
      const tip = await this.tip()
      const map = new Map<string, string>()
      const date = new Date((raws[rootIndex]?.time ?? 0)).toISOString().slice(0, 10)
      map.set(rootId, await this.git(['commit-tree', rootId + '^{tree}'], {
        stdin: message({ kind: 'baseline', title: `Baseline (history before ${date} pruned)` }),
      }))
      for (const raw of raws.slice(0, rootIndex).reverse()) {
        const parent = raw.parent === null ? undefined : map.get(raw.parent)
        const meta: Meta = { ...raw.meta }
        if (meta.base !== undefined) meta.base = map.get(meta.base)
        if (meta.target !== undefined) meta.target = map.get(meta.target)
        const args = ['commit-tree', `${raw.id}^{tree}`, ...(parent ? ['-p', parent] : [])]
        map.set(raw.id, await this.git(args, { stdin: message(meta), env: commitTime(raw.time) }))
      }
      await this.git(['update-ref', TIMELINE, map.get(tip.commit) ?? '', tip.commit])
      await this.git(['reflog', 'expire', '--expire=now', '--all'], { isLenient: true })
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

  private async closeTurn(pending: PendingTurn, isInterrupted: boolean, answer: string): Promise<Entry | undefined> {
    await this.recordOutside(pending.session, "Changes not made by Claude's tools")
    const { raws } = await this.readTimeline()
    const baseIndex = raws.findIndex(raw => raw.id === pending.base)
    const range = baseIndex < 0 ? [] : raws.slice(0, baseIndex)
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
  private async changedAgainst(
    plans: PathPlan[],
    pick: (plan: PathPlan) => string,
    tree: string,
  ): Promise<Set<string>> {
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
    const { byRaw } = await this.readTimeline()
    const entry = await this.readEntry(id)
    if (!entry?.parent) return []
    if (entry.kind !== 'turn' || entry.base === null) {
      const own = byRaw.get(entry.id)?.changes ?? (await this.diffTrees(entry.parent, entry.id))
      return own.map(change => ({
        path: change.path,
        before: entry.parent ?? '',
        after: entry.id,
        isNew: change.status === 'added',
        lastStatus: change.status,
        isTainted: false,
      }))
    }
    return planTurn(entry, byRaw)
  }

  private async snapshot(): Promise<string> {
    await this.git(['add', '-A', '--ignore-errors'], { timeoutMs: SNAPSHOT_TIMEOUT_MS, isLenient: true })
    await this.addSmallIgnoredFiles()
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

  private async tip(): Promise<{ commit: string; tree: string }> {
    const [commit = '', tree = ''] = (await this.git(['rev-parse', TIMELINE, `${TIMELINE}^{tree}`])).split('\n')
    return { commit, tree }
  }

  /** Commits on the timeline; retries when another session moved it first. */
  private async commit(tree: string, parent: string, meta: Meta): Promise<string> {
    let onto = parent
    for (let attempt = 0; ; attempt++) {
      const id = await this.git(['commit-tree', tree, '-p', onto], { stdin: message(meta) })
      const moved = await this.run(['git', ...GIT_FLAGS, 'update-ref', TIMELINE, id, onto], {
        cwd: this.root,
        env: this.env(),
      })
      if (moved.exitCode === 0) return id
      if (attempt >= 5) throw new GitError(['update-ref', TIMELINE], moved)
      onto = (await this.tip()).commit
    }
  }

  private async readPending(session: string): Promise<PendingTurn | undefined> {
    const ref = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', pendingRef(session)], {
      env: this.env(),
    })
    if (ref.exitCode !== 0) return undefined
    return this.readPendingBlob(ref.stdout.trim())
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
    const id = found.stdout.trim()
    const { byId } = await this.readTimeline()
    if (byId.has(id)) return byId.get(id)
    const [raw] = await this.readRaws([id, '-n', '1'])
    return raw ? toEntry(raw) : undefined
  }

  /** The newest commits on the timeline, read in two git calls, then grouped. */
  private async readTimeline(window = READ_WINDOW): Promise<Timeline> {
    const tip = await this.git(['rev-parse', TIMELINE])
    if (this.cache?.tip === tip && this.cache.window === window) return this.cache.timeline
    const limit = Number.isFinite(window) ? ['-n', String(window)] : []
    const raws = await this.readRaws([TIMELINE, ...limit])
    const { top, byId } = group(raws)
    const timeline = { top, raws, byId, byRaw: new Map(raws.map(raw => [raw.id, raw])) }
    this.cache = { tip, window, timeline }
    return timeline
  }

  private async readRaws(range: string[]): Promise<Raw[]> {
    const log = await this.git(['log', '--format=%x1e%H%x1f%P%x1f%ct%x1f%B', ...range], { trim: false })
    const records = log.split('\x1e').filter(record => record.trim() !== '')
    const ids = records.map(record => record.split('\x1f')[0] ?? '')
    const changes = await this.changesOf(ids)
    return records.map(record => {
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

  /** Each commit's changes against its parent, in one diff-tree call. */
  private async changesOf(ids: string[]): Promise<Map<string, Change[]>> {
    const result = new Map<string, Change[]>()
    if (ids.length === 0) return result
    const out = await this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', '--always', '--stdin'], {
      stdin: `${ids.join('\n')}\n`,
      trim: false,
    })
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

  private async diffTrees(from: string, to: string, paths: string[] = []): Promise<Change[]> {
    const args = ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]
    const out = await this.git(paths.length > 0 ? [...args, '--', ...paths] : args, { trim: false })
    const parts = out.split('\0')
    const changes: Change[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const path = parts[i + 1] ?? ''
      if (path !== '') changes.push({ status: statusOf(parts[i] ?? ''), path })
    }
    return changes
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
    const result = await this.run(['test', '-e', rel, '-o', '-L', rel], { cwd: this.root })
    return result.exitCode === 0
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

  private async git(
    args: string[],
    options: { stdin?: string; timeoutMs?: number; trim?: boolean; isLenient?: boolean; env?: Record<string, string> } = {},
  ): Promise<string> {
    const argv = ['git', ...GIT_FLAGS, ...args]
    const init: ExecInit = { cwd: this.root, env: { ...this.env(), ...options.env } }
    if (options.stdin !== undefined) init.stdin = options.stdin
    if (options.timeoutMs !== undefined) init.timeoutMs = options.timeoutMs
    const result = await this.run(argv, init)
    if (result.exitCode !== 0 && !options.isLenient) throw new GitError(args, result)
    return options.trim === false ? result.stdout : result.stdout.trim()
  }

  private run(argv: readonly string[], init: ExecInit): Promise<ExecResult> {
    return this.deps.exec(argv, init)
  }
}

/** Every project's shadow repository under `home`, newest activity first. */
export async function listProjects(exec: Exec, home: string): Promise<Project[]> {
  const listed = await exec(['ls', '-1', home], {})
  const names = listed.exitCode === 0 ? listed.stdout.split('\n').filter(name => PROJECT_NAME.test(name)) : []
  const projects: Project[] = []
  for (const name of names) {
    const gitDir = `${home}/${name}`
    const git = (args: string[]) => exec(['git', `--git-dir=${gitDir}`, ...args], {})
    const root = (await git(['config', 'tm.root'])).stdout.trim()
    const count = Number((await git(['rev-list', '--count', TIMELINE])).stdout.trim()) || 0
    const last = Number((await git(['log', '-1', '--format=%ct', TIMELINE])).stdout.trim()) || 0
    const isRootPresent = root !== '' && (await exec(['test', '-d', root], {})).exitCode === 0
    projects.push({ name, gitDir, root, isRootPresent, entries: count, bytes: await diskUsage(exec, gitDir), lastTime: last * 1000 })
  }
  return projects.sort((a, b) => b.lastTime - a.lastTime)
}

/** Deletes one project's shadow repository: its whole history. */
export async function deleteProject(exec: Exec, home: string, name: string): Promise<void> {
  if (!PROJECT_NAME.test(name)) throw new Error(`Not a time machine repository: ${name}`)
  const result = await exec(['rm', '-rf', '--', `${home}/${name}`], {})
  if (result.exitCode !== 0) throw new Error(`Could not delete ${name}: ${result.stderr.trim()}`)
}

async function diskUsage(exec: Exec, path: string): Promise<number> {
  const result = await exec(['du', '-sk', path], {})
  return (Number(result.stdout.split('\t')[0]) || 0) * 1024
}

/**
 * Folds each turn's steps into it. Reading newest first, a turn marker claims
 * the commits back to its base: its session's steps, and every commit there
 * not claimed by another session's turn (outside changes, captures).
 */
function group(raws: Raw[]): { top: Entry[]; byId: Map<string, Entry> } {
  const byId = new Map<string, Entry>()
  const claimed = new Set<string>()
  const indexOf = new Map(raws.map((raw, i) => [raw.id, i]))
  for (const [i, raw] of raws.entries()) {
    const entry = toEntry(raw)
    byId.set(raw.id, entry)
    const baseIndex = raw.meta.base === undefined ? undefined : indexOf.get(raw.meta.base)
    if (raw.meta.kind !== 'turn' || baseIndex === undefined) continue
    const range = raws.slice(i + 1, baseIndex).reverse()
    const mine = range.filter(one => !claimed.has(one.id) && isTurnPart(one, raw.meta.session))
    for (const one of mine) claimed.add(one.id)
    entry.steps = mine.filter(one => one.meta.kind !== 'capture').map(one => one.id)
    entry.changes = netChanges(planTurn(entry, new Map(range.map(one => [one.id, one]))))
    entry.counts = countsOf(entry.changes)
  }
  const top = raws.filter(raw => !claimed.has(raw.id) && raw.meta.kind !== 'capture').map(raw => byId.get(raw.id)).filter(isDefined)
  return { top, byId }
}

function isTurnPart(raw: Raw, session: string | undefined): boolean {
  return raw.meta.kind === 'outside' || raw.meta.kind === 'capture' || (raw.meta.kind === 'step' && raw.meta.session === session)
}

/**
 * A turn's paths: each goes back to its state before the first step that
 * touched it. A change by anything else after that taints the path, so undo
 * treats it as a conflict instead of discarding that change.
 */
function planTurn(turn: Entry, byRaw: Map<string, Raw>): PathPlan[] {
  const plans = new Map<string, PathPlan>()
  const range: Raw[] = []
  let at = turn.parent
  while (at !== null && at !== turn.base) {
    const raw = byRaw.get(at)
    if (!raw) break
    range.unshift(raw)
    at = raw.parent
  }
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
    changes: raw.changes,
    counts: countsOf(raw.changes),
    steps: [],
  }
}

function statusOf(code: string): ChangeStatus {
  return code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
}

type Meta = {
  kind: EntryKind
  title: string
  prompt?: string
  answer?: string
  session?: string
  base?: string | undefined
  target?: string | undefined
  isInterrupted?: boolean
}

// Subject, then `tm-*` header lines, then a blank line, the prompt and the
// answer. The headers come before the free text so a prompt cannot forge one.
function message(meta: Meta): string {
  const lines = [meta.title.replace(/\s+/g, ' ').slice(0, 200), '', `tm-kind: ${meta.kind}`]
  if (meta.session) lines.push(`tm-session: ${meta.session.replace(/\s+/g, '')}`)
  if (meta.base) lines.push(`tm-base: ${meta.base}`)
  if (meta.target) lines.push(`tm-target: ${meta.target}`)
  if (meta.isInterrupted) lines.push('tm-interrupted: true')
  if (meta.prompt || meta.answer) lines.push('', meta.prompt ?? '')
  if (meta.answer) lines.push(ANSWER_MARK, meta.answer)
  return `${lines.join('\n')}\n`
}

function parseMessage(body: string): Meta {
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
  }
  const text = lines.slice(i + 1).join('\n').replace(/\n+$/, '')
  const mark = text.lastIndexOf(`\n${ANSWER_MARK}\n`)
  const prompt = mark < 0 ? text : text.slice(0, mark)
  if (prompt) meta.prompt = prompt
  if (mark >= 0) meta.answer = text.slice(mark + ANSWER_MARK.length + 2)
  return meta
}

function pendingRef(session: string): string {
  return `${PENDING}${session.replace(/[^A-Za-z0-9_-]/g, '') || 'default'}`
}

function commitTime(time: number): Record<string, string> {
  const stamp = `${Math.floor(time / 1000)} +0000`
  return { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }
}

function firstLine(text: string): string {
  const line = text.split('\n').find(one => one.trim() !== '') ?? ''
  return line.trim().slice(0, 80)
}

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
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
