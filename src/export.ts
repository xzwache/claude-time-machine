// Taking snapshots out of the shadow repository into the project's own:
// a turn's files as a commit on the current branch, or a whole snapshot as a
// new branch. These are the only writes the time machine makes to the
// project's .git, and only when asked.
//
// Nothing here touches the work tree. Objects are copied with pack-objects;
// trees are built in a temporary index, so the project's index changes only
// for the committed paths, and only after the commit is made.

import { chunks } from './git.ts'

export type GitCall = (
  args: string[],
  options?: { stdin?: string; trim?: boolean; isLenient?: boolean; index?: string },
) => Promise<string>

/** git in the shadow repository and in the project's, plus a status check. */
export type Repos = {
  shadow: GitCall
  user: GitCall
  userSucceeds: (args: string[]) => Promise<boolean>
  exists: (path: string) => Promise<boolean>
  remove: (path: string) => Promise<void>
}

/** One path at one snapshot: where to take it from. */
export type Source = { path: string; commit: string }

export type CommitReport = { commit: string; branch: string; committed: string[]; skipped: string[] }

export type BranchReport = { commit: string; branch: string; files: number; skipped: string[] }

type TreeEntry = { mode: string; type: string; sha: string; path: string }

const ZERO = '0000000000000000000000000000000000000000'
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']

/**
 * Commits the given paths, each as it is in its snapshot, on top of the
 * project's HEAD. Paths the project ignores (and does not track) are
 * skipped. Refuses while a merge or rebase is in progress, and, unless
 * `isForced`, when the project has staged changes to those paths.
 */
export async function commitPaths(repos: Repos, sources: Source[], message: string, isForced: boolean): Promise<CommitReport> {
  const project = await openProject(repos)
  const { kept, skipped } = await dropIgnored(repos, project.prefix, sources.map(source => source.path))
  if (kept.length === 0) throw new Error('Nothing to commit: every changed path is ignored by this repository')
  const wanted = new Set(kept)
  const pending = sources.filter(source => wanted.has(source.path))
  const staged = await stagedAmong(repos, kept.map(path => project.prefix + path))
  if (staged.length > 0 && !isForced) {
    throw new Error(`Staged changes to ${staged.join(', ')} would be replaced; commit or unstage them, or add --force`)
  }

  const entries: TreeEntry[] = []
  const removed: string[] = []
  for (const source of pending) {
    const [entry] = await treeEntries(repos, source.commit, [source.path])
    if (entry) entries.push({ ...entry, path: project.prefix + entry.path })
    else removed.push(project.prefix + source.path)
  }
  await copyObjects(repos, project, entries)
  const tree = await buildTree(repos, project, project.head ?? null, entries, removed)
  if (project.head !== undefined && tree === (await repos.user(['rev-parse', `${project.head}^{tree}`]))) {
    throw new Error('Nothing to commit: HEAD already has these files as they were')
  }
  const commit = await repos.user(['commit-tree', tree, ...(project.head ? ['-p', project.head] : [])], { stdin: message })
  await repos.user(['update-ref', '-m', 'time machine: commit', 'HEAD', commit, project.head ?? ZERO])
  // The index takes the committed versions of these paths, nothing else.
  for (const chunk of chunks(kept.map(path => project.prefix + path))) {
    await repos.user(['reset', '-q', commit, '--', ...chunk], { isLenient: true })
  }
  return { commit, branch: project.branch, committed: kept, skipped }
}

/**
 * Creates branch `name` at a new commit on top of HEAD whose files under the
 * project root are the snapshot's. Paths the project ignores are left out,
 * and files the time machine never snapshots (ignored, .tmignore) keep
 * HEAD's version. Neither HEAD, the index nor the work tree changes.
 */
export async function branchSnapshot(repos: Repos, commit: string, name: string, message: string): Promise<BranchReport> {
  if (!(await repos.userSucceeds(['check-ref-format', '--branch', name]))) throw new Error(`Not a valid branch name: ${name}`)
  if (await repos.userSucceeds(['rev-parse', '--verify', '-q', `refs/heads/${name}`])) throw new Error(`Branch ${name} already exists`)
  const project = await openProject(repos)
  const all = await treeEntries(repos, commit, [])
  const { kept, skipped } = await dropIgnored(repos, project.prefix, all.map(entry => entry.path))
  const wanted = new Set(kept)
  const entries = all.filter(entry => wanted.has(entry.path)).map(entry => ({ ...entry, path: project.prefix + entry.path }))

  // What HEAD has under the root that the snapshot lacks: gone in the
  // snapshot unless the time machine never looks at it.
  const inHead = project.head === undefined ? [] : await userPaths(repos, project.head, project.prefix)
  const present = new Set(entries.map(entry => entry.path))
  const absent = inHead.filter(path => !present.has(path))
  const unseen = new Set(await shadowIgnores(repos, absent.map(path => path.slice(project.prefix.length))))
  const removed = absent.filter(path => !unseen.has(path.slice(project.prefix.length)))

  await copyObjects(repos, project, entries)
  const tree = await buildTree(repos, project, project.head ?? null, entries, removed)
  const made = await repos.user(['commit-tree', tree, ...(project.head ? ['-p', project.head] : [])], { stdin: message })
  await repos.user(['update-ref', '-m', 'time machine: branch', `refs/heads/${name}`, made, ZERO])
  return { commit: made, branch: name, files: entries.length, skipped }
}

