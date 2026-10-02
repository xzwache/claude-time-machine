// Which shell commands cannot change the work tree, so the snapshots around
// them can be skipped. A command judged read-only by mistake loses nothing:
// what it changed is recorded by the next snapshot, attributed to that step.

const READ_ONLY = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'wc',
  'pwd',
  'echo',
  'printf',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'diff',
  'cmp',
  'uniq',
  'cut',
  'tr',
  'jq',
  'date',
  'printenv',
  'uname',
  'whoami',
  'id',
  'hostname',
  'ps',
  'true',
  'false',
  'test',
  '[',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'nl',
  'column',
  'less',
  'more',
  'cd',
  'sleep',
  'seq',
  'expr',
  'od',
  'xxd',
  'hexdump',
])

// git subcommands that write only inside .git (refs, config), if anywhere:
// never the work tree a snapshot reads.
const GIT_READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'blame',
  'grep',
  'remote',
  'describe',
  'tag',
  'fetch',
  'shortlog',
  'reflog',
  'cat-file',
  'rev-list',
  'count-objects',
  'config',
  'show-ref',
  'for-each-ref',
  'merge-base',
  'name-rev',
  'whatchanged',
  'version',
  'help',
])

// Redirections that write nowhere a snapshot sees.
const HARMLESS_REDIRECT = /\d?>&\d|&?\d?>{1,2}\s*\/dev\/null/g

/** True when every part of `command` is on the read-only list. */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.replace(HARMLESS_REDIRECT, ' ')
  if (/[>`]|\$\(|<\(|>\(/.test(text)) return false
  const segments = text
    .split(/\|\||&&|[|;&\n]/)
    .map(segment => segment.trim())
    .filter(Boolean)
  return segments.length > 0 && segments.every(isReadOnlySegment)
}

function isReadOnlySegment(segment: string): boolean {
  const words = segment.split(/\s+/).filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  const [program = '', ...args] = words
  const name = program.replace(/^.*\//, '')
  if (name === 'git') return isReadOnlyGit(args)
  if (name === 'sed') return !args.some(arg => /^(-[a-zA-Z]*i|--in-place)/.test(arg))
  if (name === 'find') {
    return !args.some(arg => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))
  }
  if (name === 'sort') return !args.some(arg => /^(-o|--output)/.test(arg))
  if (name === 'awk' || name === 'gawk') return !/system|print\s*>|getline/.test(segment)
  return READ_ONLY.has(name)
}

function isReadOnlyGit(args: string[]): boolean {
  const sub = args.find(arg => !arg.startsWith('-'))
  return sub !== undefined && GIT_READ_ONLY.has(sub)
}
