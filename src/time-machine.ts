// The time machine: snapshots around every turn and tool call, kept in a
// shadow git repository, and the ways back.
//
// The timeline is one linear chain of commits on refs/tm/timeline. A turn is
// a run of commits: a `step` per tool call that changed files, `outside` for
// changes made between them by anything else, and a `turn` marker at the end
// naming the commit the turn started from.
//
// It runs inside Claude Code (through `$.process.run`) and under Node for the
// tests, so it depends only on the two functions it is given. Every public
// call is serialized: hooks fire concurrently, git's index cannot.

import type { Change, Entry, Finding } from '../types'
import { branchSnapshot, commitPaths } from './export.ts'
import type { BranchReport, CommitReport } from './export.ts'
import { chunks, diskUsage } from './git.ts'
import type { Deps } from './git.ts'
import { readHeat } from './heat.ts'
import type { Heat } from './heat.ts'
import { History } from './history.ts'
import { firstLine } from './message.ts'
import type { Meta } from './message.ts'
import { PendingTurns } from './pending.ts'
import type { PendingTurn } from './pending.ts'
import { prune } from './prune.ts'
import type { PruneOptions, PruneReport } from './prune.ts'
import { travel, undo } from './restore.ts'
import { findingPaths, findingsOf } from './sensitive.ts'
import type { RestoreReport } from './restore.ts'
import { ShadowRepo, TIMELINE } from './shadow.ts'

const ANSWER_LIMIT = 4000

export class TimeMachine {
  private readonly shadow: ShadowRepo
  private readonly log: History
  private readonly pending: PendingTurns
  private chain: Promise<unknown> = Promise.resolve()
  private isReady = false

  /** `window`: how many commits a history read starts with (tests shrink it). */
  constructor(deps: Deps, root: string, gitDir: string, window = 800) {
    this.shadow = new ShadowRepo(deps, root, gitDir)
    this.log = new History(this.shadow, window)
    this.pending = new PendingTurns(this.shadow)
  }

  get root(): string {
    return this.shadow.root
  }

  get gitDir(): string {
    return this.shadow.gitDir
  }

  /** Swaps the functions it runs with, as each hook brings its own. */
  use(deps: Deps): this {
    this.shadow.use(deps)
    return this
  }

  /** The command for looking at the timeline with plain git. */
  inspectCommand(): string {
    return `git --git-dir='${this.gitDir}' --work-tree='${this.root}' log --stat ${TIMELINE}`
  }

  /** Creates the shadow repository and its baseline when missing. */
  init(): Promise<void> {
    return this.serial(() => this.ready())
  }

  /**
   * A turn starts: whatever changed since the last snapshot is recorded as
   * outside work. A turn this session left open (a crash) is closed first.
   */
  beginTurn(turnId: string, prompt: string, session: string): Promise<void> {
    return this.serial(async () => {
      await this.ready()
      const stale = await this.pending.get(session)
      if (stale) await this.closeTurn(stale, true, '')
      await this.pending.dropStale()
      const base = await this.recordOutside(session, 'Changes outside Claude')
      await this.pending.set({ turnId, prompt, startedAt: Date.now(), base, session })
    })
  }