type Project = { prefix: string; head: string | undefined; branch: string; objects: string; index: string }

async function openProject(repos: Repos): Promise<Project> {
  if (!(await repos.userSucceeds(['rev-parse', '--git-dir']))) throw new Error('This project is not a git repository')
  for (const marker of IN_PROGRESS) {
    if (await repos.exists(await gitPath(repos, marker))) throw new Error('A merge, rebase or cherry-pick is in progress; finish it first')
  }
  const head = (await repos.userSucceeds(['rev-parse', '--verify', '-q', 'HEAD'])) ? await repos.user(['rev-parse', 'HEAD']) : undefined
  const branch = (await repos.user(['symbolic-ref', '-q', '--short', 'HEAD'], { isLenient: true })) || 'detached HEAD'
  return {
    prefix: await repos.user(['rev-parse', '--show-prefix']),
    head,
    branch,
    objects: await gitPath(repos, 'objects'),
    index: await gitPath(repos, 'tm-export-index'),
  }
}

async function gitPath(repos: Repos, name: string): Promise<string> {
  return repos.user(['rev-parse', '--path-format=absolute', '--git-path', name])
}

/** Paths the project's .gitignore covers and git does not track there. */
async function dropIgnored(repos: Repos, prefix: string, paths: string[]): Promise<{ kept: string[]; skipped: string[] }> {
  if (paths.length === 0) return { kept: [], skipped: [] }
  const out = await repos.user(['check-ignore', '-z', '--stdin'], {
    stdin: paths.map(path => prefix + path).join('\0'),
    trim: false,
    isLenient: true,
  })
  const ignored = new Set(out.split('\0').filter(Boolean).map(path => path.slice(prefix.length)))
  return { kept: paths.filter(path => !ignored.has(path)), skipped: paths.filter(path => ignored.has(path)) }
}

/** The shadow repository's own ignore rules (.gitignore, .tmignore) on `paths`. */
async function shadowIgnores(repos: Repos, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const out = await repos.shadow(['check-ignore', '--no-index', '-z', '--stdin'], {
    stdin: paths.join('\0'),
    trim: false,
    isLenient: true,
  })
  return out.split('\0').filter(Boolean)
}

async function stagedAmong(repos: Repos, paths: string[]): Promise<string[]> {
  const staged: string[] = []
  for (const chunk of chunks(paths)) {
    const out = await repos.user(['diff', '--cached', '--name-only', '-z', '--', ...chunk], { trim: false, isLenient: true })
    staged.push(...out.split('\0').filter(Boolean))
  }
  return staged
}

async function userPaths(repos: Repos, commit: string, prefix: string): Promise<string[]> {
  const args = ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit]
  const out = await repos.user(prefix === '' ? args : [...args, '--', prefix], { trim: false })
  return out.split('\0').filter(Boolean)
}

/** `git ls-tree -r` entries of a shadow snapshot: all, or the named paths. */
async function treeEntries(repos: Repos, commit: string, paths: string[]): Promise<TreeEntry[]> {
  const args = ['ls-tree', '-r', '-z', '--full-tree', commit]
  const out = await repos.shadow(paths.length > 0 ? [...args, '--', ...paths] : args, { trim: false })
  return out
    .split('\0')
    .filter(Boolean)
    .map(line => {
      const [info = '', path = ''] = line.split('\t')
      const [mode = '', type = '', sha = ''] = info.split(' ')
      return { mode, type, sha, path }
    })
}

/** Copies the blobs the project's repository lacks, as one pack. */
async function copyObjects(repos: Repos, project: Project, entries: TreeEntry[]): Promise<void> {
  const blobs = [...new Set(entries.filter(entry => entry.type === 'blob').map(entry => entry.sha))]
  if (blobs.length === 0) return
  const checked = await repos.user(['cat-file', '--batch-check'], { stdin: `${blobs.join('\n')}\n`, trim: false })
  const missing = checked
    .split('\n')
    .filter(line => line.endsWith(' missing'))
    .map(line => line.split(' ')[0] ?? '')
  if (missing.length === 0) return
  await repos.shadow(['pack-objects', '-q', `${project.objects}/pack/pack`], { stdin: `${missing.join('\n')}\n` })
}

/** A tree: `base` with `entries` put in and `removed` taken out. */
async function buildTree(
  repos: Repos,
  project: Project,
  base: string | null,
  entries: TreeEntry[],
  removed: string[],
): Promise<string> {
  const index = project.index
  try {
    await repos.user(base === null ? ['read-tree', '--empty'] : ['read-tree', base], { index })
    for (const chunk of chunks(entries)) {
      const args = chunk.flatMap(entry => ['--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`])
      await repos.user(['update-index', '--add', ...args], { index })
    }
    for (const chunk of chunks(removed)) await repos.user(['update-index', '--force-remove', '--', ...chunk], { index })
    return await repos.user(['write-tree'], { index })
  } finally {
    await repos.remove(index)
  }
}
