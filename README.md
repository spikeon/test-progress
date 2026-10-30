# test-progress

A Claude Code mod that shows a progress bar above the prompt for each test run in the session.

```
✗ ████████████████░░░░ 20/20 ✓17 ✗3 node --test  ✕
```

- The bar fills while the tests run. Green shows the passed tests and red shows the failed tests.
- The row shows the completed count, the passed count in green, and the failed count in red.
- A finished run stays on show for 2 minutes. Click ✕ or start a new test run to remove it sooner.
- The mod also counts test runs from subagents.

## Install

From a shell, add the marketplace, then install the mod:

```bash
claude plugin marketplace add spikeon/test-progress
```

```bash
claude plugin install test-progress@test-progress
```

At the prompt of a terminal session, type the same two commands:

```
/plugin marketplace add spikeon/test-progress
/plugin install test-progress@test-progress
```

In the desktop app, `/plugin` does not run. Click **+** next to the prompt box, then **Plugins**. Click **Add marketplace** and type `spikeon/test-progress`. Then click **Add plugin**.

## Supported test runners

- Python: pytest, unittest, tox, and the ExoWorks `cad/tools/test_scope.py` (one summary for each unittest group)
- JavaScript: jest, vitest, mocha, bun test, deno test, node --test, `npm test`, `pnpm test`, `yarn test`
- Go, Rust, and .NET: go test, cargo test, dotnet test
- Ruby, PHP, and Elixir: rspec, rake, phpunit, mix test
- Java and C: Gradle, Maven, ctest, `make test`
- Claude Code: `claude plugin test`

## How it works

Claude Code does not send Bash output to a mod while a command runs. If a Bash command starts a test runner, the mod adds `tee` to it. `tee` also writes the output to a log file in `$TMPDIR`. The mod reads that log at an interval of 0.6 seconds. At the end of the run, the mod removes the log.

- The command keeps its exit status, its working directory, and its stdout and stderr streams.
- The last counts come from the summary line of the runner.
- The mod changes only commands that start a test runner. It does not block or deny tool calls.
- The band of each other mod stays on show below this band.

The `tee` wrapper uses process substitution. Use bash or zsh as the shell.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
