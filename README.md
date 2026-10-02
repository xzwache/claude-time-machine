<h1 align="center">Claude Time Machine</h1>

<p align="center">
  <strong>Undo for Claude Code that also covers Bash.</strong><br>
  Every turn is a snapshot. Review it step by step, undo it, or travel back.
</p>

<p align="center">
  <a href="https://github.com/xzwache/claude-time-machine/actions/workflows/ci.yml"><img src="https://github.com/xzwache/claude-time-machine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/xzwache/claude-time-machine/releases"><img src="https://img.shields.io/github/v/release/xzwache/claude-time-machine?sort=semver" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xzwache/claude-time-machine" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-d97757" alt="Claude Code plugin">
</p>

<!-- demo.gif: a turn, the band, pressing u, the files coming back -->

```
⏱ Claude changed 2 modified · 1 deleted   [ Undo turn ]  [ Review ]  ×

> /tm show 1
claude · add login form (19a9e6f)
  M src/app.ts
  A src/login.ts
  D src/legacy.ts
Steps:
  1.1 Edit src/app.ts  ~1
  1.2 Write src/login.ts  +1
  1.3 Bash: rm src/legacy.ts && npm run format  ~1 -1
```

## Why

Claude Code's `/rewind` brings back files Claude changed with Edit and Write. A lot of real work goes through the
shell instead: `mv`, `rm`, codegen, formatters, migrations. `/rewind` doesn't see any of that.

The time machine snapshots the whole project around every tool call, so:

- **Bash is covered.** Anything a command changed is one undo away.
- **Step by step.** Undo a whole turn, or just the third command of it.
- **Your work is safe.** Uncommitted changes you had before the turn stay. Edits you make while Claude works are yours,
  not Claude's; if you both touched a file, undo stops and tells you instead of overwriting.
- **Nothing is lost.** Every undo, travel and prune is itself a snapshot you can go back from.
- **Your repo is untouched.** History lives in a separate git repository under `~/.claude/time-machine/`. No commits,
  stashes or branches in your project, unless you ask for them with `/tm commit` or `/tm branch`.
- **Local and free.** Plain git on your machine. No network, no telemetry, no model calls.

|                                     | `/rewind`                 | Time machine                      |
| ----------------------------------- | ------------------------- | --------------------------------- |
| Changes made through Bash           | no                        | yes                               |
| Undo one step of a turn             | no                        | yes                               |
| Your edits made during a turn       | overwritten               | kept, or reported as a conflict   |
| Several sessions in one project     | separate                  | one timeline, sessions kept apart |
| How long history lasts              | 100 checkpoints, ~30 days | until you prune it                |
| Turn a turn into a commit or branch | no                        | yes                               |
| Rewind the conversation             | yes                       | no, use `/rewind` for that        |

They work fine side by side.

## Install

Requires macOS or Linux, git, and Claude Code 2.1.287 or newer.

```sh
claude plugin marketplace add xzwache/claude-time-machine
claude plugin install time-machine@claude-time-machine
```

Start Claude in a git project. The time machine starts on its own; in any other folder it stays off until `/tm on`.

## Use

After a turn that changed files, a band above the prompt offers **Undo turn** (`u`) and **Review** (`r`). When the
turn touched something that deserves a second look (CI config, dependencies or an install script, a secrets file, a new
executable, a mass delete), a second line says what, with **Undo these** (`x`) to revert only that:

```
⏱ Claude changed 2 modified · 2 created          [ Undo turn ]  [ Review ]  ×
⚠ CI config · deps +left-pad · install script    [ Undo these ]
```

| Command                         | What it does                                                        |
| ------------------------------- | ------------------------------------------------------------------- |
| `/tm`                           | Open the pane: timeline, steps, files and diffs                     |
| `/tm log`                       | List snapshots, newest first                                        |
| `/tm show 3`                    | Files, steps and Claude's answer for snapshot 3                     |
| `/tm undo` · `/tm undo 3.2`     | Undo the latest turn · undo step 2 of turn 3                        |
| `/tm undo 3 --sensitive`        | Undo only what the security diff flagged in turn 3                  |
| `/tm redo`                      | Undo the last undo                                                  |
| `/tm travel 5`                  | Put the whole project back to snapshot 5                            |
| `/tm save "before refactor"`    | Bookmark now; `/tm travel "before refactor"` comes back             |
| `/tm commit` · `/tm branch 3 x` | Turn a turn into a commit on your branch · snapshot 3 into branch x |
| `/tm patch`                     | The latest turn as a patch file                                     |
| `/tm heat` · `/tm heat open`    | Map of where Claude worked · the same map in your browser           |

All commands, modes and settings: [docs/commands.md](docs/commands.md).

## How it works

A bare git repository under `~/.claude/time-machine/` uses your project as its work tree. Before and after each tool
call that can change files, it runs `git add -A` into its own index and commits the result. A turn is a run of those
commits; undoing it checks the earlier versions of exactly the files Claude touched back out.

Snapshots are incremental: git only rehashes files whose size or timestamp changed. On a 67,000-file repository a
snapshot takes 0.2 to 0.4 s; smaller projects take proportionally less. Read-only commands such as
`ls`, `grep` or `git status` are skipped entirely.

Details, numbers and trade-offs: [docs/architecture.md](docs/architecture.md).

## Privacy

Everything stays on your machine. Snapshots contain your project's files, including small ignored files such as local
config, plus your prompts and Claude's answers. The folder is created with mode `700`.

Secrets are left out: `.env` files, keys and certificates, `.npmrc`, `.pypirc`, `.netrc`, credentials and kubeconfigs
are never copied, and undo and travel never write them. When Claude edits one, the security diff says so, but it cannot
be undone. To keep them in a project's snapshots anyway, so they can be undone: `/tm secrets keep`.

To keep paths out, list them in a `.tmignore` file (same syntax as `.gitignore`). To delete a project's history:
`/tm projects rm N --yes`, or remove its folder under `~/.claude/time-machine/`.

## Limitations

- Bash changes inside ignored folders (`node_modules/`, `dist/`) and ignored files over 1 MiB aren't recorded.
- Edits you make while a Bash command is running count as that command's.
- Empty directories aren't tracked, and nothing outside the project folder is.
- Windows isn't supported.

The full list is in [docs/architecture.md](docs/architecture.md#limitations).

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as
described in [SECURITY.md](SECURITY.md).

## License

Claude Time Machine is licensed under the [MIT License](LICENSE).

We chose MIT because a safety net for coding agents should be easy to adopt anywhere: in personal setups, team
plugins, company forks and other tools built on Claude Code. Use it, change it and ship it; keep the copyright notice.

See the [LICENSE](LICENSE) file for the full text.

---

## Support

- **Documentation**: [docs/](docs/): [commands](docs/commands.md) and [architecture](docs/architecture.md)
- **Issues**: [GitHub Issues](https://github.com/xzwache/claude-time-machine/issues)
- **Security**: report privately, see [SECURITY.md](SECURITY.md)
- **Repository**: [github.com/xzwache/claude-time-machine](https://github.com/xzwache/claude-time-machine)
- **Author**: [@xzwache](https://github.com/xzwache)

---

**A Claude Code plugin | Plain git underneath | Made with TypeScript**
