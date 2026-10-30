import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'
import { NO_SETUP, compile, configFiles, merge } from './config'
import type { Setup } from './config'
import { detectRunner, parseOutput } from './parse'
import type { Counts } from './parse'

const runs = atom({ plugin: 'test-progress', key: 'runs' } as const, [] as Run[])
const remote = atom({ plugin: 'test-progress', key: 'remote' } as const, [] as Run[])
const dismissedAt = atom({ plugin: 'test-progress', key: 'dismissedAt' } as const, 0)

const POLL_MS = 600
// A background run with no new output for this long counts as finished.
const IDLE_MS = 120_000
const MAX_ROWS = 4
// A finished run stays on show for this long, unless it is dismissed or a new run starts.
const KEEP_MS = 120_000
// How often the parent reads the files of its child sessions.
const SHARE_MS = 1_500
// A child's running run with no new output for this long is not shown.
const STALE_MS = 300_000
const SOURCE_CHARS = 28

// The file that each session writes for its parent session.
type Shared = { host: string; parent: string | null; name: string; runs: Run[] }

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

// Copies the command's output to a log that the mod reads while the command
// runs. The braces keep the current shell, so `cd` and the exit status stay
// the same; stdout and stderr stay on their own streams.
const withLog = (command: string, log: string) =>
  `{ ${command}\n} > >(tee -a ${quote(log)}) 2> >(tee -a ${quote(log)} >&2)`

const withCounts = (run: Run, counts: Counts): Run => ({
  ...run,
  passed: counts.passed,
  failed: counts.failed,
  skipped: counts.skipped,
  total: counts.total,
})

const hasCounts = (run: Run) => run.passed + run.failed + run.skipped > 0 || run.total !== null

const clip = (text: string) => (text.length > SOURCE_CHARS ? `${text.slice(0, SOURCE_CHARS - 1)}…` : text)

// Running runs first, then failed runs, then passed runs.
const rank = (run: Run) => (run.status === 'running' ? 0 : run.status === 'failed' ? 1 : 2)

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

// The state of this load of the module. `register` sets it again at each load.
const env = {
  tmp: '/tmp',
  home: null as string | null,
  // The problems of the config that the mod showed last: each new problem shows once.
  shown: { text: '' },
  // The desktop app's id for this session, and the folder that all sessions share.
  host: '',
  shared: '',
  parent: undefined as string | null | undefined,
  name: '',
  parentTriedAt: -Infinity,
  lastWritten: '',
  cache: new Map<string, { mtimeMs: number; data: Shared | null }>(),
}

// Asks the desktop app for this session's parent, one time. A session that
// is not a child, or that the app can not answer for, has no parent.
async function findParent($: EngineInterface) {
  if (env.parent !== undefined) return
  const now = await $.clock.now()
  if (now - env.parentTriedAt < 30_000) return
  env.parentTriedAt = now
  const got = (await $.tool
    .call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: 'self' } as unknown as { tool: 'Read'; file_path: string })
    .catch(() => null)) as { text?: string; deny?: string } | null
  if (!got || got.deny !== undefined || !got.text) return
  try {
    const info = JSON.parse(got.text) as { parentSessionId?: string; detached?: boolean; name?: string; title?: string }
    env.parent = info.parentSessionId && !info.detached ? info.parentSessionId : null
    env.name = info.name || info.title || ''
  } catch {
    env.parent = null
  }
}

// Writes this session's runs where its parent session can read them.
async function publish($: EngineInterface) {
  if (!env.host || !env.shared) return
  const list = await read($, runs)
  if (list.length === 0 && !env.lastWritten) return
  if (list.length > 0) await findParent($)
  const text = JSON.stringify({ host: env.host, parent: env.parent ?? null, name: env.name, runs: list } satisfies Shared)
  if (text === env.lastWritten) return
  env.lastWritten = text
  await $.fs.write(`${env.shared}/${env.host}.json`, text).catch(() => undefined)
}

