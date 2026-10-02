// A throwaway project with a real history, to try every /tm command on.
//
//   npm run sandbox                  make it and print how to open Claude in it
//   npm run sandbox -- --run         also run every /tm command through `claude -p`
//   npm run sandbox -- --clean       delete it and its history
//   npm run sandbox -- <dir> [...]   put it in <dir> instead of <tmp>/tm-sandbox
//
// The history is written by the time machine itself, as Claude Code would:
// turns of Write, Edit and Bash steps, edits of yours between and during
// turns, a second session, an interrupted turn, a checkpoint and an undo.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TimeMachine } from '../src/index.ts'
import type { Entry } from '../types'
import { deps } from './deps.ts'

type Step =
  | { write: string; text: string }
  | { edit: string; change: (text: string) => string }
  | { bash: string; run: () => Promise<void> }
  | { yours: string; change: (text: string) => string }

type Check = { args: string; expect: RegExp }

const REPO = fileURLToPath(new URL('..', import.meta.url))
const COMMAND_TIMEOUT_MS = 120_000

const words = process.argv.slice(2)
const flags = new Set(words.filter(word => word.startsWith('--')))
const target = resolve(words.find(word => !word.startsWith('--')) ?? join(tmpdir(), 'tm-sandbox'))

const HOME = join(homedir(), '.claude', 'time-machine')

