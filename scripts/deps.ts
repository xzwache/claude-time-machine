// The two functions the time machine runs with, for scripts under Node.

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Deps, ExecResult } from '../src/index.ts'

export const deps: Deps = {
  exec: (argv, init) =>
    new Promise<ExecResult>(resolve => {
      const child = execFile(
        argv[0] ?? '',
        argv.slice(1),
        {
          cwd: init.cwd,
          env: { ...process.env, ...init.env },
          maxBuffer: 256 * 1024 * 1024,
          encoding: 'utf8',
          timeout: init.timeoutMs,
        },
        (error, stdout, stderr) =>
          resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
      )
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(init.stdin ?? '')
    }),
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  },
}
