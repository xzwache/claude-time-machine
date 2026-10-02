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
function fakeHost(
  on: On,
  given: Record<string, string> = {},
  isGit = true,
  root = '/work/project',
  version = '2.1.287',
): string[][] {
  const calls: string[][] = []
  on('session.version', () => ({ value: { version, base: version, builtAt: '2026-10-01T00:00:00Z' } }))
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

describe('an older Claude Code', () => {
  test('gets a clear message instead of a half-working time machine', async ($, on) => {
    const calls = fakeHost(on, {}, true, '/work/project', '2.1.250')
    expect((await $.command.run(typed('log'))).text).toBe(
      'Time machine needs Claude Code 2.1.287 or newer; this is 2.1.250. Update it with: claude update',
    )
    expect(calls.some(argv => argv.includes('init'))).toBe(false)
  })
})

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

describe('secrets', () => {
  test('/tm secrets says they are left out, and keep and skip switch it per project', async ($, on) => {
    fakeHost(on)
    expect((await $.command.run(typed('secrets'))).text).toMatch(/left out of this project's snapshots/)
    expect((await $.command.run(typed('secrets keep'))).text).toMatch(/kept in this project's snapshots from now on/)
    expect((await $.command.run(typed('secrets'))).text).toMatch(/are kept in this project's snapshots/)
    expect((await $.command.run(typed('secrets skip'))).text).toMatch(/left out of new snapshots/)
    expect((await $.command.run(typed('secrets'))).text).toMatch(/left out of this project's snapshots/)
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

describe('the security diff in the band', () => {
  const PROPS = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  }
  const withBand = (on: On, band: Record<string, unknown>) =>
    on('state.get', (_, e, next) =>
      e.plugin === 'time-machine' && e.key === 'band' ? { value: { value: band, version: 1 } } : next(e),
    )

  test('shows what was flagged and a button to undo only that, on every surface', async ($, on) => {
    fakeHost(on)
    withBand(on, { id: ID, summary: '2 modified', alert: 'CI config · deps +left-pad', result: null })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'time-machine', component: 'AbovePrompt', surface, props: PROPS })
      expect(await ui.find({ type: 'Text', text: '⚠ CI config · deps +left-pad' })).toBeDefined()
      expect(await ui.find({ key: 'tm-undo-sensitive' })).toBeDefined()
      expect(await ui.find({ key: 'tm-undo' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('keeps to one row when nothing was flagged', async ($, on) => {
    fakeHost(on)
    withBand(on, { id: ID, summary: '2 modified', alert: null, result: null })
    const ui = await $.ui.mount({ plugin: 'time-machine', component: 'AbovePrompt', surface: 'terminal', props: PROPS })
    expect(await ui.find({ key: 'tm-undo' })).toBeDefined()
    expect(await ui.find({ key: 'tm-undo-sensitive' })).toBeUndefined()
    await ui.unmount()
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

  test('travels to the picked snapshot after a second press', async ($, on) => {
    fakeHost(on, { log: LOG, 'diff-tree': DIFF })
    await $.command.run(typed('log'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'e-0' })
    expect(await ui.find({ key: 'after', text: 'Travel here' })).toBeDefined()
    expect(await ui.find({ key: 'before', text: 'Travel to before' })).toBeDefined()
    await ui.press({ key: 'after' })
    expect(await ui.find({ key: 'after', text: 'Confirm: travel here' })).toBeDefined()
    await ui.unmount()
  })
})

// A step and an outside commit, as `git log` and `diff-tree --numstat` print them for /tm heat.
const STEP = 'b'.repeat(40)
const OUTSIDE = 'c'.repeat(40)
const HEAT_LOG = [
  `\x1e${STEP}\x1f1700000100\x1fEdit src/app.ts\x1ftm-kind: step\ntm-session: s1\n`,
  `\x1e${OUTSIDE}\x1f1700000000\x1fChanges outside Claude\x1ftm-kind: outside\n`,
].join('')
const NUMSTAT = [STEP, '12\t3\tsrc/app.ts', '4\t0\tdocs/readme.md', OUTSIDE, '2\t2\tsrc/app.ts', ''].join('\0')
const HEAT_ANSWERS = { '--format=%x1e%H%x1f%ct%x1f%s%x1f%<(300,trunc)%b': HEAT_LOG, '--numstat': NUMSTAT }
const HEAT_PANE = { ...PANE, requestId: 'time-machine-heat' }

describe('the heat map', () => {
  test('/tm heat lists the hottest files and draws the map on every surface', async ($, on) => {
    fakeHost(on, HEAT_ANSWERS)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    const ran = await $.command.run(typed('heat'))
    expect(ran.text).toMatch(/1\. \S+ src\/app\.ts\s+15 lines, 1 edit/)
    expect(ran.text).toMatch(/2\. \S+ docs\/readme\.md\s+4 lines/)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...HEAT_PANE, surface })
      expect(await ui.find({ key: 'm-rework' })).toBeDefined()
      expect(await ui.find({ key: 'up' })).toBeUndefined()
      if (surface === 'terminal') expect(await ui.find({ type: 'Raster', key: 'heat-map' })).toBeDefined()
      else expect(await ui.find({ type: 'Svg' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the pane goes into a folder and back up, and changes the color', async ($, on) => {
    fakeHost(on, HEAT_ANSWERS)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    await $.command.run(typed('heat'))
    const ui = await $.ui.mount({ ...HEAT_PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'n-0', text: /src\// })).toBeDefined()
    await ui.press({ key: 'n-0' })
    expect(await ui.find({ key: 'n-0', text: /app\.ts/ })).toBeDefined()
    await ui.press({ key: 'm-owner' })
    expect(await ui.find({ key: 'n-0', text: /79% Claude/ })).toBeDefined()
    await ui.press({ key: 'up' })
    expect(await ui.find({ key: 'n-0', text: /src\// })).toBeDefined()
    expect(await ui.find({ key: 'up' })).toBeUndefined()
    await ui.unmount()
  })

  test('picking a file lists the turns that changed it', async ($, on) => {
    fakeHost(on, HEAT_ANSWERS)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    await $.command.run(typed('heat'))
    const ui = await $.ui.mount({ ...HEAT_PANE, surface: 'terminal' })
    await ui.press({ key: 'n-0' })
    await ui.press({ key: 'n-0' })
    expect(await ui.find({ type: 'Text', text: 'src/app.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No closed Claude turn changed it/ })).toBeDefined()
    await ui.press({ key: 'file-close' })
    expect(await ui.find({ key: 'file-close' })).toBeUndefined()
    await ui.unmount()
  })

  test('/tm heat open and the pane button write the page and open it', async ($, on) => {
    const calls = fakeHost(on, HEAT_ANSWERS)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    const ran = await $.command.run(typed('heat open'))
    expect(ran.text).toMatch(
      /^Opened the heat map in your browser: \/home\/tester\/\.claude\/time-machine\/heat\/[0-9a-f]{16}\.html$/,
    )
    expect(calls.some(argv => argv[0] === 'xdg-open' && argv[1]?.endsWith('.html'))).toBe(true)
    await $.command.run(typed('heat'))
    const ui = await $.ui.mount({ ...HEAT_PANE, surface: 'terminal' })
    await ui.press({ key: 'open' })
    expect(await ui.find({ type: 'Text', text: 'Opened in your browser.' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /\(file:\/\/\/home\/tester\/.+\.html\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('/tm heat says so when nothing changed yet', async ($, on) => {
    fakeHost(on)
    expect((await $.command.run(typed('heat'))).text).toMatch(/Nothing to map yet/)
  })
})
