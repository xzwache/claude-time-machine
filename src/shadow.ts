// The shadow repository: a bare git repository outside the project whose
// work tree is the project. It has its own object store, index and refs, so
// nothing here touches the project's own .git.

import type { Change, EntryKind } from '../types'
import type { Repos } from './export.ts'
import { ATTRIBUTES, GIT_FLAGS, GitError, chunks } from './git.ts'
import type { Deps, ExecInit, ExecResult } from './git.ts'
import { message } from './message.ts'
import type { Meta } from './message.ts'
import { LOG_FORMAT, logIds, parseDiffTree, parseDiffTreeStdin, parseLog } from './timeline.ts'
import type { Raw } from './timeline.ts'

export const TIMELINE = 'refs/tm/timeline'

export type GitOptions = {
  stdin?: string
  timeoutMs?: number
  trim?: boolean
  isLenient?: boolean
  env?: Record<string, string>
}

export type Tip = { commit: string; tree: string }

const SNAPSHOT_TIMEOUT_MS = 120_000
const IGNORED_FILE_LIMIT = '-1025k'
const TMIGNORE = '.tmignore'

// Ignored files left out even when small: build and editor debris.
const IGNORED_JUNK = /(^|\/)\.DS_Store$|\.(pyc|pyo|class|o|obj|so|dylib|dll|log|tmp|swp|swo)$/

export class ShadowRepo {
  readonly root: string
  readonly gitDir: string
  private deps: Deps
  private excludes: string | undefined

  constructor(deps: Deps, root: string, gitDir: string) {
    this.deps = deps
    this.root = root.replace(/\/+$/, '')
    this.gitDir = gitDir.replace(/\/+$/, '')
  }

  use(deps: Deps): void {
    this.deps = deps
  }

  get exec(): Deps['exec'] {
    return this.deps.exec
  }

  /** Creates the repository if needed; true when it has no timeline yet. */
  async open(): Promise<boolean> {
    const home = this.gitDir.slice(0, this.gitDir.lastIndexOf('/'))
    await this.run(['mkdir', '-p', home], {})
    await this.run(['chmod', '700', home], {})
    await this.run(['git', 'init', '-q', '--bare', this.gitDir], {})
    await this.deps.writeFile(`${this.gitDir}/info/attributes`, ATTRIBUTES)
    await this.git(['config', 'tm.root', this.root])
    await this.git(['config', 'core.untrackedCache', 'true'])
    await this.git(['config', 'index.version', '4'])
    return !(await this.succeeds(['rev-parse', '--verify', '-q', TIMELINE]))
  }

  /** Starts the timeline with the current work tree. */
  async startTimeline(): Promise<void> {
    await this.snapshot()
    const tree = await this.git(['write-tree'])
    const id = await this.git(['commit-tree', tree], { stdin: message({ kind: 'baseline', title: 'Baseline' }) })
    await this.git(['update-ref', TIMELINE, id])
  }

  /**
   * Brings the index up to the work tree. `isDiscovering` also looks for new
   * small ignored files: a second walk of the tree, skipped where a snapshot
   * must be quick and a new ignored file is unlikely.
   */
  async snapshot(isDiscovering = true): Promise<void> {
    await this.syncExcludes()
    await this.git(['add', '-A', '--ignore-errors'], { timeoutMs: SNAPSHOT_TIMEOUT_MS, isLenient: true })
    if (isDiscovering) await this.addSmallIgnoredFiles()
    await this.dropExcluded()
  }

  /** Brings one path of the index up to the work tree, ignored or not. */
  async stage(rel: string, isForced: boolean): Promise<void> {
    await this.git(['add', isForced ? '-f' : '-A', '--', rel], { isLenient: !isForced })
  }

  async tip(): Promise<Tip> {
    const [commit = '', tree = ''] = (await this.git(['rev-parse', TIMELINE, `${TIMELINE}^{tree}`])).split('\n')
    return { commit, tree }
  }

  async tipId(): Promise<string> {
    return this.git(['rev-parse', TIMELINE])
  }

  async writeTree(): Promise<string> {
    return this.git(['write-tree'])
  }

  /** Commits the index on the timeline when it differs from the tip. */
  async commitIfChanged(session: string | null, kind: EntryKind, title: string, target?: string): Promise<string | undefined> {
    const tree = await this.writeTree()
    const tip = await this.tip()
    if (tree === tip.tree) return undefined
    const meta: Meta = { kind, title }
    if (session !== null) meta.session = session
    if (target !== undefined) meta.target = target
    return this.commit(tree, tip.commit, meta)
  }

  /** Commits on the timeline; retries when another session moved it first. */
  async commit(tree: string, parent: string, meta: Meta): Promise<string> {
    let onto = parent
    for (let attempt = 0; ; attempt++) {
      const id = await this.git(['commit-tree', tree, '-p', onto], { stdin: message(meta) })
      const moved = await this.run(['git', ...GIT_FLAGS, 'update-ref', TIMELINE, id, onto], { cwd: this.root, env: this.env() })
      if (moved.exitCode === 0) return id
      if (attempt >= 5) throw new GitError(['update-ref', TIMELINE], moved)
      onto = (await this.tip()).commit
    }
  }

  /** Commits and their own changes, in two git calls. */
  async readRaws(range: string[]): Promise<Raw[]> {
    const log = await this.git(['log', LOG_FORMAT, ...range], { trim: false })
    const ids = logIds(log)
    if (ids.length === 0) return []
    const args = ['diff-tree', '-r', '-z', '--no-renames', '--name-status', '--always', '--stdin']
    const changes = parseDiffTreeStdin(await this.git(args, { stdin: `${ids.join('\n')}\n`, trim: false }))
    return parseLog(log, changes)
  }

