// Detects test commands and reads test counts from their output.

import { NO_SETUP, configSummary } from './config'
import type { Runner, Setup } from './config'

export type Counts = {
  passed: number
  failed: number
  skipped: number
  total: number | null
  // True when the output has a final summary line from the runner.
  isSummary: boolean
}

const RUNNERS: readonly [string, RegExp][] = [
  ['pytest', /\b(pytest|py\.test)\b|\bpython3?\s+-m\s+pytest\b/],
  // validators: the counts are the errors (failed) and the warnings (skipped)
  ['plugin validate', /\bclaude\s+plugin\s+validate\b/],
  ['unittest', /\bpython3?\s+-m\s+unittest\b/],
  ['vitest', /\bvitest\b/],
  ['jest', /\bjest\b/],
  ['mocha', /\bmocha\b/],
  ['go test', /\bgo\s+test\b/],
  ['cargo test', /\bcargo\s+(test|nextest)\b/],
  ['bun test', /\bbun\s+test\b/],
  ['deno test', /\bdeno\s+test\b/],
  ['node --test', /\bnode\b.*\s--test\b/],
  ['rspec', /\brspec\b/],
  ['phpunit', /\bphpunit\b/],
  ['dotnet test', /\bdotnet\s+test\b/],
  ['ctest', /\bctest\b/],
  ['mix test', /\bmix\s+test\b/],
  ['plugin test', /\bclaude\s+plugin\s+test\b/],
  ['tox', /\b(tox|nox)\b/],
  ['gradle', /\b(gradlew?|mvnw?)\b.*\b(test|check|verify)\b/],
  ['rake', /\brake\s+(test|spec)\b/],
  ['make test', /\bmake\b.*\b(test|check)\b/],
  ['npm test', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test(:\S+)?\b/],
]

// Commands that only read or search text that names a runner.
const NOT_A_RUN = /^\s*(cat|less|head|tail|grep|rg|ls|find|which|echo|printf|git|sed|awk|vi|vim|nano|code)\b/

