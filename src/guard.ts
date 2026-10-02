// The command guard: shell commands whose effects the time machine cannot take
// back, because they reach past the project's files. A force push, a delete
// outside the project, a script piped from the network into a shell, a
// publish, a change to cloud infrastructure or a database. A command that only
// changes the project's files is left alone: undo covers it.

export type GuardRule =
  | 'delete-root'
  | 'disk'
  | 'delete-outside'
  | 'force-push'
  | 'remote-delete'
  | 'history-rewrite'
  | 'clean-ignored'
  | 'pipe-to-shell'
  | 'privilege'
  | 'publish'
  | 'infra'
  | 'database'
  | 'docker-prune'
  | 'persistence'

export type GuardHit = { rule: GuardRule; reason: string }

/** `ask` puts a risky command to the person, `warn` only says so, `off` stays out of the way. */
export type GuardMode = 'ask' | 'warn' | 'off'

/** A project's guard: its mode and the rules the person allowed for good. */
export type Guard = { mode: GuardMode; allowed: GuardRule[] }

export type GuardPlace = { root: string; home: string; temp: readonly string[] }

/** Refused outright; the person can still run them themselves. */
export const BLOCKED: ReadonlySet<GuardRule> = new Set(['delete-root', 'disk'])

export const GUARD_RULES: Readonly<Record<GuardRule, string>> = {
  'delete-root': 'deletes the file system root or your home folder',
  disk: 'writes to a disk device directly',
  'delete-outside': 'deletes the project itself or files outside it, which undo cannot bring back',
  'force-push': 'force-pushes, rewriting history on the remote',
  'remote-delete': 'deletes a branch or tag on the remote',
  'history-rewrite': "rewrites the repository's history",
  'clean-ignored': 'deletes ignored files, which snapshots do not keep',
  'pipe-to-shell': 'runs a script downloaded from the network',
  privilege: 'runs with root privileges',
  publish: 'publishes a package or an image',
  infra: 'changes cloud infrastructure',
  database: 'drops or wipes database data',
  'docker-prune': 'deletes Docker volumes or everything unused',
  persistence: 'changes your shell profile, SSH keys, scheduled jobs or system services',
}

const RULE_ORDER = Object.keys(GUARD_RULES) as GuardRule[]

export function isGuardRule(value: unknown): value is GuardRule {
  return typeof value === 'string' && (RULE_ORDER as string[]).includes(value)
}

type Command = { words: string[]; redirects: string[] }

