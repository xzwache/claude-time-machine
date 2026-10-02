// The time machine itself: snapshots, history and restores, kept in a shadow
// Git repository outside the project. Nothing here reaches the model, and
// nothing here touches the project's own .git: the shadow repository has its
// own object store, its own index and its own refs under refs/tm/.
//
// This module runs both inside Claude Code (through `$.process.run`) and under
// Node for the tests, so it depends only on the two functions it is given.

import type { Change, ChangeStatus, Counts, Entry, EntryKind } from '../types'

export type { Change, ChangeStatus, Counts, Entry, EntryKind }

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

type PendingTurn = { turnId: string; prompt: string; startedAt: number }

const TIMELINE = 'refs/tm/timeline'
const PENDING = 'refs/tm/pending'
const SNAPSHOT_TIMEOUT_MS = 120_000
const CHUNK = 100

// Settings that would make a snapshot or a restore differ from the bytes on
// disk, or make git do more than it is asked, are pinned for every call.
const GIT_FLAGS = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.symlinks=true',
  '-c', 'core.fileMode=true',
  '-c', 'core.quotePath=false',
  '-c', 'core.fsmonitor=false',
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
   * as the person's own work, then remembers the turn as pending. A turn left
   * pending by a crash is closed first, marked interrupted.
   */
  beginTurn(turnId: string, prompt: string): Promise<void> {
    return this.serial(async () => {
      await this.ensureReady()
      const stale = await this.readPending()
      if (stale) await this.closeTurn(stale, true)
      await this.recordOutside()
      const pending: PendingTurn = { turnId, prompt, startedAt: Date.now() }
      const blob = await this.git(['hash-object', '-w', '--stdin'], { stdin: JSON.stringify(pending) })
      await this.git(['update-ref', PENDING, blob])
    })
  }

  /** Called as a turn ends: records what changed during it, if anything. */
  finishTurn(turnId: string, isInterrupted: boolean): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ensureReady()
      const pending = await this.readPending()
      if (!pending || pending.turnId !== turnId) return undefined
      return this.closeTurn(pending, isInterrupted)
    })
  }

  /**
   * Called before a file tool writes `path`. Ignored files are not part of a
   * snapshot, so one the turn is about to edit gets its current content
   * captured now and is tracked from then on.
   */
  beforeFileWrite(path: string): Promise<void> {
    return this.serial(async () => {
      if (!this.isReady || !(await this.readPending())) return
      const rel = this.relative(path)
      if (rel === undefined || !(await this.isIgnoredAndUntracked(rel))) return
      if (await this.existsInWorkTree(rel)) {
        const tip = await this.tip()
        const index = `${this.gitDir}/index-capture`
        await this.git(['read-tree', tip.commit], { index })
        await this.git(['add', '-f', '--', rel], { index })
        const tree = await this.git(['write-tree'], { index })
        if (tree !== tip.tree) {
          await this.commit(tree, tip.commit, { kind: 'capture', title: `Captured ignored ${rel}` })
        }
      }
      await this.trackIgnored(rel)
    })
  }

  /** Called after a file tool wrote `path`, so a new ignored file is tracked. */
  afterFileWrite(path: string): Promise<void> {
    return this.serial(async () => {
      if (!this.isReady || !(await this.readPending())) return
      const rel = this.relative(path)
      if (rel !== undefined && (await this.isIgnoredAndUntracked(rel))) await this.trackIgnored(rel)
    })
  }

  /** The timeline, newest first. Capture entries are bookkeeping and left out. */
  history(limit = 50): Promise<Entry[]> {
    return this.serial(async () => {
      await this.ensureReady()
      return this.readHistory(limit)
    })
  }

  /** One entry by id, short id or `HEAD~n`-style spelling on the timeline. */
  entry(ref: string): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ensureReady()
      return this.readEntry(ref)
    })
  }

  /** What an entry changed, against the snapshot before it. */
  changes(id: string): Promise<Change[]> {
    return this.serial(async () => {
      const entry = await this.readEntry(id)
      if (!entry?.parent) return []
      return this.diffTrees(entry.parent, entry.id)
    })
  }

  /** The unified diff of one file in an entry. */
  fileDiff(id: string, path: string): Promise<string> {
    return this.serial(async () => {
      const entry = await this.readEntry(id)
      if (!entry?.parent) return ''
      return this.git(['diff', '--no-color', '--no-ext-diff', '--no-renames', entry.parent, entry.id, '--', path], {
        trim: false,
      })
    })
  }

  /**
   * Reverts what one entry changed, leaving everything else as it is now.
   * A file that changed again since that entry is a conflict and is left
   * alone unless `isForced`. The current state is recorded first, so the undo
   * is itself on the timeline and can be undone.
   */
  undo(ref: string, isForced = false): Promise<RestoreReport> {
    return this.serial(async () => {
      await this.ensureReady()
      const entry = await this.readEntry(ref)
      if (!entry) throw new Error(`No snapshot named ${ref}`)
      if (!entry.parent) throw new Error('The baseline has nothing before it to go back to')
      const current = await this.recordOutside()
      const changes = await this.diffTrees(entry.parent, entry.id)
      const changedSince = new Set((await this.diffTrees(entry.id, current.tree)).map(change => change.path))
      const differsFromBefore = new Set((await this.diffTrees(entry.parent, current.tree)).map(change => change.path))
      // A path back at its before-state needs nothing; one changed since the
      // entry, to anything else, is someone's newer work.
      const settled = changes.filter(change => changedSince.has(change.path) && !differsFromBefore.has(change.path))
      const pending = changes.filter(change => differsFromBefore.has(change.path))
      const conflicts = isForced ? [] : pending.filter(change => changedSince.has(change.path))
      const conflictPaths = new Set(conflicts.map(change => change.path))
      const apply = pending.filter(change => !conflictPaths.has(change.path))
      await this.applyRestore(
        entry.parent,
        apply.filter(change => change.status !== 'added').map(change => change.path),
        apply.filter(change => change.status === 'added').map(change => change.path),
      )
      const title = entry.kind === 'undo' ? `Redo: ${entry.title.replace(/^(Undo|Redo): /, '')}` : `Undo: ${entry.title}`
      const done = apply.length === 0 ? undefined : await this.recordRestore('undo', title, entry.id)
      return {
        restored: apply.filter(change => change.status === 'modified').map(change => change.path),
        removed: apply.filter(change => change.status === 'added').map(change => change.path),
        recovered: apply.filter(change => change.status === 'deleted').map(change => change.path),
        conflicts: conflicts.map(change => change.path),
        unchanged: settled.map(change => change.path),
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
      const current = await this.recordOutside()
      const changes = await this.diffTrees(current.tree, entry.id)
      await this.applyRestore(
        entry.id,
        changes.filter(change => change.status !== 'deleted').map(change => change.path),
        changes.filter(change => change.status === 'deleted').map(change => change.path),
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

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async ensureReady(): Promise<void> {
    if (this.isReady) return
    await this.run(['git', 'init', '-q', '--bare', this.gitDir], {})
    await this.deps.writeFile(`${this.gitDir}/info/attributes`, ATTRIBUTES)
    await this.git(['config', 'tm.root', this.root])
    const has = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', TIMELINE], { env: this.env() })
    if (has.exitCode !== 0) {
      const tree = await this.snapshot()
      const id = await this.git(['commit-tree', tree], { stdin: message({ kind: 'baseline', title: 'Baseline' }) })
      await this.git(['update-ref', TIMELINE, id])
    }
    this.isReady = true
  }

  private async closeTurn(pending: PendingTurn, isInterrupted: boolean): Promise<Entry | undefined> {
    const tree = await this.snapshot()
    const tip = await this.tip()
    let recorded: Entry | undefined
    if (tree !== tip.tree) {
      const id = await this.commit(tree, tip.commit, {
        kind: 'turn',
        title: firstLine(pending.prompt) || '(turn without a prompt)',
        prompt: pending.prompt,
        isInterrupted,
      })
      recorded = await this.readEntry(id)
    }
    await this.git(['update-ref', '-d', PENDING])
    return recorded
  }

  /** Snapshots the work tree; records a change since the tip as `outside`. */
  private async recordOutside(): Promise<{ commit: string; tree: string }> {
    const tree = await this.snapshot()
    const tip = await this.tip()
    if (tree === tip.tree) return tip
    const commit = await this.commit(tree, tip.commit, { kind: 'outside', title: 'Changes outside Claude' })
    return { commit, tree }
  }

  private async recordRestore(kind: 'undo' | 'travel', title: string, target: string): Promise<Entry | undefined> {
    const tree = await this.snapshot()
    const tip = await this.tip()
    if (tree === tip.tree) return undefined
    const id = await this.commit(tree, tip.commit, { kind, title, target })
    return this.readEntry(id)
  }

  private async applyRestore(source: string, checkout: string[], remove: string[]): Promise<void> {
    for (const path of [...checkout, ...remove]) assertSafePath(path)
    // git rm checks for symlinked leading directories and prunes the
    // directories it empties; checkout restores content, mode and symlinks.
    for (const chunk of chunks(remove)) {
      await this.git(['rm', '-q', '-f', '-r', '--ignore-unmatch', '--', ...chunk])
    }
    for (const chunk of chunks(checkout)) {
      await this.git(['checkout', source, '--', ...chunk])
    }
  }

  private async snapshot(): Promise<string> {
    await this.git(['add', '-A', '--ignore-errors'], { timeoutMs: SNAPSHOT_TIMEOUT_MS, isLenient: true })
    return this.git(['write-tree'])
  }

  private async tip(): Promise<{ commit: string; tree: string }> {
    const [commit = '', tree = ''] = (await this.git(['rev-parse', TIMELINE, `${TIMELINE}^{tree}`])).split('\n')
    return { commit, tree }
  }

  private async commit(tree: string, parent: string, meta: Meta): Promise<string> {
    const id = await this.git(['commit-tree', tree, '-p', parent], { stdin: message(meta) })
    await this.git(['update-ref', TIMELINE, id, parent])
    return id
  }

  private async readPending(): Promise<PendingTurn | undefined> {
    const ref = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', PENDING], { env: this.env() })
    if (ref.exitCode !== 0) return undefined
    try {
      return JSON.parse(await this.git(['cat-file', 'blob', ref.stdout.trim()])) as PendingTurn
    } catch {
      return undefined
    }
  }

  private async readEntry(ref: string): Promise<Entry | undefined> {
    const spelled = /^~\d+$/.test(ref) ? `${TIMELINE}${ref}` : ref
    const found = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', `${spelled}^{commit}`], {
      env: this.env(),
    })
    if (found.exitCode !== 0) return undefined
    return (await this.readLog([found.stdout.trim(), '-n', '1']))[0]
  }

  private async readHistory(limit: number): Promise<Entry[]> {
    const entries = await this.readLog([TIMELINE, '-n', String(limit * 2)])
    return entries.filter(entry => entry.kind !== 'capture').slice(0, limit)
  }

  private async readLog(range: string[]): Promise<Entry[]> {
    const out = await this.git(
      ['log', '--no-renames', '--name-status', '--format=%x1e%H%x1f%P%x1f%ct%x1f%B%x1f', ...range],
      { trim: false },
    )
    return out
      .split('\x1e')
      .filter(record => record.trim() !== '')
      .map(record => {
        const [id = '', parents = '', time = '0', body = '', files = ''] = record.split('\x1f')
        const meta = parseMessage(body)
        const counts: Counts = { added: 0, modified: 0, deleted: 0 }
        for (const line of files.split('\n')) {
          if (line.startsWith('A\t')) counts.added++
          else if (line.startsWith('D\t')) counts.deleted++
          else if (/^[MT]\t/.test(line)) counts.modified++
        }
        return {
          id,
          parent: parents.split(' ')[0] || null,
          time: Number(time) * 1000,
          kind: meta.kind,
          title: meta.title,
          prompt: meta.prompt ?? '',
          target: meta.target ?? null,
          isInterrupted: meta.isInterrupted === true,
          counts,
        }
      })
  }

  private async diffTrees(from: string, to: string): Promise<Change[]> {
    const out = await this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to], { trim: false })
    const parts = out.split('\0')
    const changes: Change[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i] ?? ''
      const path = parts[i + 1] ?? ''
      const status: ChangeStatus = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
      if (path !== '') changes.push({ status, path })
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

  private async trackIgnored(rel: string): Promise<void> {
    if (await this.existsInWorkTree(rel)) await this.git(['add', '-f', '--', rel])
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

  private env(index?: string): Record<string, string> {
    return {
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_INDEX_FILE: index ?? `${this.gitDir}/index`,
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
    options: { stdin?: string; index?: string; timeoutMs?: number; trim?: boolean; isLenient?: boolean } = {},
  ): Promise<string> {
    const argv = ['git', ...GIT_FLAGS, ...args]
    const init: ExecInit = { cwd: this.root, env: this.env(options.index) }
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

type Meta = {
  kind: EntryKind
  title: string
  prompt?: string
  target?: string
  isInterrupted?: boolean
}

// Subject, then `tm-*` header lines, then a blank line and the prompt. The
// headers come before the free text so a prompt can never forge one.
function message(meta: Meta): string {
  const lines = [meta.title.replace(/\s+/g, ' ').slice(0, 200), '', `tm-kind: ${meta.kind}`]
  if (meta.target) lines.push(`tm-target: ${meta.target}`)
  if (meta.isInterrupted) lines.push('tm-interrupted: true')
  if (meta.prompt) lines.push('', meta.prompt)
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
    else if (key === 'target') meta.target = value
    else if (key === 'interrupted') meta.isInterrupted = value === 'true'
  }
  const prompt = lines.slice(i + 1).join('\n').replace(/\n+$/, '')
  if (prompt) meta.prompt = prompt
  return meta
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
