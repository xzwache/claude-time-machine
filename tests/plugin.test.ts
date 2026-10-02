// Tests of the mod inside the engine (`claude plugin test .`). The engine's
// test sandbox has no processes, so git is answered by a fake here; the real
// git behaviour is covered by tests/core.spec.ts.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'time-machine',
  component: 'Pane',
  requestId: 'time-machine',
  props: {
    title: 'Time machine',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// One turn as `git log` prints it with the format hooks/core.ts asks for.
const LOG = [
  '\x1e', ['a1b2c3d4e5f6', 'ffffffffffff', '0', 'add login form\n\ntm-kind: turn\n\nadd login form\n', ''].join('\x1f'),
  '\nA\tsrc/login.ts\nM\tsrc/app.ts\nM\tsrc/routes.ts\n',
].join('')

/** Answers every git call with success, `git log` with LOG; records the calls. */
function fakeHost(on: On, log = ''): string[][] {
  const calls: string[][] = []
  mock.env(on, { HOME: '/home/tester' })
  on('session.root', () => ({ value: '/work/project' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    const stdout = e.argv.includes('log') ? log : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return calls
}

describe('the /tm command', () => {
  test('keeps the shadow repository under ~/.claude/time-machine, never in the project', async ($, on) => {
    const calls = fakeHost(on)
    const ran = await $.command.run({ command: 'tm', args: 'help' })
    expect(ran.text).toMatch(/Usage: \/tm/)
    const init = calls.find(argv => argv.includes('init'))
    expect(init?.at(-1)).toMatch(/^\/home\/tester\/\.claude\/time-machine\/[0-9a-f]{16}\.git$/)
  })

  test('says so when there is nothing to undo', async ($, on) => {
    fakeHost(on)
    const ran = await $.command.run({ command: 'tm', args: 'undo' })
    expect(ran.text).toBe('No Claude turn to undo yet.')
  })
})

describe('the pane', () => {
  test('draws an empty timeline on every surface', async ($, on) => {
    fakeHost(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /No snapshots yet/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('lists snapshots with their change counts', async ($, on) => {
    fakeHost(on, LOG)
    const ran = await $.command.run({ command: 'tm', args: 'log' })
    expect(ran.text).toMatch(/1\. \d\d:\d\d claude\s+add login form\s+\+1 ~2/)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ key: 'e-0', text: /add login form/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
