// Tests of the time machine against real git and a real file system.
// Run with `npm test` (Node 22+, type stripping).

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { TimeMachine } from '../hooks/core.ts'
import type { Deps, ExecResult } from '../hooks/core.ts'

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
let tm: TimeMachine
let turns = 0

async function sh(...argv: string[]): Promise<string> {
  const result = await deps.exec(argv, { cwd: root })
  assert.equal(result.exitCode, 0, `${argv.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const file = (path: string) => join(root, path)
const read = (path: string) => readFile(file(path), 'utf8')
const exists = (path: string) => stat(file(path)).then(() => true, () => false)

async function put(path: string, text: string | Uint8Array): Promise<void> {
  await mkdir(join(file(path), '..'), { recursive: true })
  await writeFile(file(path), text)
}

/** Runs `work` as one Claude turn and returns the recorded entry. */
async function turn(prompt: string, work: () => Promise<void>) {
  const id = `turn-${++turns}`
  await tm.beginTurn(id, prompt)
  await work()
  return tm.finishTurn(id, false)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm-project-'))
  const store = await mkdtemp(join(tmpdir(), 'tm-store-'))
  sandboxes.push(root, store)
  await sh('git', 'init', '-q')
  await sh('git', 'config', 'user.email', 'test@example.com')
  await sh('git', 'config', 'user.name', 'Test')
  await put('.gitignore', '.env\nbuild/\n')
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
  test('an ignored file a file tool edits is captured and restored', async () => {
    await put('.env', 'SECRET=old\n')
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'edit env')
    await tm.beforeFileWrite(file('.env'))
    await put('.env', 'SECRET=new\n')
    await tm.afterFileWrite(file('.env'))
    const entry = await tm.finishTurn(id, false)
    assert.ok(entry)
    assert.deepEqual(await tm.changes(entry.id), [{ status: 'modified', path: '.env' }])
    await tm.undo(entry.id)
    assert.equal(await read('.env'), 'SECRET=old\n')
  })

  test('an ignored file a file tool creates is removed on undo', async () => {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'create env')
    await tm.beforeFileWrite(file('.env'))
    await put('.env', 'NEW=1\n')
    await tm.afterFileWrite(file('.env'))
    const entry = await tm.finishTurn(id, false)
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.equal(await exists('.env'), false)
  })

  test('ignored files nobody named are neither snapshotted nor touched', async () => {
    await put('build/out.js', 'built\n')
    const entry = await turn('build', async () => {
      await put('build/out.js', 'rebuilt\n')
      await put('src/user.ts', 'changed\n')
    })
    assert.ok(entry)
    await tm.undo(entry.id)
    assert.equal(await read('build/out.js'), 'rebuilt\n')
    assert.equal(await read('src/user.ts'), 'user\n')
  })
})

describe('history and travel', () => {
  test('records outside changes, turns and undos in order, without empty turns', async () => {
    await put('src/auth.ts', 'mine\n')
    const entry = await turn('first prompt\nmore text', () => put('src/user.ts', 'v2\n'))
    await turn('a question with no edits', async () => {})
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
    await tm.beginTurn('crashed', 'never finished')
    await put('src/user.ts', 'half done\n')
    const next = await turn('next', () => put('src/auth.ts', 'next\n'))
    assert.ok(next)
    const history = await tm.history()
    const crashed = history.find(one => one.title === 'never finished')
    assert.ok(crashed?.isInterrupted)
    assert.deepEqual(await tm.changes(crashed.id), [{ status: 'modified', path: 'src/user.ts' }])
  })

  test('shows a per-file unified diff', async () => {
    const entry = await turn('diff', () => put('src/user.ts', 'user\nadded\n'))
    assert.ok(entry)
    const diff = await tm.fileDiff(entry.id, 'src/user.ts')
    assert.match(diff, /^\+added$/m)
  })

  test('finishTurn ignores a turn id it did not start (subagents)', async () => {
    await tm.beginTurn('main', 'main')
    assert.equal(await tm.finishTurn('subagent', false), undefined)
    await put('src/user.ts', 'x\n')
    assert.ok(await tm.finishTurn('main', false))
  })
})