/** What `command` would do that undo cannot take back, in the order of `GUARD_RULES`: the blocked ones first. */
export function checkCommand(command: string, place: GuardPlace): GuardHit[] {
  const found = new Map<GuardRule, GuardHit>()
  const hit = (rule: GuardRule) => {
    if (!found.has(rule)) found.set(rule, { rule, reason: GUARD_RULES[rule] })
  }
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) hit('disk')
  if (/\b(ba|z|da|k)?sh\b[^|;&]*<\(\s*(curl|wget)\b/.test(command)) hit('pipe-to-shell')
  let cwd = place.root
  for (const pipeline of parse(command)) {
    let fetched = false
    for (const raw of pipeline) {
      const { words, redirects } = unwrap(raw, hit)
      const [program = '', ...args] = words
      const name = program.replace(/^.*\//, '')
      if (name === 'cd') {
        cwd = resolvePath(args[0] ?? '~', cwd, place.home)
        continue
      }
      if (fetched && /^(ba|z|da|k)?sh$|^(python3?|node|perl|ruby)$/.test(name)) hit('pipe-to-shell')
      if (name === 'curl' || name === 'wget') fetched = true
      for (const target of redirects) checkWrite(resolvePath(target, cwd, place.home), place, hit)
      checkProgram(name, args, cwd, place, hit)
    }
  }
  return RULE_ORDER.flatMap(rule => found.get(rule) ?? [])
}

/** Strips `sudo`, `env X=1`, `nohup` and the like; checks a `bash -c` script on its own. */
function unwrap(command: Command, hit: (rule: GuardRule) => void): Command {
  let words = command.words
  for (;;) {
    while (words[0] !== undefined && isAssignment(words[0])) words = words.slice(1)
    const name = (words[0] ?? '').replace(/^.*\//, '')
    if (name === 'sudo' || name === 'doas' || name === 'su') {
      hit('privilege')
      if (name === 'su') return { words: [], redirects: command.redirects }
      words = skipOptions(words.slice(1), /^-[ugCDhpr]$/)
    } else if (['env', 'nohup', 'nice', 'time', 'command', 'exec', 'timeout', 'xargs'].includes(name)) {
      words = skipOptions(words.slice(1), /^-[nus]$/)
      if (name === 'timeout' && words[0] !== undefined && /^\d/.test(words[0])) words = words.slice(1)
    } else {
      return { words, redirects: command.redirects }
    }
  }
}

function skipOptions(words: string[], takesValue: RegExp): string[] {
  let i = 0
  while (i < words.length && (words[i] ?? '').startsWith('-')) i += takesValue.test(words[i] ?? '') ? 2 : 1
  return words.slice(i)
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

function checkProgram(
  name: string,
  args: string[],
  cwd: string,
  place: GuardPlace,
  hit: (rule: GuardRule) => void,
): void {
  const operands = args.filter(arg => !arg.startsWith('-'))
  const first = operands[0] ?? ''
  const has = (...words: string[]) => args.some(arg => words.includes(arg))

  if (name === 'rm') {
    if (has('--no-preserve-root')) hit('delete-root')
    for (const target of operands) checkDelete(resolvePath(target, cwd, place.home), place, hit)
  } else if (/^mkfs(\.|$)/.test(name) || (name === 'dd' && args.some(arg => /^of=\/dev\//.test(arg)))) {
    hit('disk')
  } else if (name === 'git') {
    checkGit(args, hit)
  } else if ((name === 'bash' || name === 'sh' || name === 'zsh') && args[0] === '-c' && args[1] !== undefined) {
    if (/^\s*\$\(\s*(curl|wget)\b/.test(args[1])) hit('pipe-to-shell')
    for (const found of checkCommand(args[1], { ...place, root: cwd })) hit(found.rule)
  } else if (['npm', 'yarn', 'pnpm', 'bun', 'cargo', 'poetry', 'vsce', 'ovsx'].includes(name) && first === 'publish') {
    if (!has('--dry-run')) hit('publish')
  } else if ((name === 'twine' && first === 'upload') || (name === 'gem' && first === 'push')) {
    hit('publish')
  } else if ((name === 'docker' || name === 'podman') && ['push', 'system', 'volume'].includes(first)) {
    if (first === 'push') hit('publish')
    else if (
      (first === 'system' && operands[1] === 'prune') ||
      (first === 'volume' && /^(rm|prune)$/.test(operands[1] ?? ''))
    ) {
      hit('docker-prune')
    }
  } else if ((name === 'terraform' || name === 'tofu') && /^(apply|destroy|import)$/.test(first)) {
    hit('infra')
  } else if (
    (name === 'terraform' || name === 'tofu') &&
    first === 'state' &&
    /^(rm|mv|push)$/.test(operands[1] ?? '')
  ) {
    hit('infra')
  } else if (name === 'pulumi' && /^(up|destroy|refresh)$/.test(first)) {
    hit('infra')
  } else if (name === 'kubectl' && /^(apply|delete|replace|drain|patch|scale|rollout)$/.test(first)) {
    hit('infra')
  } else if (name === 'helm' && /^(install|upgrade|uninstall|delete|rollback)$/.test(first)) {
    hit('infra')
  } else if (['aws', 'gcloud', 'az', 'doctl', 'flyctl', 'heroku'].includes(name)) {
    if (operands.some(arg => /^(delete|remove|rm|terminate|destroy|purge|deploy)(-|$)/.test(arg))) hit('infra')
  } else if (
    ['psql', 'mysql', 'mariadb', 'sqlite3', 'mongosh', 'mongo', 'redis-cli', 'clickhouse-client'].includes(name)
  ) {
    if (
      /\b(drop|truncate)\s+(table|database|schema|collection)\b|\bflushall\b|\bflushdb\b|dropDatabase\(/i.test(
        args.join(' '),
      )
    ) {
      hit('database')
    }
  } else if (name === 'dropdb') {
    hit('database')
  } else if (
    /^(prisma|npx|bunx|pnpx)$/.test(name) &&
    /\bmigrate reset\b|--force-reset|--accept-data-loss/.test(args.join(' '))
  ) {
    hit('database')
  } else if ((name === 'rails' || name === 'rake') && /^db:(drop|reset|schema:load|purge)/.test(first)) {
    hit('database')
  } else if (/^python3?$/.test(name) && /manage\.py\s+(flush|reset_db)\b/.test(args.join(' '))) {
    hit('database')
  } else if (name === 'crontab' && !has('-l')) {
    hit('persistence')
  } else if (name === 'launchctl' && /^(load|bootstrap|enable)$/.test(first)) {
    hit('persistence')
  } else if (name === 'systemctl' && operands.some(arg => /^(enable|link|edit|mask)$/.test(arg))) {
    hit('persistence')
  } else if (name === 'tee' || name === 'cp' || name === 'mv' || name === 'ln' || name === 'install') {
    const targets = name === 'tee' ? operands : operands.slice(-1)
    for (const target of targets) checkWrite(resolvePath(target, cwd, place.home), place, hit)
    if (name === 'mv')
      for (const source of operands.slice(0, -1)) checkDelete(resolvePath(source, cwd, place.home), place, hit)
  }
}

function checkGit(args: string[], hit: (rule: GuardRule) => void): void {
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) i += /^-[Cc]$/.test(args[i] ?? '') ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === 'push') {
    const refspecs = rest.filter(arg => !arg.startsWith('-')).slice(1)
    if (
      rest.some(
        arg =>
          /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror)$/.test(arg) || /^-[a-zA-Z]*f/.test(arg),
      )
    ) {
      hit('force-push')
    }
    if (refspecs.some(spec => spec.startsWith('+'))) hit('force-push')
    if (rest.some(arg => arg === '--delete' || arg === '-d') || refspecs.some(spec => spec.startsWith(':'))) {
      hit('remote-delete')
    }
  } else if (sub === 'clean' && rest.some(arg => /^-[a-zA-Z]*[xX]/.test(arg))) {
    hit('clean-ignored')
  } else if (sub === 'filter-branch' || sub === 'filter-repo') {
    hit('history-rewrite')
  }
}

const PROFILE =
  /^(\.(bash|zsh)rc|\.(bash_)?profile|\.zprofile|\.zshenv|\.bash_login|\.config\/fish\/config\.fish|\.ssh\/.*)$/

function checkWrite(path: string, place: GuardPlace, hit: (rule: GuardRule) => void): void {
  if (/^\/dev\/(sd|nvme|disk|hd|xvd|mmcblk)/.test(path)) hit('disk')
  else if (path.startsWith('/etc/') || (isUnder(path, place.home) && PROFILE.test(path.slice(place.home.length + 1)))) {
    hit('persistence')
  }
}

/** Deleting the home folder or above is blocked; the project itself, its parents or anything outside it, asked. */
function checkDelete(path: string, place: GuardPlace, hit: (rule: GuardRule) => void): void {
  const bare = path.replace(/\/\*?$/, '') || '/'
  if (bare === '/' || isUnder(place.home, bare)) hit('delete-root')
  else if (isUnder(place.root, bare) || isOutside(path, place)) hit('delete-outside')
}

function isOutside(path: string, place: GuardPlace): boolean {
  return !isUnder(path, place.root) && !place.temp.some(temp => isUnder(path, temp))
}

function isUnder(path: string, dir: string): boolean {
  const base = dir.replace(/\/+$/, '')
  return path === base || path.startsWith(`${base}/`)
}

/** An absolute, normalized path for `word` as the shell would see it from `cwd`. */
export function resolvePath(word: string, cwd: string, home: string): string {
  const expanded = word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home)
  const absolute = expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/**
 * Splits a command line into pipelines of simple commands, as far as a guard
 * needs: quotes and escapes, `&&`, `||`, `;`, `&`, `|`, newlines, and the
 * targets of `>` and `>>`. Expansions are left as written.
 */
export function parse(command: string): Command[][] {
  const pipelines: Command[][] = []
  let pipeline: Command[] = []
  let current: Command = { words: [], redirects: [] }
  let word = ''
  let isWord = false
  let isRedirect = false
  const endWord = () => {
    if (!isWord) return
    if (isRedirect) current.redirects.push(word)
    else current.words.push(word)
    word = ''
    isWord = false
    isRedirect = false
  }
  const endCommand = () => {
    endWord()
    if (current.words.length > 0 || current.redirects.length > 0) pipeline.push(current)
    current = { words: [], redirects: [] }
  }
  const endPipeline = () => {
    endCommand()
    if (pipeline.length > 0) pipelines.push(pipeline)
    pipeline = []
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (char === "'") {
      const end = command.indexOf("'", i + 1)
      word += command.slice(i + 1, end < 0 ? undefined : end)
      isWord = true
      i = end < 0 ? command.length : end
    } else if (char === '"') {
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < command.length) j++
        word += command[j] ?? ''
      }
      isWord = true
      i = j
    } else if (char === '\\') {
      word += next
      isWord = true
      i++
    } else if (char === '&' && next === '>') {
      endWord()
      isRedirect = true
      i += command[i + 2] === '>' ? 2 : 1
    } else if (char === '|' && next === '|') {
      endPipeline()
      i++
    } else if (char === '&' && next === '&') {
      endPipeline()
      i++
    } else if (char === '|') {
      endCommand()
    } else if (char === ';' || char === '\n' || char === '&') {
      endPipeline()
    } else if (char === '>' || (/\d/.test(char) && next === '>' && !isWord)) {
      const at = char === '>' ? i : i + 1
      const isAppend = command[at + 1] === '>'
      if (command[at + (isAppend ? 2 : 1)] === '&') {
        i = at + (isAppend ? 2 : 1) + 1
        while (/\d|-/.test(command[i] ?? '')) i++
        i--
        continue
      }
      endWord()
      isRedirect = true
      i = at + (isAppend ? 1 : 0)
    } else if (char === '<') {
      endWord()
    } else if (/\s/.test(char)) {
      const wasRedirect = isRedirect && !isWord
      endWord()
      if (wasRedirect) isRedirect = true
    } else {
      word += char
      isWord = true
    }
  }
  endPipeline()
  return pipelines
}
