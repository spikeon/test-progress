import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'
import { NO_SETUP, compile, configFiles, merge } from './config'
import type { Setup } from './config'
import { detectRunner, parseOutput } from './parse'
import type { Counts } from './parse'

const runs = atom({ plugin: 'test-progress', key: 'runs' } as const, [] as Run[])

const POLL_MS = 600
// A background run with no new output for this long counts as finished.
const IDLE_MS = 120_000
const MAX_ROWS = 3
// A finished run stays on show for this long, unless it is dismissed or a new run starts.
const KEEP_MS = 120_000

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

// Copies the command's output to a log that the mod reads while the command
// runs. The braces keep the current shell, so `cd` and the exit status stay
// the same; stdout and stderr stay on their own streams.
const withLog = (command: string, log: string) =>
  `{ ${command}\n} > >(tee -a ${quote(log)}) 2> >(tee -a ${quote(log)} >&2)`

const setRun = ($: EngineInterface, id: string, change: (run: Run) => Run) =>
  update($, runs, list => list.map(run => (run.id === id ? change(run) : run)))

const withCounts = (run: Run, counts: Counts): Run => ({
  ...run,
  passed: counts.passed,
  failed: counts.failed,
  skipped: counts.skipped,
  total: counts.total,
})

const hasCounts = (run: Run) => run.passed + run.failed + run.skipped > 0 || run.total !== null

// Removes finished runs that are older than KEEP_MS. A run from an earlier
// version has no `finishedAt`, so it goes too.
const dropExpired = ($: EngineInterface, now: number) =>
  update($, runs, list =>
    list.filter(run => run.status === 'running' || (run.finishedAt !== undefined && now - run.finishedAt < KEEP_MS)),
  )

// Reads the config files at each Bash call, so that an edit counts at once. Each new problem of
// the config shows once in a toast.
async function loadSetup($: EngineInterface, home: string | null, shown: { text: string }): Promise<Setup> {
  const root = await $.session.root().catch(() => null)
  if (root === null) return NO_SETUP
  const setups: Setup[] = []
  for (const file of configFiles(root, home)) {
    const text = await $.fs.read(file).catch(() => null)
    if (typeof text !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setups.push({ ...NO_SETUP, problems: [`${file}: not valid JSON`] })
      continue
    }
    setups.push(compile(parsed, file))
  }
  const setup = merge(setups)
  const problems = setup.problems.join('\n')
  if (problems !== '' && problems !== shown.text) $.ui.toast(`test-progress config: ${setup.problems[0]}`)
  shown.text = problems
  return setup
}

