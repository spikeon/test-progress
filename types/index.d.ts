export type RunStatus = 'running' | 'passed' | 'failed'

export type Run = {
  id: string
  runner: string
  passed: number
  failed: number
  skipped: number
  total: number | null
  status: RunStatus
  // Milliseconds since the epoch when the run finished; absent while it runs.
  finishedAt?: number
  // Who started the run: a subagent's task, or a child session's name. Absent for the main loop.
  source?: string
}

declare module 'claude-code' {
  interface PluginState {
    'test-progress': {
      // The runs of this session and of its subagents.
      runs: Run[]
      // The runs of the child sessions, read from their shared files.
      remote: Run[]
      // When the person last clicked the dismiss button.
      dismissedAt: number
    }
  }
}
