import { expect, mock, test } from 'claude-code/testing'

import { compile } from '../hooks/config'
import { detectRunner, parseOutput } from '../hooks/parse'

const BAND = {
  plugin: 'test-progress',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, bodyColumns: 100 },
} as const

test('the runner is found in test commands only', async () => {
  expect(detectRunner('cd api && python -m pytest -q')?.name ?? null).toBe('pytest')
  expect(detectRunner('npx vitest run')?.name ?? null).toBe('vitest')
  expect(detectRunner('go test ./...')?.name ?? null).toBe('go test')
  expect(detectRunner('pnpm test')?.name ?? null).toBe('npm test')
  expect(detectRunner('cat pytest.ini')?.name ?? null).toBe(null)
  expect(detectRunner('ls -la')?.name ?? null).toBe(null)
  expect(detectRunner('claude plugin validate .')?.name ?? null).toBe('plugin validate')
  expect(detectRunner('timeout 600 ~/.local/bin/cad-slot ~/.venvs/badcad/bin/python -m unittest tests.test_x')?.name ?? null).toBe('unittest')
})

test('the summary lines of each runner give the counts', async () => {
  const pytest = parseOutput('collected 8 items\n\n====== 1 failed, 5 passed, 2 skipped in 0.42s ======\n')
  expect([pytest.passed, pytest.failed, pytest.skipped, pytest.total]).toEqual([5, 1, 2, 8])

  const jest = parseOutput('Tests:       2 failed, 10 passed, 12 total\n')
  expect([jest.passed, jest.failed, jest.total]).toEqual([10, 2, 12])

  const vitest = parseOutput(' Tests  1 failed | 6 passed (7)\n')
  expect([vitest.passed, vitest.failed, vitest.total]).toEqual([6, 1, 7])

  const cargo = parseOutput(
    'running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured\n' +
      'running 2 tests\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured\n',
  )
  expect([cargo.passed, cargo.failed, cargo.total]).toEqual([4, 1, 5])

  const unittest = parseOutput('Ran 12 tests in 0.010s\n\nFAILED (failures=2, skipped=1)\n')
  expect([unittest.passed, unittest.failed, unittest.skipped]).toEqual([9, 2, 1])

  // test_scope.py runs one unittest group after the other: each group prints its own summary
  const groups = parseOutput(
    'Ran 44 tests in 237.796s\n\nFAILED (failures=7)\n66 changed files -> 11 test ids\n' +
      'Ran 1 test in 223.298s\n\nFAILED (failures=1)\n',
  )
  expect([groups.passed, groups.failed, groups.total, groups.isSummary]).toEqual([37, 8, 45, true])

  // claude plugin validate: the errors fail, the warnings are skipped, a pass counts one
  const plugin = parseOutput(
    'Validating marketplace manifest: x/marketplace.json\n\n⚠ Found 1 warning:\n\n  ❯ description: none\n\n✔ Validation passed with warnings\n',
  )
  expect([plugin.passed, plugin.failed, plugin.skipped]).toEqual([1, 0, 1])
})

// The ExoWorks config of the README: a runner with no summary patterns and a validator with its own.
const EXOWORKS = {
  runners: [
    { name: 'test_scope', match: '\\btest_scope\\.py\\b' },
    {
      name: 'validate',
      match: '\\b(cmd/)?exoworks\\s+validate\\b',
      summary: {
        result: '^Content validation (passed|failed)',
        failed: '^Errors \\((\\d+)\\):',
        skipped: '^Warnings \\((\\d+)\\):',
        passIf: '^Content validation passed',
      },
    },
  ],
  disable: ['make test'],
}

test('the runners of a config come first, and a config turns off built-in runners', async () => {
  const setup = compile(EXOWORKS, 'test-progress.json')
  expect(setup.problems).toEqual([])
  expect(detectRunner('~/.venvs/badcad/bin/python cad/tools/test_scope.py --all', setup)?.name).toBe('test_scope')
  expect(detectRunner('go run ./cmd/exoworks validate', setup)?.name).toBe('validate')
  expect(detectRunner('make test', setup)).toBe(null)
  expect(detectRunner('make test')?.name).toBe('make test')
  expect(detectRunner('pytest -q', setup)?.name).toBe('pytest')

  // the summary patterns of the validator: errors fail, warnings are skipped, a pass counts one
  const validate = detectRunner('go run ./cmd/exoworks validate', setup) ?? undefined
  const failed = parseOutput(
    'Validating instance model trees...\n\nWarnings (6):\n  ⚠  a\n\nErrors (15):\n  ✗  b\n\nContent validation failed.\nexit status 1\n',
    validate,
  )
  expect([failed.passed, failed.failed, failed.skipped, failed.isSummary]).toEqual([0, 15, 6, true])
  const passed = parseOutput('Validating instance model trees...\n\nContent validation passed.\n', validate)
  expect([passed.passed, passed.failed, passed.isSummary]).toEqual([1, 0, true])
  const running = parseOutput('Validating instance model trees...\n', validate)
  expect(running.isSummary).toBe(false)
})

