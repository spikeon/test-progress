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

- Python: pytest, unittest (one summary for each unittest group, added together), tox
- JavaScript: jest, vitest, mocha, bun test, deno test, node --test, `npm test`, `pnpm test`, `yarn test`
- Go, Rust, and .NET: go test, cargo test, dotnet test
- Ruby, PHP, and Elixir: rspec, rake, phpunit, mix test
- Java and C: Gradle, Maven, ctest, `make test`
- Claude Code: `claude plugin test`
- Validators: `claude plugin validate`. The errors show as failed and the warnings show as skipped.

## Configuration

Add runners for your setup in a JSON file. You do not need to change the code. The mod reads two files at each Bash call, so a change applies at once:

- The project config: `.claude/test-progress.json` in the project root, or in a parent folder of the root.
- The user config: `~/.claude/test-progress.json`.

The mod tries the project runners first, then the user runners, then the built-in runners.

```json
{
  "runners": [
    { "name": "test_scope", "match": "\\btest_scope\\.py\\b" },
    {
      "name": "validate",
      "match": "\\bexoworks\\s+validate\\b",
      "summary": {
        "result": "^Content validation (passed|failed)",
        "failed": "^Errors \\((\\d+)\\):",
        "skipped": "^Warnings \\((\\d+)\\):",
        "passIf": "^Content validation passed"
      }
    }
  ],
  "disable": ["make test"]
}
```

- `runners[].name`: the name in the band.
- `runners[].match`: a JavaScript regular expression that finds the runner in the Bash command.
- `runners[].summary`: optional. Without it, the built-in summary lines and result lines give the counts.
  - `result`: the line that marks the end of the run. Until it matches, the counts are not final.
  - `passed`, `failed`, `skipped`, `total`: each pattern has one group, the number. The mod adds the numbers of all the lines that match. Without `total`, the total is the sum of the other counts.
  - `passIf`: if this pattern matches, the mod counts one pass. Use it for a validator that prints no count when it passes.
- `disable`: the names of built-in runners to turn off.

If a config file has an error, a toast shows the first problem. The mod ignores a runner that has a bad field and keeps the other runners.

## How it works

Claude Code does not send Bash output to a mod while a command runs. If a Bash command starts a test runner, the mod adds `tee` to it. `tee` also writes the output to a log file in `$TMPDIR`. The mod reads that log at an interval of 0.6 seconds. At the end of the run, the mod removes the log.

- The command keeps its exit status, its working directory, and its stdout and stderr streams.
- The last counts come from the summary line of the runner.
- The mod changes only commands that start a test runner. It does not block or deny tool calls.
- The band of each other mod stays on show below this band.

The `tee` wrapper uses process substitution. Use bash or zsh as the shell.

## Subagents and child sessions

The band shows the runs of the session, of its subagents, and of its child sessions. Each row names its source after the runner: the task of the subagent, or the name of the child session.

- Several runs can show at the same time. The band shows a maximum of four rows. The last row gives the sums of the runs that do not fit.
- Running runs come first, then failed runs, then passed runs.
- A new run replaces only the finished runs of the same source.

Child sessions work only in the desktop app, because the app gives each session an id. Each session writes its runs to a file in `$XDG_RUNTIME_DIR/claude-test-progress/`. The parent reads the files of its children, and of their children, at an interval of 1.5 seconds. A session gets its parent from the `get_session` tool of the desktop app, one time, at its first test run.

Install the mod for the user, so that each child session loads it.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