  /** A turn ends: a marker closes it, if it changed anything. */
  finishTurn(turnId: string, session: string, isInterrupted: boolean, answer = ''): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ready()
      const turn = await this.pending.get(session)
      if (!turn || turn.turnId !== turnId) return undefined
      return this.closeTurn(turn, isInterrupted, answer)
    })
  }

  /**
   * Before a file tool writes `path`: an edit someone else made to it is
   * recorded as theirs, and an ignored file is captured so it can come back.
   */
  beforeFileWrite(path: string, session: string): Promise<void> {
    return this.serial(async () => {
      const rel = await this.turnPath(path, session)
      if (rel === undefined) return
      if (await this.shadow.isIgnoredAndUntracked(rel)) {
        if (!(await this.shadow.existsInWorkTree(rel))) return
        await this.shadow.stage(rel, true)
        await this.shadow.commitIfChanged(session, 'capture', `Captured ignored ${rel}`)
        return
      }
      await this.shadow.stage(rel, false)
      await this.shadow.commitIfChanged(session, 'outside', `Changed outside Claude's tools: ${rel}`)
    })
  }

  /** After a file tool wrote `path`: the write is a step. */
  afterFileWrite(path: string, tool: string, session: string): Promise<void> {
    return this.serial(async () => {
      const rel = await this.turnPath(path, session)
      if (rel === undefined) return
      const isIgnored = await this.shadow.isIgnoredAndUntracked(rel)
      if (!isIgnored) await this.shadow.stage(rel, false)
      else if (await this.shadow.existsInWorkTree(rel)) await this.shadow.stage(rel, true)
      await this.shadow.commitIfChanged(session, 'step', `${tool} ${rel}`)
    })
  }

  /** Before a shell command: outside changes up to now are recorded. */
  beforeCommand(session: string): Promise<void> {
    return this.serial(async () => {
      if (!this.isReady || !(await this.pending.get(session))) return
      // New ignored files are looked for after the command, not before.
      await this.recordOutside(session, "Changes outside Claude's tools", false)
    })
  }

  /** After a shell command: what it changed is a step. */
  afterCommand(command: string, session: string): Promise<void> {
    return this.serial(async () => {
      if (!this.isReady || !(await this.pending.get(session))) return
      await this.shadow.snapshot()
      await this.shadow.commitIfChanged(session, 'step', `Bash: ${firstLine(command) || '(command)'}`)
    })
  }

  /** Saves the work tree under `name`, changed or not. */
  save(name: string, session: string | null): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ready()
      await this.shadow.snapshot()
      const tree = await this.shadow.writeTree()
      const tip = await this.shadow.tip()
      const meta: Meta = { kind: 'checkpoint', title: name.trim() || 'Checkpoint' }
      if (session !== null) meta.session = session
      return this.log.entry(await this.shadow.commit(tree, tip.commit, meta))
    })
  }

  findCheckpoint(name: string): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ready()
      return this.log.checkpoint(name)
    })
  }

  /** The timeline, newest first, with each turn's steps folded in. */
  history(limit = 50): Promise<Entry[]> {
    return this.serial(async () => {
      await this.ready()
      return this.log.top(limit)
    })
  }

  /** A turn's steps and the outside changes between them, oldest first. */
  steps(id: string): Promise<Entry[]> {
    return this.serial(async () => {
      await this.ready()
      const turn = await this.log.entry(id)
      return turn ? this.log.steps(turn) : []
    })
  }

  /** One entry by id, short id, or `~n` back from the tip. */
  entry(ref: string): Promise<Entry | undefined> {
    return this.serial(async () => {
      await this.ready()
      return this.log.entry(ref)
    })
  }

  changes(id: string): Promise<Change[]> {
    return this.serial(async () => (await this.log.entry(id))?.changes ?? [])
  }

  fileDiff(id: string, path: string): Promise<string> {
    return this.serial(async () => {
      const entry = await this.log.entry(id)
      const plan = entry && (await this.log.plan(entry)).find(one => one.path === path)
      if (!plan) return ''
      return this.shadow.git(
        ['diff', '--no-color', '--no-ext-diff', '--no-renames', plan.before, plan.after, '--', path],
        {
          trim: false,
        },
      )
    })
  }

  undo(ref: string, isForced = false): Promise<RestoreReport> {
    return this.serial(async () => undo(this.shadow, this.log, await this.required(ref), isForced))
  }

  /** What the security diff flags among the paths an entry changed. */
  findings(ref: string): Promise<Finding[]> {
    return this.serial(async () => findingsOf(this.shadow, await this.log.plan(await this.required(ref))))
  }

  /** Undoes only the paths the security diff flags; undefined when it flags none. */
  undoSensitive(ref: string, isForced = false): Promise<RestoreReport | undefined> {
    return this.serial(async () => {
      const entry = await this.required(ref)
      const paths = findingPaths(await findingsOf(this.shadow, await this.log.plan(entry)))
      if (paths.length === 0) return undefined
      return undo(this.shadow, this.log, entry, isForced, new Set(paths))
    })
  }

  travel(ref: string): Promise<RestoreReport> {
    return this.serial(async () => travel(this.shadow, this.log, await this.required(ref)))
  }

  /** Commits what an entry changed to the project's own current branch. */
  commitTo(ref: string, text: string | undefined, isForced: boolean): Promise<CommitReport> {
    return this.serial(async () => {
      const entry = await this.required(ref)
      const sources = (await this.log.plan(entry)).map(plan => ({ path: plan.path, commit: plan.after }))
      if (sources.length === 0) throw new Error('That snapshot changed no files')
      return commitPaths(this.shadow.repos(), sources, `${text?.trim() || entry.title}\n`, isForced)
    })
  }

  /** Creates a branch in the project's repository holding a whole snapshot. */
  branchTo(ref: string, name: string): Promise<BranchReport> {
    return this.serial(async () => {
      const entry = await this.required(ref)
      const text = `${entry.title}\n\nThe work tree at time machine snapshot ${entry.id.slice(0, 12)}.\n`
      return branchSnapshot(this.shadow.repos(), entry.id, name, text)
    })
  }

  /** What an entry changed, as a patch for `git apply`, binary files included. */
  patch(ref: string): Promise<string> {
    return this.serial(async () => {
      const entry = await this.required(ref)
      const pairs = new Map<string, string[]>()
      for (const plan of await this.log.plan(entry)) {
        const key = `${plan.before} ${plan.after}`
        pairs.set(key, [...(pairs.get(key) ?? []), plan.path])
      }
      let patch = ''
      for (const [key, paths] of pairs) {
        const [before = '', after = ''] = key.split(' ')
        for (const chunk of chunks(paths)) {
          const args = [
            'diff',
            '--binary',
            '--no-color',
            '--no-ext-diff',
            '--no-renames',
            before,
            after,
            '--',
            ...chunk,
          ]
          patch += await this.shadow.git(args, { trim: false })
        }
      }
      return patch
    })
  }

  stats(): Promise<{ entries: number; bytes: number }> {
    return this.serial(async () => {
      await this.ready()
      const entries = Number(await this.shadow.git(['rev-list', '--count', TIMELINE])) || 0
      return { entries, bytes: await diskUsage(this.shadow.exec, this.gitDir) }
    })
  }

  /** What the timeline did to each file since `sinceMs` (all of it when null). */
  heat(sinceMs: number | null = null): Promise<Heat> {
    return this.serial(async () => {
      await this.ready()
      return readHeat(this.shadow, sinceMs)
    })
  }

  /** Packs loose objects when there are enough of them; quick otherwise. */
  maintain(): Promise<void> {
    return this.serial(async () => {
      if (this.isReady) await this.shadow.pack()
    })
  }

  prune(options: PruneOptions): Promise<PruneReport> {
    return this.serial(async () => {
      await this.ready()
      if (await this.pending.any()) throw new Error('A turn is running; prune when it ends')
      return prune(this.shadow, this.log, options)
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async ready(): Promise<void> {
    if (this.isReady) return
    if (await this.shadow.open()) await this.shadow.startTimeline()
    this.isReady = true
  }

  private async required(ref: string): Promise<Entry> {
    await this.ready()
    const entry = await this.log.entry(ref)
    if (!entry) throw new Error(`No snapshot named ${ref}`)
    return entry
  }

  /** The path a file tool names, relative to the root, while a turn runs. */
  private async turnPath(path: string, session: string): Promise<string | undefined> {
    if (!this.isReady || !(await this.pending.get(session))) return undefined
    return this.shadow.relative(path)
  }

  private async closeTurn(turn: PendingTurn, isInterrupted: boolean, answer: string): Promise<Entry | undefined> {
    await this.recordOutside(turn.session, "Changes not made by Claude's tools")
    const range = await this.shadow.readRaws([`${turn.base}..${TIMELINE}`])
    const hasSteps = range.some(raw => raw.meta.kind === 'step' && raw.meta.session === turn.session)
    let recorded: Entry | undefined
    if (hasSteps) {
      const tip = await this.shadow.tip()
      const id = await this.shadow.commit(tip.tree, tip.commit, {
        kind: 'turn',
        title: firstLine(turn.prompt) || '(turn without a prompt)',
        prompt: turn.prompt,
        answer: answer.slice(0, ANSWER_LIMIT),
        session: turn.session,
        base: turn.base,
        isInterrupted,
      })
      recorded = await this.log.entry(id)
    }
    await this.pending.clear(turn.session)
    return recorded
  }

  /** Snapshots and records any change since the tip; returns the tip. */
  private async recordOutside(session: string, title: string, isDiscovering = true): Promise<string> {
    await this.shadow.snapshot(isDiscovering)
    await this.shadow.commitIfChanged(session, 'outside', title)
    return (await this.shadow.tip()).commit
  }
}