export const register: Register = on => {
  let tmp = '/tmp'
  let home: string | null = null
  // The problems of the config that the mod showed last: each new problem shows once.
  const shown = { text: '' }


  on('session.start', async ($, e, next) => {
    // A reload cancels the old timers, so a run that was in progress can not finish.
    // Its expiry timers go too, so the expiry is checked here and timed again.
    await update($, runs, list => list.filter(run => run.status !== 'running'))
    const now = await $.clock.now()
    await dropExpired($, now)
    for (const run of await read($, runs)) {
      if (run.finishedAt !== undefined) {
        $.clock.after(Math.max(0, run.finishedAt + KEEP_MS - now), () => void $.clock.now().then(t => dropExpired($, t)))
      }
    }
    const found = await $.process
      .run(['sh', '-c', 'printf %s "${TMPDIR:-/tmp}"'])
      .catch(() => null)
    if (found && found.exitCode === 0 && found.stdout.startsWith('/')) {
      tmp = found.stdout.replace(/\/+$/, '')
    }
    const user = await $.process.run(['sh', '-c', 'printf %s "$HOME"']).catch(() => null)
    if (user && user.exitCode === 0 && user.stdout.startsWith('/')) home = user.stdout
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const rule = detectRunner(e.command, await loadSetup($, home, shown))
    if (rule === null) return next(e)
    const runner = rule.name

    const id = e.tool_use_id
    const log = `${tmp}/claude-test-progress-${id.replace(/[^A-Za-z0-9_-]/g, '')}.log`
    const run: Run = { id, runner, passed: 0, failed: 0, skipped: 0, total: null, status: 'running' }
    // A new run replaces the finished ones. Other runs in progress stay.
    await update($, runs, list => [...list.filter(r => r.id !== id && r.status === 'running'), run])

    let size = -1
    let changedAt = await $.clock.now()
    let isDone = false

    const readLog = async () => {
      const text = await $.fs.read(log).catch(() => null)
      return typeof text === 'string' ? text : null
    }

    const finish = async (counts: Counts | null, isError: boolean) => {
      if (isDone) return
      isDone = true
      timer.cancel()
      const finishedAt = await $.clock.now()
      await setRun($, id, current => {
        const final = counts ? withCounts(current, counts) : current
        return { ...final, status: isError || final.failed > 0 ? 'failed' : 'passed', finishedAt }
      })
      $.clock.after(KEEP_MS, () => void $.clock.now().then(t => dropExpired($, t)))
      // A command that named a runner but printed no test results is not a test run.
      await update($, runs, list => list.filter(r => r.id !== id || hasCounts(r)))
      await $.process.run(['rm', '-f', log]).catch(() => undefined)
    }

    const poll = async () => {
      if (isDone) return
      const text = await readLog()
      const now = await $.clock.now()
      if (text === null || text.length === size) {
        if (e.run_in_background && now - changedAt > IDLE_MS) await finish(null, false)
        return
      }
      size = text.length
      changedAt = now
      const counts = parseOutput(text, rule)
      await setRun($, id, current => withCounts(current, counts))
      // A background run ends when its runner prints the summary.
      if (e.run_in_background && counts.isSummary) await finish(counts, counts.failed > 0)
    }

    const timer = $.clock.every(POLL_MS, () => void poll())

    const ran = await next({ ...e, command: withLog(e.command, log) })

    if (ran.deny !== undefined || (e.run_in_background && ran.isError !== true)) {
      if (ran.deny !== undefined) await finish(null, false)
      return ran
    }

    // The log has the whole output, but `tee` can still be writing its end.
    // The model's text is complete at its end, but it can be cut in the middle.
    const fromLog = parseOutput((await readLog()) ?? '', rule)
    const fromText = parseOutput(ran.text ?? '', rule)
    const done = (c: Counts) => c.passed + c.failed + c.skipped
    const best = fromLog.isSummary
      ? fromLog
      : fromText.isSummary || done(fromText) > done(fromLog)
        ? fromText
        : fromLog
    await finish(best, ran.isError === true)
    return ran
  })
    // If this hook fails, the command runs as written. After a call, `next` replays its result.
    .catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = (await read($, runs)).filter(hasCounts)
    if (list.length === 0 || e.props.hasSurvey) return next(e)

    // The other mods' bands go below this one. The engine's own placeholder is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below =
      drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns || 80
    const isFinished = list.every(run => run.status !== 'running')
    // The dismiss button and its gap take 3 columns on the first row.
    const room = columns - (isFinished ? 3 : 0)

    // One row is one Text that does not wrap: a status mark, the bar, the
    // count, the passed count in green, the failed count in red, the runner.
    const row = (run: Run) => {
      const done = run.passed + run.failed + run.skipped
      const total = run.total !== null ? Math.max(run.total, done) : null
      const count = total !== null ? `${done}/${total}` : `${done}`
      const label = ` ${count} ✓${run.passed} ✗${run.failed} ${run.runner}`
      const barWidth = Math.max(5, Math.min(40, room - 2 - label.length))
      const filled = total ? Math.round((done / total) * barWidth) : run.status === 'running' ? 0 : barWidth
      const failedCells = total && run.failed > 0 ? Math.max(1, Math.round((run.failed / total) * barWidth)) : 0
      const okCells = Math.max(0, Math.min(barWidth, filled) - failedCells)
      const empty = Math.max(0, barWidth - okCells - failedCells)
      const head = run.status === 'running' ? '…' : run.status === 'failed' ? '✗' : '✓'
      const headColor = run.status === 'running' ? 'claude' : run.status === 'failed' ? 'error' : 'success'

      return (
        <Text key={`test-progress-${run.id}`} wrap="truncate-end">
          <Text color={headColor}>{head} </Text>
          <Text color="success">{'█'.repeat(okCells)}</Text>
          <Text color="error">{'█'.repeat(failedCells)}</Text>
          <Text dimColor>{'░'.repeat(empty)}</Text>
          <Text> {count} </Text>
          <Text color="success">✓{run.passed}</Text>
          <Text> </Text>
          <Text color={run.failed > 0 ? 'error' : undefined} dimColor={run.failed === 0}>
            ✗{run.failed}
          </Text>
          <Text dimColor> {run.runner}</Text>
        </Text>
      )
    }

    const shown = list.slice(-MAX_ROWS)
    const [first, ...rest] = shown.map(row)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>{first}</Box>
          {isFinished ? (
            <Button
              key="test-progress-dismiss"
              label="✕"
              plain
              role="dismiss"
              onPress={() => update($, runs, l => l.filter(run => run.status === 'running'))}
            />
          ) : null}
        </Box>
        {rest}
        {below}
      </Box>
    )
  })
}