/** The mod's name for a project: the same digest hooks/register.tsx takes. */
function idOf(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

function historyOf(root: string): string {
  return join(HOME, `${idOf(root)}.git`)
}

async function clean(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await rm(historyOf(root), { recursive: true, force: true })
  await rm(join(HOME, 'heat', `${idOf(root)}.html`), { force: true })
}

async function sh(root: string, ...argv: string[]): Promise<string> {
  const result = await deps.exec(argv, { cwd: root })
  if (result.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
}

const INITIAL: Record<string, string> = {
  '.gitignore': 'node_modules/\n.env\n',
  '.env': 'API_KEY=dev\n',
  'package.json': '{\n  "name": "notes-app",\n  "version": "1.0.0"\n}\n',
  'README.md': '# Notes app\n\nA small app to keep notes.\n',
  'src/app.ts': "import { routes } from './routes'\nimport { db } from './db'\n\nexport const app = { routes, db }\n",
  'src/routes.ts': lines('// route', 20),
  'src/db.ts': lines('// db', 30),
  'src/legacy.ts': lines('// legacy', 40),
  'tests/app.test.ts': lines('// test', 10),
}

class Sandbox {
  readonly root: string
  readonly tm: TimeMachine
  private turns = 0

  constructor(root: string) {
    this.root = root
    this.tm = new TimeMachine(deps, root, historyOf(root))
  }

  async put(path: string, text: string): Promise<void> {
    await mkdir(dirname(join(this.root, path)), { recursive: true })
    await writeFile(join(this.root, path), text)
  }

  async read(path: string): Promise<string> {
    return readFile(join(this.root, path), 'utf8').catch(() => '')
  }

  async turn(
    prompt: string,
    steps: Step[],
    options: { session: string; isInterrupted?: boolean },
  ): Promise<Entry | undefined> {
    const id = `sandbox-turn-${++this.turns}`
    const { session } = options
    await this.tm.beginTurn(id, prompt, session)
    for (const step of steps) {
      if ('write' in step || 'edit' in step) {
        const path = 'write' in step ? step.write : step.edit
        const file = join(this.root, path)
        await this.tm.beforeFileWrite(file, session)
        await this.put(path, 'write' in step ? step.text : step.change(await this.read(path)))
        await this.tm.afterFileWrite(file, 'write' in step ? 'Write' : 'Edit', session)
      } else if ('bash' in step) {
        await this.tm.beforeCommand(session)
        await step.run()
        await this.tm.afterCommand(step.bash, session)
      } else {
        await this.put(step.yours, step.change(await this.read(step.yours)))
      }
    }
    return this.tm.finishTurn(id, session, options.isInterrupted === true, `Done: ${prompt}.`)
  }
}

async function seed(root: string): Promise<void> {
  await clean(root)
  await mkdir(root, { recursive: true })
  const real = await realpath(root)
  await sh(real, 'git', 'init', '-q', '-b', 'main')
  await sh(real, 'git', 'config', 'user.email', 'sandbox@example.com')
  await sh(real, 'git', 'config', 'user.name', 'Sandbox')
  const box = new Sandbox(real)
  for (const [path, text] of Object.entries(INITIAL)) await box.put(path, text)
  await sh(real, 'git', 'add', '-A')
  await sh(real, 'git', 'commit', '-qm', 'Initial notes app')
  await box.tm.init()

  const main = randomUUID()
  const docs = randomUUID()
  const append = (text: string) => (old: string) => old + text

  await box.turn(
    'Add a login form',
    [
      { write: 'src/login.ts', text: lines('// login', 25) },
      { edit: 'src/app.ts', change: append("import { login } from './login'\n") },
      { edit: 'src/routes.ts', change: append('// route /login\n') },
    ],
    { session: main },
  )
  await box.put('README.md', `${await box.read('README.md')}\n## Running\n\nnpm start\n`)

  await box.turn(
    'Rename db to store and drop the legacy module',
    [
      {
        bash: 'mv src/db.ts src/store.ts && rm src/legacy.ts',
        run: async () => {
          await box.put('src/store.ts', await box.read('src/db.ts'))
          await unlink(join(real, 'src/db.ts'))
          await unlink(join(real, 'src/legacy.ts'))
        },
      },
      { edit: 'src/app.ts', change: text => text.replaceAll('db', 'store') },
    ],
    { session: main },
  )

  await box.turn(
    'Generate the API client',
    [
      {
        bash: 'npm run codegen',
        run: async () => {
          for (const name of ['users', 'notes', 'tags', 'auth', 'search', 'files']) {
            await box.put(`src/api/generated/${name}.ts`, lines(`// ${name} client`, 60))
            await box.put(`src/api/generated/${name}.types.ts`, lines(`// ${name} types`, 30))
          }
        },
      },
    ],
    { session: main },
  )

  await box.turn(
    'Fix the login validation',
    [
      { edit: 'src/login.ts', change: append(lines('// validate', 8)) },
      { edit: 'src/login.ts', change: append(lines('// trim input', 3)) },
      { write: 'tests/login.test.ts', text: lines('// login test', 15) },
    ],
    { session: main },
  )
  await box.tm.save('before refactor', main)

  await box.turn(
    'Refactor the routes',
    [
      { edit: 'src/routes.ts', change: text => text.replace('// route 1\n', '// route 1 (refactored)\n') },
      { edit: 'src/app.ts', change: append('// routes refactored\n') },
    ],
    { session: main, isInterrupted: true },
  )

  await box.turn(
    'Write the user guide',
    [
      { write: 'docs/guide.md', text: lines('Guide line', 40) },
      { edit: 'README.md', change: append('\nSee docs/guide.md.\n') },
    ],
    { session: docs },
  )

  const config = await box.turn(
    'Move settings to a config file',
    [
      { edit: '.env', change: append('DEBUG=true\n') },
      { write: 'config/settings.json', text: '{\n  "debug": true\n}\n' },
    ],
    { session: main },
  )
  if (config) await box.tm.undo(config.id)

  await box.turn(
    'Rework the login once more',
    [
      { edit: 'src/login.ts', change: text => text.replace('// login 1\n', '// login 1 (reworked)\n') },
      { edit: 'src/app.ts', change: append('// login wired\n') },
    ],
    { session: main },
  )

  await box.turn(
    'Add rate limiting',
    [
      { edit: 'src/routes.ts', change: append(lines('// rate limit', 5)) },
      { yours: 'src/routes.ts', change: append('// a line you added while Claude worked\n') },
      {
        bash: 'npm run format',
        run: async () => box.put('src/app.ts', (await box.read('src/app.ts')).replaceAll("'", '"')),
      },
    ],
    { session: main },
  )
}

const CHECKS: Check[] = [
  { args: 'help', expect: /Usage: \/tm/ },
  { args: 'log', expect: /claude\s+Add rate limiting/ },
  { args: 'show 1', expect: /Steps:\n\s+1\.1 Edit src\/routes\.ts/ },
  { args: 'show 1.2', expect: /you · Changes outside Claude's tools[\s\S]+M src\/routes\.ts/ },
  { args: 'stats', expect: /\d+ snapshots, .+ mode auto/ },
  { args: 'git', expect: /git --git-dir=/ },
  { args: 'projects', expect: /tm-sandbox|\d+ projects?, / },
  { args: 'heat', expect: /Hottest files by Claude churn[\s\S]+src\/api\/generated\// },
  { args: 'heat rework', expect: /src\/login\.ts\s+back in \d+ later turns?/ },
  { args: 'heat undo', expect: /config\/settings\.json\s+1 undo/ },
  { args: 'heat owner', expect: /% Claude/ },
  { args: 'heat 30d', expect: /Hottest files/ },
  { args: 'heat open', expect: /heat map .*\/heat\/[0-9a-f]{16}\.html/ },
  { args: 'patch', expect: /Wrote .+\.patch/ },
  { args: 'save "sandbox check"', expect: /Saved checkpoint "sandbox check"/ },
  { args: 'undo', expect: /Restored 1 modified file\n.+Left alone, changed by someone else since: src\/routes\.ts/ },
  { args: 'redo', expect: /Redo "Add rate limiting":\n.+Restored 1 modified file/ },
  { args: 'undo 5.1', expect: /Undo step "Edit src\/login\.ts":\n.+Restored 1 modified file/ },
  { args: 'travel "before refactor"', expect: /Travelled to "before refactor"/ },
  { args: 'log 4', expect: /travel/ },
  { args: 'travel "sandbox check"', expect: /Travelled to "sandbox check"/ },
  { args: 'commit', expect: /Committed \d+ files? to main/ },
  { args: 'branch 3 sandbox-snapshot', expect: /Created branch sandbox-snapshot/ },
  { args: 'retain 30d', expect: /pruned once a day/ },
  { args: 'retain off', expect: /Automatic pruning off/ },
  { args: 'prune 500', expect: /Nothing to prune|Pruned/ },
  { args: 'manual', expect: /manual/ },
  { args: 'off', expect: /off for this project/ },
  { args: 'on', expect: /every turn is snapshotted/ },
]

async function claude(root: string, args: string): Promise<{ output: string; exitCode: number }> {
  const result = await deps.exec(['claude', '-p', '--plugin-dir', REPO, `/tm ${args}`], {
    cwd: root,
    timeoutMs: COMMAND_TIMEOUT_MS,
  })
  return { output: `${result.stdout}${result.stderr}`.trim(), exitCode: result.exitCode }
}

async function runChecks(root: string): Promise<number> {
  let failed = 0
  for (const check of CHECKS) {
    const { output, exitCode } = await claude(root, check.args)
    const patch = /Wrote (\S+\.patch)/.exec(output)?.[1]
    if (patch?.startsWith(HOME)) await rm(patch, { force: true })
    const isPassed = exitCode === 0 && check.expect.test(output) && !/Time machine: /.test(output)
    if (!isPassed) failed++
    console.log(`\n${isPassed ? '✓' : '✗'} /tm ${check.args}`)
    console.log(output.replace(/^/gm, '  '))
    if (!isPassed) console.log(`  expected ${check.expect}${exitCode === 0 ? '' : `, exit ${exitCode}`}`)
  }
  console.log(`\n${CHECKS.length - failed} of ${CHECKS.length} commands passed.`)
  return failed
}

if (flags.has('--clean')) {
  await clean(await realpath(target).catch(() => target))
  console.log(`Removed ${target} and its history.`)
} else {
  await seed(target)
  const root = await realpath(target)
  console.log(`Sandbox ready: ${root}`)
  console.log(`Try it:  cd ${root} && claude --plugin-dir ${REPO}`)
  if (flags.has('--run')) process.exitCode = (await runChecks(root)) > 0 ? 1 : 0
}
