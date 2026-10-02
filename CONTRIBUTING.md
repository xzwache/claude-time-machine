# Contributing

Thanks for taking the time. Bug reports, ideas and pull requests are all welcome.

## Setup

You need Node 22.18 or newer, git, and Claude Code 2.1.287 or newer.

```sh
git clone https://github.com/xzwache/claude-time-machine
cd claude-time-machine
npm ci
npm run types     # loads the mod once so the editor and tsc see the Claude Code API
npm run check     # format, unit tests, plugin validation, mod tests, typecheck
```

Try your changes in a real session:

```sh
cd /some/git/project
claude --plugin-dir /path/to/claude-time-machine
```

To try every command on a project that already has a history:

```sh
npm run sandbox               # makes <tmp>/tm-sandbox: turns of Write, Edit and Bash, your edits, an undo
npm run sandbox -- --run      # also runs every /tm command through `claude -p` and checks its output
npm run sandbox -- --clean    # deletes the sandbox and its history
```

`--run` exits non-zero when a command's output is not what it expects. It uses your real `~/.claude`, so Claude Code
must be signed in; the sandbox's history lives next to your projects' and `--clean` removes it.

## Layout

| Path                  | What it holds                                                               |
| --------------------- | --------------------------------------------------------------------------- |
| `hooks/register.tsx`  | The Claude Code hooks. The only file that uses the mod API (`$`).           |
| `src/time-machine.ts` | The `TimeMachine` facade the hooks and commands call.                       |
| `src/shadow.ts`       | The shadow git repository: snapshots, commits, ignore handling.             |
| `src/history.ts`      | Reading the timeline and grouping it into turns.                            |
| `src/restore.ts`      | Undo and travel.                                                            |
| `src/prune.ts`        | Forgetting old snapshots.                                                   |
| `src/export.ts`       | `/tm commit` and `/tm branch`: the only writes to the project's repository. |
| `src/commands.ts`     | `/tm` and its subcommands.                                                  |
| `src/guard.ts`        | The command guard: shell commands whose effects undo cannot take back.      |
| `src/sensitive.ts`    | The security diff: which changed files deserve a second look.               |
| `src/heat.ts`         | `/tm heat`: what the timeline did to each file, as a folder tree.           |
| `src/treemap.ts`      | Laying the heat map out and painting it.                                    |
| `src/heat-page.ts`    | The heat map as a self-contained HTML page.                                 |
| `src/view.tsx`        | The band, the Time machine pane and the Heat pane.                          |
| `scripts/sandbox.ts`  | A sandbox project with a history, and a run of every command on it.         |
| `tests/*.spec.ts`     | Node tests against real git in temporary folders.                           |
| `tests/*.test.tsx`    | Tests inside Claude Code's test engine (`claude plugin test`).              |

The mod API only follows `$` inside the hooks module, so anything that needs `$` lives in `hooks/register.tsx` and
everything else takes plain values and functions.

## Pull requests

- Branch from `main`, keep one change per pull request.
- Add a test for every bug fix and feature. Changes to snapshots or restores need a test in `tests/core.spec.ts`
  that runs against real git.
- Run `npm run check` before pushing; CI runs the same steps.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `chore:`.
- Add a line under `Unreleased` in `CHANGELOG.md` for anything a user would notice.

## Releases

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading.
2. Set the same version in `package.json` and `.claude-plugin/plugin.json`.
3. Merge, then tag: `git tag v1.2.3 && git push origin v1.2.3`. The release workflow publishes the GitHub release.
