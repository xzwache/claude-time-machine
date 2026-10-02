// Times the time machine on a real project: node scripts/bench.ts <project>
// Uses a throwaway shadow repository; the project's files are touched only to
// append one line to one file and put it back.

import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TimeMachine } from '../src/index.ts'
import type { Deps, ExecResult } from '../src/index.ts'

const deps: Deps = {
  exec: (argv, init) =>
    new Promise<ExecResult>(resolve => {
      const child = execFile(
        argv[0] ?? '',
        argv.slice(1),
        { cwd: init.cwd, env: { ...process.env, ...init.env }, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) =>
          resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
      )
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(init.stdin ?? '')
    }),
  writeFile: async (path, text) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text)
  },
}

const root = process.argv[2]
const target = process.argv[3]
if (!root || !target) throw new Error('usage: node scripts/bench.ts <project> <a file in it to touch>')

async function time<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  const result = await work()
  console.log(`${label.padEnd(40)} ${(performance.now() - started).toFixed(0).padStart(6)} ms`)
  return result
}

async function du(path: string): Promise<string> {
  return (await deps.exec(['du', '-sh', path], {})).stdout.split('\t')[0] ?? '?'
}

const store = await mkdtemp(join(tmpdir(), 'tm-bench-'))
const tm = new TimeMachine(deps, root, join(store, 'shadow.git'))
const file = join(root, target)
const original = await readFile(file)
try {
  const files = (await deps.exec(['git', 'ls-files'], { cwd: root })).stdout.split('\n').length - 1
  console.log(`project: ${root} (${files} tracked files)`)
  await time('first snapshot (baseline)', () => tm.init())
  console.log(`shadow repository after baseline: ${await du(join(store, 'shadow.git'))}`)
  // maintain() lets gc run in the background; time it here in the foreground.
  const shadow = ['git', `--git-dir=${join(store, 'shadow.git')}`]
  await time('pack (gc, foreground)', () =>
    deps.exec([...shadow, '-c', 'gc.autoDetach=false', '-c', 'gc.auto=1000', 'gc', '--auto', '-q'], {}),
  )
  console.log(`shadow repository after packing:  ${await du(join(store, 'shadow.git'))}`)
  await time('turn start, nothing changed', () => tm.beginTurn('t1', 'bench', 's'))
  await time('Bash before (snapshot)', () => tm.beforeCommand('s'))
  await appendFile(file, '\n// bench\n')
  await time('Bash after (snapshot + step)', () => tm.afterCommand('bench edit', 's'))
  await time('Edit before + after (one file)', async () => {
    await tm.beforeFileWrite(file, 's')
    await appendFile(file, '// edit\n')
    await tm.afterFileWrite(file, 'Edit', 's')
  })
  const entry = await time('turn end', () => tm.finishTurn('t1', 's', false))
  await time('history (40 entries)', () => tm.history(40))
  if (entry) await time('undo the turn', () => tm.undo(entry.id))
} finally {
  await writeFile(file, original)
  await rm(store, { recursive: true, force: true })
}
