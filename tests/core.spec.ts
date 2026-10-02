// Tests of the time machine against real git and a real file system.
// Run with `npm test` (Node 22+, type stripping).

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { TimeMachine, deleteProject, listProjects } from '../src/index.ts'
import type { Deps, ExecResult } from '../src/index.ts'

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
const exists = (path: string) => stat(file(path)).then(() => true, () => false)

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

describe('steps and other writers', () => {
  test('a turn is made of steps, and one step can be undone alone', async () => {
    const id = `turn-${++turns}`
    await tm.beginTurn(id, 'two steps', SESSION)
    await write('src/user.ts', 'step one\n')
    await bash(() => put('src/auth.ts', 'step two\n'), SESSION, 'sed -i auth')
    const entry = await tm.finishTurn(id, SESSION, false)
    assert.ok(entry)
    const steps = await tm.steps(entry.id)
    assert.deepEqual(steps.map(step => step.title), ['Write src/user.ts', 'Bash: sed -i auth'])
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

describe('prune and projects', () => {
  test('keeps the newest entries, and they can still be undone', async () => {
    await turn('one', () => put('src/user.ts', 'one\n'))
    await turn('two', () => put('src/user.ts', 'two\n'))
    const three = await turn('three', () => put('src/user.ts', 'three\n'))
    assert.ok(three)
    const report = await tm.prune({ keepLast: 1 })
    assert.ok(report.removed > 0)
    const history = await tm.history()
    assert.deepEqual(history.map(entry => entry.kind), ['turn', 'baseline'])
    assert.match(history[1]?.title ?? '', /pruned/)
    await tm.undo(history[0]?.id ?? '')
    assert.equal(await read('src/user.ts'), 'two\n')
  })

  test('prunes by age', async () => {
    await turn('old', () => put('src/user.ts', 'old\n'))
    const report = await tm.prune({ olderThanMs: 0 })
    assert.ok(report.removed > 0)
    assert.deepEqual((await tm.history()).map(entry => entry.kind), ['baseline'])
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
    assert.deepEqual(
      (await sh('git', 'show', '--name-status', '--format=', 'HEAD')).trim().split('\n').sort(),
      ['A\tsrc/token.ts', 'D\tsrc/legacy.ts', 'M\tsrc/user.ts'],
    )
    assert.deepEqual(report.committed.sort(), ['src/legacy.ts', 'src/token.ts', 'src/user.ts'])
    // Only the person's own edit is left over, unstaged; the work tree is untouched.
    assert.equal(await sh('git', 'status', '--porcelain'), ' M src/auth.ts\n')
    assert.equal(await read('src/auth.ts'), 'A\nmine, uncommitted\n')
  })

  test('/tm commit skips files the project ignores', async () => {
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
