// How the time machine runs git: the two functions it is given, and the
// settings pinned on every call so a snapshot and a restore are byte-exact.

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

// Settings that would make a snapshot or a restore differ from the bytes on
// disk, or make git do more than it is asked, are pinned for every call.
export const GIT_FLAGS = [
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
export const ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n'

const CHUNK = 100

export class GitError extends Error {
  constructor(argv: readonly string[], result: ExecResult) {
    super(`git ${argv.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`)
  }
}

/** Splits a long path list so no single command line grows unbounded. */
export function chunks<T>(list: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}

/** Bytes a directory takes on disk, as `du` counts them. */
export async function diskUsage(exec: Exec, path: string): Promise<number> {
  const result = await exec(['du', '-sk', path], {})
  return (Number(result.stdout.split('\t')[0]) || 0) * 1024
}