test('a config with a bad field keeps its good runners and names the problem', async () => {
  const setup = compile({ runners: [{ name: 'bad', match: '(' }, { match: 'x' }, { name: 'ok', match: 'ok-run' }] }, 'f.json')
  expect(setup.runners.map(r => r.name)).toEqual(['ok'])
  expect(setup.problems).toEqual(['f.json runners[0].match: not a valid pattern', 'f.json runners[1].name: missing'])
  expect(compile([], 'g.json').problems).toEqual([])
  expect(compile('x', 'h.json').problems).toEqual(['h.json: not a JSON object'])
})

test('the mod reads the config of the project and of the user', async ($, on) => {
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/work/shop' }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: String(e.argv.at(-1)).includes('HOME') ? '/home/me' : '/tmp', stderr: '' },
  }))
  const files: Record<string, string> = {
    '/work/.claude/test-progress.json': JSON.stringify({ runners: [{ name: 'shop check', match: '\\bshop-check\\b' }] }),
    '/home/me/.claude/test-progress.json': JSON.stringify(EXOWORKS),
  }
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('tool.call', () => ({ result: {}, text: 'Ran 3 tests in 0.1s\n\nOK\n' }))

  await $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: './shop-check --all' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /shop check/ }))?.text).toMatch(/ 3\/3 ✓3 ✗0 shop check$/)
  await ui.unmount()
})

test('the result lines count while the tests run', async () => {
  const dots = parseOutput('collected 10 items\n\ntests/test_a.py ..F.s [ 50%]\n')
  expect([dots.passed, dots.failed, dots.skipped, dots.total, dots.isSummary]).toEqual([3, 1, 1, 10, false])

  const go = parseOutput('=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\n')
  expect([go.passed, go.failed]).toEqual([1, 1])

  const tap = parseOutput('1..4\nok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP\n')
  expect([tap.passed, tap.failed, tap.skipped, tap.total]).toEqual([1, 1, 1, 4])
})

test('a finished test run shows its counts in the band, on every surface', async ($, on) => {
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp', stderr: '' } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('tool.call', () => ({
    result: {},
    isError: true,
    text: 'collected 6 items\n\n===== 2 failed, 4 passed in 0.1s =====\n',
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pytest' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /pytest/ }))?.text).toMatch(/ 6\/6 ✓4 ✗2 pytest$/)
    await ui.unmount()
  }

  // On a narrow band the row is shorter than the room: the bar gets smaller.
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 40 }, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text', text: /pytest/ }))?.text ?? ''
  expect(text.length).toBeLessThanOrEqual(40 - 3)
  await ui.unmount()
})

test('the band counts the tests while the command runs', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp', stderr: '' } }))
  on('fs.read', (_, e) => {
    if (!e.path.includes('claude-test-progress-')) throw new Error('ENOENT')
    return { value: 'collected 10 items\n\ntests/test_a.py ...F [ 40%]\n' }
  })
  on('tool.call', async () => {
    await clock.sleep(5000)
    return { result: {}, text: '' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const call = $.tool.call({ tool: 'Bash', command: 'pytest' })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /pytest/ }))?.text).toMatch(/ 4\/10 ✓3 ✗1 pytest$/)
  await ui.unmount()

  await clock.advance(5000)
  await call
})

test('a command that is not a test run draws nothing', async ($, on) => {
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp', stderr: '' } }))
  on('tool.call', (_, e) => ({ result: {}, text: String((e as { command?: string }).command) }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a finished run stays on show for 2 minutes, then goes', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp', stderr: '' } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('tool.call', () => ({ result: {}, text: '===== 3 passed in 0.1s =====\n' }))
  on('prompt.submit', (_, e) => e)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await $.prompt.submit({ text: 'next question' })

  await clock.advance(119_000)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /pytest/ }))?.text).toMatch(/✓3 ✗0 pytest$/)
  await ui.unmount()

  await clock.advance(2_000)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a new run replaces the finished run', async ($, on) => {
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp', stderr: '' } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  let output = '===== 3 passed in 0.1s =====\n'
  on('tool.call', () => ({ result: {}, text: output }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  output = 'Tests:       1 failed, 4 passed, 5 total\n'
  await $.tool.call({ tool: 'Bash', command: 'npx jest' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /jest/ }))?.text).toMatch(/ 5\/5 ✓4 ✗1 jest$/)
  expect(await ui.find({ type: 'Text', text: /pytest/ })).toBeUndefined()
  await ui.unmount()
})
