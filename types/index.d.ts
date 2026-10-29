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
}

declare module 'claude-code' {
  interface PluginState {
    'test-progress': { runs: Run[] }
  }
}
