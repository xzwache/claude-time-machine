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

// One commit as `git log` and `git diff-tree --stdin` print it for hooks/core.ts.
const ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const LOG = `\x1e${[ID, 'f'.repeat(40), '0', 'add login form\n\ntm-kind: outside\n'].join('\x1f')}`
const DIFF = [ID, 'A', 'src/login.ts', 'M', 'src/app.ts', 'M', 'src/routes.ts', ''].join('\0')

/** `/tm <args>` as the person typing it in the composer would run it. */
function typed(args: string) {
  return {
    command: 'tm',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: false, columns: 80 },
  }
}

/** Answers every command with success and `answers[argv]` or nothing; records the calls. */
function fakeHost(on: On, given: Record<string, string> = {}, isGit = true, root = '/work/project'): string[][] {
  const calls: string[][] = []
  const answers: Record<string, string> = { '--is-inside-work-tree': isGit ? 'true\n' : '', ...given }
  on('fs.exists', () => ({ value: false }))
  mock.env(on, { HOME: '/home/tester' })
  mock.store(on)
  on('session.root', () => ({ value: root }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const key = Object.keys(answers).find(word => e.argv.includes(word))
    const stdout = key === undefined ? '' : (answers[key] ?? '')
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return calls
}

describe('the /tm command', () => {
  test('keeps the shadow repository under ~/.claude/time-machine, never in the project', async ($, on) => {
    const calls = fakeHost(on)
    expect((await $.command.run(typed('help'))).text).toMatch(/Usage: \/tm/)
    expect(calls.some(argv => argv.includes('init'))).toBe(false)
    await $.command.run(typed('log'))
    const init = calls.find(argv => argv.includes('init'))
    expect(init?.at(-1)).toMatch(/^\/home\/tester\/\.claude\/time-machine\/[0-9a-f]{16}\.git$/)
  })

  test('says so when there is nothing to undo', async ($, on) => {
    fakeHost(on)
    const ran = await $.command.run(typed('undo'))
    expect(ran.text).toBe('No Claude turn to undo yet.')
  })
})

describe('managing histories', () => {
  test('/tm projects lists every project with a history', async ($, on) => {
    fakeHost(on, {
      ls: '0123456789abcdef.git\nnot-a-history\n',
      'tm.root': '/work/project\n',
      '--count': '12\n',
      du: '2048\t/x\n',
    })
    const ran = await $.command.run(typed('projects'))
    expect(ran.text).toMatch(/1\. +\/work\/project {2}12 snapshots, 2\.0 MB/)
    expect(ran.text).toMatch(/1 project, 2\.0 MB/)
  })

  test('/tm projects rm asks before deleting', async ($, on) => {
    const calls = fakeHost(on, { ls: '0123456789abcdef.git\n', 'tm.root': '/work/project\n' })
    const ran = await $.command.run(typed('projects rm 1'))
    expect(ran.text).toMatch(/--yes to confirm/)
    expect(calls.some(argv => argv[0] === 'rm')).toBe(false)
  })

  test('/tm prune explains its argument', async ($, on) => {
    fakeHost(on)
    const ran = await $.command.run(typed('prune'))
    expect(ran.text).toMatch(/Usage: \/tm prune 30d/)
  })
})

describe('taking snapshots out', () => {
  test('/tm branch and /tm retain explain their arguments', async ($, on) => {
    fakeHost(on)
    expect((await $.command.run(typed('branch 1'))).text).toMatch(/Usage: \/tm branch N name/)
    expect((await $.command.run(typed('retain'))).text).toMatch(/Usage: \/tm retain 30d \| off\. Now: off/)
  })

  test('/tm commit and /tm patch say so when there is no turn yet', async ($, on) => {
    fakeHost(on)
    expect((await $.command.run(typed('commit'))).text).toBe('No Claude turn to commit yet.')
    expect((await $.command.run(typed('patch'))).text).toBe('No Claude turn to export yet.')
  })
})

describe('folders that are not git projects', () => {
  test('stay off until /tm on, and never start a history on their own', async ($, on) => {
    const calls = fakeHost(on, {}, false)
    expect((await $.command.run(typed('log'))).text).toMatch(/off here: it starts on its own only in git projects/)
    expect(calls.some(argv => argv.includes('init'))).toBe(false)
    expect((await $.command.run(typed('on'))).text).toMatch(/every turn is snapshotted/)
    expect((await $.command.run(typed('stats'))).text).toMatch(/mode auto/)
  })

  test('the home folder can never be turned on', async ($, on) => {
    fakeHost(on, {}, false, '/home/tester')
    expect((await $.command.run(typed('on'))).text).toMatch(/home folder or the file system root/)
  })
})

describe('modes', () => {
  test('/tm off stops snapshots around tool calls, /tm on brings them back', async ($, on) => {
    const calls = fakeHost(on)
    // Beneath the plugins: a Bash tool that does nothing.
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    const bash = async () => {
      const before = calls.length
      await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
      return calls.length - before
    }
    expect((await $.command.run(typed('off'))).text).toMatch(/off for this project/)
    expect(await bash()).toBe(0)
    expect((await $.command.run(typed('stats'))).text).toMatch(/off here/)
    expect((await $.command.run(typed('on'))).text).toMatch(/every turn is snapshotted/)
    expect(await bash()).toBeGreaterThan(0)
  })

  test('read-only commands run without any snapshot work', async ($, on) => {
    const calls = fakeHost(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    await $.command.run(typed('on'))
    const before = calls.length
    await $.tool.call({ tool: 'Bash', command: 'git status && ls -la' })
    expect(calls.length - before).toBe(0)
  })
})

describe('the band above the prompt', () => {
  test('stays out of the way until a turn changes files', async ($, on) => {
    fakeHost(on)
    // Beneath the plugins: the engine's own band, which here draws nothing.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'time-machine',
        component: 'AbovePrompt',
        surface,
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: 3,
          bodyColumns: 80,
          scroll: { offset: 0, bodyRows: 3 },
          view: {},
        },
      })
      expect(await ui.find({ key: 'tm-undo' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
      await ui.unmount()
    }
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
    fakeHost(on, { log: LOG, 'diff-tree': DIFF })
    const ran = await $.command.run(typed('log'))
    expect(ran.text).toMatch(/1\. \d\d:\d\d you\s+add login form\s+\+1 ~2/)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ key: 'e-0', text: /add login form/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