  async diffTrees(from: string, to: string, paths: string[] = []): Promise<Change[]> {
    const args = ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]
    return parseDiffTree(await this.git(paths.length > 0 ? [...args, '--', ...paths] : args, { trim: false }))
  }

  /** The commit id `ref` names, or undefined. `~n` counts back from the tip. */
  async resolve(ref: string): Promise<string | undefined> {
    const spelled = /^~\d+$/.test(ref) ? `${TIMELINE}${ref}` : ref
    return this.objectId(`${spelled}^{commit}`)
  }

  /** The object id `ref` names, or undefined. */
  async objectId(ref: string): Promise<string | undefined> {
    const found = await this.run(['git', ...GIT_FLAGS, 'rev-parse', '--verify', '-q', ref], { env: this.env() })
    return found.exitCode === 0 ? found.stdout.trim() : undefined
  }

  /** Untracked here and covered by an ignore rule. */
  async isIgnoredAndUntracked(rel: string): Promise<boolean> {
    // check-ignore refuses literal pathspecs, and takes the path verbatim anyway.
    const result = await this.run(['git', ...GIT_FLAGS, 'check-ignore', '-q', '--', rel], {
      cwd: this.root,
      env: { ...this.env(), GIT_LITERAL_PATHSPECS: '0' },
    })
    return result.exitCode === 0
  }

  async existsInWorkTree(rel: string): Promise<boolean> {
    return (await this.run(['test', '-e', rel, '-o', '-L', rel], { cwd: this.root })).exitCode === 0
  }

  /** The path relative to the project root, or undefined when outside it. */
  relative(path: string): string | undefined {
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

  /** Packs loose objects once there are enough of them. */
  async pack(): Promise<void> {
    await this.git(['-c', 'gc.auto=1000', '-c', 'gc.autoPackLimit=20', 'gc', '--auto', '--quiet'], {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      isLenient: true,
    })
  }

  /** Drops unreachable objects for good. */
  async collect(): Promise<void> {
    await this.git(['gc', '--prune=now', '--quiet'], { timeoutMs: SNAPSHOT_TIMEOUT_MS, isLenient: true })
  }

  /** git in this repository and in the project's own, for export.ts. */
  repos(): Repos {
    const literal = (args: string[]) => (args[0] === 'check-ignore' ? '0' : '1')
    return {
      shadow: (args, options = {}) => this.git(args, { ...options, env: { GIT_LITERAL_PATHSPECS: literal(args) } }),
      user: async (args, options = {}) => {
        const env: Record<string, string> = { GIT_LITERAL_PATHSPECS: literal(args), LC_ALL: 'C' }
        if (options.index !== undefined) env.GIT_INDEX_FILE = options.index
        const init: ExecInit = { cwd: this.root, env }
        if (options.stdin !== undefined) init.stdin = options.stdin
        const result = await this.run(['git', ...args], init)
        if (result.exitCode !== 0 && !options.isLenient) throw new GitError(args, result)
        return options.trim === false ? result.stdout : result.stdout.trim()
      },
      userSucceeds: async args => (await this.run(['git', ...args], { cwd: this.root, env: { LC_ALL: 'C' } })).exitCode === 0,
      exists: async path => (await this.run(['test', '-e', path], {})).exitCode === 0,
      remove: async path => void (await this.run(['rm', '-f', '--', path], {})),
    }
  }

  async git(args: string[], options: GitOptions = {}): Promise<string> {
    const init: ExecInit = { cwd: this.root, env: { ...this.env(), ...options.env } }
    if (options.stdin !== undefined) init.stdin = options.stdin
    if (options.timeoutMs !== undefined) init.timeoutMs = options.timeoutMs
    const result = await this.run(['git', ...GIT_FLAGS, ...args], init)
    if (result.exitCode !== 0 && !options.isLenient) throw new GitError(args, result)
    return options.trim === false ? result.stdout : result.stdout.trim()
  }

  async succeeds(args: string[]): Promise<boolean> {
    return (await this.run(['git', ...GIT_FLAGS, ...args], { env: this.env() })).exitCode === 0
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
   * `.tmignore` at the project root, in .gitignore syntax, lists paths never
   * snapshotted. It becomes info/exclude, so `git add -A` does not walk them.
   */
  private async syncExcludes(): Promise<void> {
    const read = await this.run(['cat', '--', `${this.root}/${TMIGNORE}`], {})
    const text = read.exitCode === 0 ? read.stdout : ''
    if (text === this.excludes) return
    await this.deps.writeFile(`${this.gitDir}/info/exclude`, text)
    this.excludes = text
  }

  /** Drops what `.tmignore` names from the index, force-added files included. */
  private async dropExcluded(): Promise<void> {
    if (!this.excludes) return
    const args = ['ls-files', '-z', '--cached', '--ignored', `--exclude-from=${this.gitDir}/info/exclude`]
    const listed = await this.git(args, { trim: false, isLenient: true, env: { GIT_LITERAL_PATHSPECS: '0' } })
    const paths = listed.split('\0').filter(Boolean)
    for (const chunk of chunks(paths)) await this.git(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...chunk])
  }

  private env(): Record<string, string> {
    return {
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_INDEX_FILE: `${this.gitDir}/index`,
      GIT_LITERAL_PATHSPECS: '1',
      GIT_AUTHOR_NAME: 'Time Machine',
      GIT_AUTHOR_EMAIL: 'time-machine@localhost',
      GIT_COMMITTER_NAME: 'Time Machine',
      GIT_COMMITTER_EMAIL: 'time-machine@localhost',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    }
  }

  private run(argv: readonly string[], init: ExecInit): Promise<ExecResult> {
    return this.deps.exec(argv, init)
  }
}