// Finds the runner of a command: first the runners of the setup's config, then the built-in runners
// that the config does not turn off.
export function detectRunner(command: string, setup: Setup = NO_SETUP): Runner | null {
  if (NOT_A_RUN.test(command)) return null
  const found = setup.runners.find(r => r.match.test(command))
  if (found) return found
  for (const [name, match] of RUNNERS) {
    if (!setup.disabled.has(name) && match.test(command)) return { name, match }
  }
  return null
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

const num = (text: string, pattern: RegExp): number => {
  const m = text.match(pattern)
  return m ? Number((m[1] ?? '')) : 0
}

const sumAll = (text: string, pattern: RegExp): number | null => {
  let total = 0
  let isFound = false
  for (const m of text.matchAll(pattern)) {
    total += Number((m[1] ?? ''))
    isFound = true
  }
  return isFound ? total : null
}

// Adds the summaries of all unittest runs in the output.
function unittestSummary(lines: string[]): Omit<Counts, 'isSummary'> {
  const starts = lines.flatMap((line, i) => (/^Ran \d+ tests? in /.test(line) ? [i] : []))
  let total = 0
  let failed = 0
  let skipped = 0
  starts.forEach((start, k) => {
    const block = lines.slice(start + 1, starts[k + 1] ?? lines.length)
    // the result line (OK or FAILED) comes right after the Ran line and a blank line
    const result = block.find((l) => /^(OK|FAILED)\b/.test(l)) ?? ''
    total += num(lines[start] ?? '', /^Ran (\d+)/)
    failed += num(result, /failures=(\d+)/) + num(result, /errors=(\d+)/)
    skipped += num(result, /skipped=(\d+)/) + num(result, /expected failures=(\d+)/)
  })
  return { passed: total - failed - skipped, failed, skipped, total }
}

// Reads the result of claude plugin validate (Found 1 warning: ... Validation passed with warnings).
// A validator that passes counts one pass.
function validateSummary(text: string): Omit<Counts, 'isSummary'> | null {
  const result = text.match(/^\W*Validation (passed|failed)\b/m)
  if (!result) return null
  const failed = num(text, /Found (\d+) errors?\b/)
  const skipped = num(text, /Found (\d+) warnings?\b/)
  const passed = result[1] === 'passed' ? 1 : 0
  return { passed, failed, skipped, total: passed + failed + skipped }
}

// Reads the final summary line of a known runner. The last summary wins,
// except for runners that print one summary per test binary (cargo).
function summary(text: string): Omit<Counts, 'isSummary'> | null {
  // cargo: test result: ok. 5 passed; 0 failed; 1 ignored; ...
  const cargo = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
  if (cargo.length > 0) {
    const c = cargo.reduce((a, m) => [a[0] + Number(m[1]), a[1] + Number(m[2]), a[2] + Number(m[3])] as [number, number, number], [0, 0, 0] as [number, number, number])
    return { passed: c[0], failed: c[1], skipped: c[2], total: c[0] + c[1] + c[2] }
  }

  const validated = validateSummary(text)
  if (validated) return validated

  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''

    // jest: Tests:       1 failed, 2 skipped, 5 passed, 8 total
    let m = line.match(/^\s*Tests:\s+(.*\b(\d+) total)/)
    if (m) {
      return {
        passed: num((m[1] ?? ''), /(\d+) passed/),
        failed: num((m[1] ?? ''), /(\d+) failed/),
        skipped: num((m[1] ?? ''), /(\d+) (skipped|todo|pending)/),
        total: Number((m[2] ?? '')),
      }
    }

    // vitest: Tests  1 failed | 5 passed | 1 skipped (7)
    m = line.match(/^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/)
    if (m && /passed|failed|skipped/.test((m[1] ?? ''))) {
      return {
        passed: num((m[1] ?? ''), /(\d+) passed/),
        failed: num((m[1] ?? ''), /(\d+) failed/),
        skipped: num((m[1] ?? ''), /(\d+) (skipped|todo)/),
        total: Number((m[2] ?? '')),
      }
    }

    // pytest: ===== 1 failed, 5 passed, 2 skipped in 0.42s =====
    m = line.match(/^=+ (.*\b(passed|failed|error|errors|skipped|no tests ran)\b.*) in [\d.]+s/)
    if (m) {
      const passed = num((m[1] ?? ''), /(\d+) passed/) + num((m[1] ?? ''), /(\d+) xpassed/)
      const failed = num((m[1] ?? ''), /(\d+) failed/) + num((m[1] ?? ''), /(\d+) errors?\b/)
      const skipped = num((m[1] ?? ''), /(\d+) skipped/) + num((m[1] ?? ''), /(\d+) xfailed/)
      return { passed, failed, skipped, total: passed + failed + skipped }
    }

    // dotnet: Failed!  - Failed: 1, Passed: 5, Skipped: 0, Total: 6
    m = line.match(/Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)/)
    if (m) {
      return { passed: Number((m[2] ?? '')), failed: Number((m[1] ?? '')), skipped: Number((m[3] ?? '')), total: Number((m[4] ?? '')) }
    }

    // rspec: 10 examples, 2 failures, 1 pending
    m = line.match(/^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/)
    if (m) {
      const total = Number((m[1] ?? ''))
      const failed = Number((m[2] ?? ''))
      const skipped = Number((m[3] ?? '') ?? 0)
      return { passed: total - failed - skipped, failed, skipped, total }
    }

    // phpunit: Tests: 10, Assertions: 20, Errors: 1, Failures: 2, Skipped: 1.
    m = line.match(/^Tests: (\d+), Assertions: \d+(.*)$/)
    if (m) {
      const total = Number((m[1] ?? ''))
      const failed = num((m[2] ?? ''), /Errors: (\d+)/) + num((m[2] ?? ''), /Failures: (\d+)/)
      const skipped = num((m[2] ?? ''), /Skipped: (\d+)/) + num((m[2] ?? ''), /Incomplete: (\d+)/)
      return { passed: total - failed - skipped, failed, skipped, total }
    }
    m = line.match(/^OK \((\d+) tests?,/)
    if (m) return { passed: Number((m[1] ?? '')), failed: 0, skipped: 0, total: Number((m[1] ?? '')) }

    // unittest: Ran 12 tests in 0.01s, then OK or FAILED (failures=1, errors=1, skipped=2).
    // A command that runs more than one unittest group prints one summary for each group: add them.
    if (/^Ran \d+ tests? in /.test(line)) return unittestSummary(lines)
  }

  // mocha: 5 passing, 1 failing, 2 pending
  const passing = text.match(/^\s*(\d+) passing\b/m)
  if (passing) {
    const passed = Number((passing[1] ?? ''))
    const failed = num(text, /^\s*(\d+) failing\b/m)
    const skipped = num(text, /^\s*(\d+) pending\b/m)
    return { passed, failed, skipped, total: passed + failed + skipped }
  }

  // node --test (TAP comments): # pass 5, # fail 1, # skipped 0
  const tapPass = text.match(/^# pass (\d+)$/m)
  if (tapPass) {
    const passed = Number((tapPass[1] ?? ''))
    const failed = num(text, /^# fail (\d+)$/m)
    const skipped = num(text, /^# skipped (\d+)$/m) + num(text, /^# todo (\d+)$/m)
    return { passed, failed, skipped, total: passed + failed + skipped }
  }

  // bun: " 5 pass", " 1 fail" on lines of their own
  const bunPass = text.match(/^\s*(\d+) pass$/m)
  if (bunPass) {
    const passed = Number((bunPass[1] ?? ''))
    const failed = num(text, /^\s*(\d+) fail$/m)
    const skipped = num(text, /^\s*(\d+) skip$/m)
    return { passed, failed, skipped, total: passed + failed + skipped }
  }

  return null
}

// Counts the per-test result lines that runners print while they work.
function live(text: string): Omit<Counts, 'isSummary'> {
  let passed = 0
  let failed = 0
  let skipped = 0
  let goPassed = 0
  let goFailed = 0

  for (const line of text.split('\n')) {
    // pytest -v: tests/test_a.py::test_one PASSED  [ 10%]
    let m = line.match(/::\S*\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/)
    if (m) {
      if ((m[1] ?? '') === 'PASSED' || (m[1] ?? '') === 'XPASS') passed += 1
      else if ((m[1] ?? '') === 'FAILED' || (m[1] ?? '') === 'ERROR') failed += 1
      else skipped += 1
      continue
    }

    // pytest default: tests/test_a.py ..F.s  [ 40%]
    m = line.match(/^(?:\S+\.py )?([.FEsxX]+)\s*(?:\[\s*\d+%\])?\s*$/)
    if (m && (line.includes('.py ') || /\[\s*\d+%\]/.test(line))) {
      for (const c of (m[1] ?? '')) {
        if (c === '.' || c === 'X') passed += 1
        else if (c === 'F' || c === 'E') failed += 1
        else skipped += 1
      }
      continue
    }

    // jest --verbose, vitest, bun, mocha, deno
    if (/^\s*(✓|✔|√)\s/.test(line) || /^\s*\S.* \.\.\. ok\b/.test(line) && !line.startsWith('test ')) {
      passed += 1
      continue
    }
    if (/^\s*(✕|✗|×|✖)\s/.test(line)) {
      failed += 1
      continue
    }

    // cargo: test foo::bar ... ok
    m = line.match(/^test \S.* \.\.\. (ok|FAILED|ignored)\b/)
    if (m) {
      if ((m[1] ?? '') === 'ok') passed += 1
      else if ((m[1] ?? '') === 'FAILED') failed += 1
      else skipped += 1
      continue
    }

    // go test -v
    m = line.match(/^\s*--- (PASS|FAIL|SKIP):/)
    if (m) {
      if ((m[1] ?? '') === 'PASS') passed += 1
      else if ((m[1] ?? '') === 'FAIL') failed += 1
      else skipped += 1
      continue
    }
    // go test without -v: one line per package
    if (/^ok\s+\S+\s/.test(line)) goPassed += 1
    else if (/^FAIL\s+\S+\s/.test(line)) goFailed += 1

    // TAP: ok 1 - name / not ok 2 - name
    m = line.match(/^\s*(not )?ok \d+\b(.*)$/)
    if (m) {
      if (/# (SKIP|TODO)/i.test((m[2] ?? ''))) skipped += 1
      else if ((m[1] ?? '')) failed += 1
      else passed += 1
    }
  }

  if (passed + failed + skipped === 0) {
    passed = goPassed
    failed = goFailed
  }

  // Totals that runners print before the tests start.
  const total =
    sumAll(text, /^collected (\d+) items?/gm) ??
    sumAll(text, /^running (\d+) tests?$/gm) ??
    sumAll(text, /^\s*1\.\.(\d+)$/gm)

  return { passed, failed, skipped, total: total !== null && total > 0 ? total : null }
}

// Reads the counts of the output. A runner of the config with its own summary patterns uses them;
// the result lines that runners print while they work count until the summary comes.
export function parseOutput(raw: string, runner?: Runner): Counts {
  const text = raw.replace(ANSI, '').replace(/\r(?!\n)/g, '\n').replace(/\r\n/g, '\n')
  const s = runner?.summary ? configSummary(text, runner.summary) : summary(text)
  if (s) return { ...s, isSummary: true }
  return { ...live(text), isSummary: false }
}