async function setRuns($: EngineInterface, change: (list: Run[]) => Run[]) {
  await update($, runs, change)
  await publish($)
}

function setRun($: EngineInterface, id: string, change: (run: Run) => Run) {
  return setRuns($, list => list.map(run => (run.id === id ? change(run) : run)))
}

// Removes finished runs that are older than KEEP_MS. A run from an earlier
// version has no `finishedAt`, so it goes too.
function dropExpired($: EngineInterface, now: number) {
  return setRuns($, list =>
    list.filter(run => run.status === 'running' || (run.finishedAt !== undefined && now - run.finishedAt < KEEP_MS)),
  )
}

// Reads the files of the child sessions, and of their children, into `remote`.
async function readChildren($: EngineInterface) {
  if (!env.host || !env.shared) return
  const entries = await $.fs.list(env.shared).catch(() => [])
  const now = await $.clock.now()
  const files = new Map<string, { mtimeMs: number; data: Shared }>()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${env.host}.json`) continue
    let held = env.cache.get(entry.name)
    if (!held || held.mtimeMs !== entry.mtimeMs) {
      const text = await $.fs.read(`${env.shared}/${entry.name}`).catch(() => null)
      let data: Shared | null = null
      try {
        data = typeof text === 'string' ? (JSON.parse(text) as Shared) : null
      } catch {
        // A file that is still being written is read at the next tick.
      }
      held = { mtimeMs: entry.mtimeMs, data }
      env.cache.set(entry.name, held)
    }
    if (held.data && Array.isArray(held.data.runs)) files.set(held.data.host, { mtimeMs: entry.mtimeMs, data: held.data })
  }

  const isMine = (id: string) => {
    let at: string | null | undefined = files.get(id)?.data.parent
    for (let depth = 0; at && depth < 8; depth += 1) {
      if (at === env.host) return true
      at = files.get(at)?.data.parent
    }
    return false
  }

  const dismissed = await read($, dismissedAt)
  const found: Run[] = []
  for (const [id, { mtimeMs, data }] of files) {
    if (!isMine(id)) continue
    for (const run of data.runs) {
      if (run.status === 'running' && now - mtimeMs > STALE_MS) continue
      if (run.status !== 'running' && (run.finishedAt === undefined || now - run.finishedAt >= KEEP_MS || run.finishedAt <= dismissed)) continue
      const label = data.name || id.replace(/^local_/, '').slice(0, 8)
      found.push({ ...run, id: `${id}:${run.id}`, source: run.source ? `${label} · ${run.source}` : label })
    }
  }
  const before = await read($, remote)
  if (JSON.stringify(before) !== JSON.stringify(found)) await update($, remote, () => found)
}

export const register: Register = on => {
  Object.assign(env, {
    tmp: '/tmp',
    home: null,
    shown: { text: '' },
    host: '',
    shared: '',
    parent: undefined,
    name: '',
    parentTriedAt: -Infinity,
    lastWritten: '',
    cache: new Map(),
  })

  on('session.start', async ($, e, next) => {
    const found = await $.process.run(['sh', '-c', 'printf %s "${TMPDIR:-/tmp}"']).catch(() => null)
    if (found && found.exitCode === 0 && found.stdout.startsWith('/')) env.tmp = found.stdout.replace(/\/+$/, '')
    const user = await $.process.run(['sh', '-c', 'printf %s "$HOME"']).catch(() => null)
    if (user && user.exitCode === 0 && user.stdout.startsWith('/')) env.home = user.stdout
    // The desktop app gives each session an id. The parent finds its children's files by it.
    const desk = await $.process
      .run(['sh', '-c', 'printf "%s\\n%s" "${CLAUDE_CODE_HOST_SESSION_ID:-}" "${XDG_RUNTIME_DIR:-/tmp}"'])
      .catch(() => null)
    if (desk && desk.exitCode === 0) {
      const [id = '', base = ''] = desk.stdout.split('\n')
      if (/^[A-Za-z0-9_-]+$/.test(id) && base.startsWith('/')) {
        env.host = id
        env.shared = `${base.replace(/\/+$/, '')}/claude-test-progress`
      }
    }

    // A reload cancels the old timers, so a run that was in progress can not finish.
    // Its expiry timers go too, so the expiry is checked here and timed again.
    await setRuns($, list => list.filter(run => run.status !== 'running'))
    const now = await $.clock.now()
    await dropExpired($, now)
    for (const run of await read($, runs)) {
      if (run.finishedAt !== undefined) {
        $.clock.after(Math.max(0, run.finishedAt + KEEP_MS - now), () => void $.clock.now().then(t => dropExpired($, t)))
      }
    }

    if (env.shared) {
      // The files of sessions that ended days ago go.
      await $.process.run(['find', env.shared, '-name', '*.json', '-mtime', '+2', '-delete']).catch(() => undefined)
      $.clock.every(SHARE_MS, () => void readChildren($).catch(() => undefined))
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const rule = detectRunner(e.command, await loadSetup($, env.home, env.shown))
    if (rule === null) return next(e)
    const runner = rule.name

    // A subagent's run is labelled with the subagent's task.
    let source: string | undefined
    if (e.agentId !== undefined) {
      const agents = await $.agent.list().catch(() => [])
      source = agents.find(agent => agent.id === e.agentId)?.description || 'subagent'
    }

    const id = e.tool_use_id
    const log = `${env.tmp}/claude-test-progress-${id.replace(/[^A-Za-z0-9_-]/g, '')}.log`
    const run: Run = { id, runner, passed: 0, failed: 0, skipped: 0, total: null, status: 'running', source }
    // A new run replaces the finished runs of the same source. Other runs stay.
    await setRuns($, list => [
      ...list.filter(r => r.id !== id && (r.status === 'running' || r.source !== source)),
      run,
    ])

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
      await setRuns($, list => list.filter(r => r.id !== id || hasCounts(r)))
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
    const all = [...(await read($, runs)), ...(await read($, remote))].filter(hasCounts)
    if (all.length === 0 || e.props.hasSurvey) return next(e)
    const list = all.map((run, index) => ({ run, index })).sort((a, b) => rank(a.run) - rank(b.run) || a.index - b.index).map(x => x.run)

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
      const tail = run.source ? `${run.runner} · ${clip(run.source)}` : run.runner
      const label = ` ${count} ✓${run.passed} ✗${run.failed} ${tail}`
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
          <Text dimColor> {tail}</Text>
        </Text>
      )
    }

    // The runs that do not fit go into one row with their sums.
    const more = (hidden: Run[]) => {
      const passed = hidden.reduce((sum, run) => sum + run.passed, 0)
      const failed = hidden.reduce((sum, run) => sum + run.failed, 0)
      const running = hidden.filter(run => run.status === 'running').length
      return (
        <Text key="test-progress-more" wrap="truncate-end">
          <Text dimColor>+{hidden.length} more </Text>
          <Text color="success">✓{passed}</Text>
          <Text> </Text>
          <Text color={failed > 0 ? 'error' : undefined} dimColor={failed === 0}>
            ✗{failed}
          </Text>
          {running > 0 ? <Text dimColor> {running} running</Text> : null}
        </Text>
      )
    }

    const fits = list.length <= MAX_ROWS
    const shown = fits ? list : list.slice(0, MAX_ROWS - 1)
    const [first, ...rest] = shown.map(row)

    const dismiss = async () => {
      await setRuns($, l => l.filter(run => run.status === 'running'))
      const now = await $.clock.now()
      await update($, dismissedAt, () => now)
      await update($, remote, l => l.filter(run => run.status === 'running'))
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>{first}</Box>
          {isFinished ? (
            <Button key="test-progress-dismiss" label="✕" plain role="dismiss" onPress={() => void dismiss()} />
          ) : null}
        </Box>
        {rest}
        {fits ? null : more(list.slice(MAX_ROWS - 1))}
        {below}
      </Box>
    )
  })
}
