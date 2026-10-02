# Claude Time Machine

[![CI](https://github.com/xzwache/claude-time-machine/actions/workflows/ci.yml/badge.svg)](https://github.com/xzwache/claude-time-machine/actions/workflows/ci.yml)

**Every Claude turn is a snapshot.** You can see what Claude changed, step by step. You can undo
a whole turn or a single step, or travel the whole workspace back. The work you had before
Claude touched it stays.

A [Claude Code](https://claude.com/claude-code) mod (a plugin of function hooks). It runs
locally, gives the same result every time, and makes no model calls.

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
Answer:
  Added the login form and removed the legacy page…

> /tm undo 1.3          # undo one step
> /tm undo              # undo the whole latest turn
```

- **Undo a turn and keep your own changes.** Say you had uncommitted edits in a file before
  Claude edited it. Undo puts the file back to your version, not to `HEAD`.
- **Step by step.** Each Write, Edit, NotebookEdit and Bash call that changed files is its own
  step. You can review any step or undo it on its own.
- **Bash is covered.** A Bash step is a snapshot of the whole work tree, so `mv`, `rm`,
  formatters and codegen are all recorded.
- **Your concurrent edits are respected.** A file you change while Claude works is recorded as
  yours, not Claude's, and undoing the turn leaves it alone. If you and Claude both touched the
  same file, undo flags it as a conflict instead of throwing your edit away.
- **Nothing is ever lost.** The current state is snapshotted before any undo, travel or prune. A
  forced undo can be undone too.
- **Your repository is not touched.** It gets no commits, no stash, no branch changes and no
  index changes. History lives in a separate "shadow" Git repository under
  `~/.claude/time-machine/`. The one exception is when you ask for it with `/tm commit` or
  `/tm branch`.
- **No model tokens.** Snapshots, diffs and restores are plain local Git, and nothing goes into
  the model's context. The one exception is a `/tm` command's text output, which becomes a
  transcript row like any slash command's output. The pane and the band write no transcript
  rows.

## How it differs from `/rewind`

Claude Code's built-in [`/rewind`](https://code.claude.com/docs/en/checkpointing.md) restores
code and conversation to the start of a turn. It covers file edits made through Write and Edit,
keeps the last 100 checkpoints per session for about 30 days, and can also rewind the
conversation. If that is all you need, you may not need this mod. The time machine is for what
`/rewind` leaves out:

| | `/rewind` | Time machine |
| --- | --- | --- |
| Changes made through Bash (`rm`, `mv`, codegen, formatters) | not tracked | tracked as steps |
| Undo one step of a turn | no | yes |
| Your edits during a turn | overwritten | kept, or flagged as a conflict |
| Several sessions in one project | per session | one timeline, each session's steps kept apart |
| History | 100 checkpoints, about 30 days | until you prune it; browsable with plain git |
| Rewind the conversation | yes | no (the mod API cannot) |

The two work side by side.

## Install

You need macOS or Linux, Claude Code with function-hook plugins (developed against 2.1.287), and
`git` on `PATH` (tested with 2.43). Windows is not supported.

This repository is its own plugin marketplace:

```sh
claude plugin marketplace add xzwache/claude-time-machine
claude plugin install time-machine@claude-time-machine
```

To try it without installing:

```sh
git clone https://github.com/xzwache/claude-time-machine
claude --plugin-dir ./claude-time-machine
```

## Use

After every turn that changed files, a band above the prompt shows what changed, with
**Undo turn** (`u`) and **Review** (`r`). The status line shows how many turns are on the
timeline.

| Command | What it does |
| --- | --- |
| `/tm` | Opens the Time machine pane. It shows the timeline. For a turn, it shows the prompt, Claude's answer, the steps, the files and the diff of each file. Its buttons are **Undo this**, **Travel to before** and **Travel to after**; travel asks for a second press. |
| `/tm log [N] [--session]` | Lists snapshots, newest first. With `--session`, lists only this session's. |
| `/tm show N` | Shows the files, steps and answer of snapshot N. `N` is a number from `/tm log`, or a commit id. |
| `/tm undo [N\|N.k] [--force]` | Reverts turn N, or its step k, and leaves everything else alone. With no argument, reverts the latest turn. |
| `/tm redo` | Undoes the latest undo. |
| `/tm travel N\|name` | Puts every tracked file back to how it was at snapshot N, or at a saved checkpoint. |
| `/tm save [name]` | Saves the work tree now as a named checkpoint, even if nothing changed. |
| `/tm on`, `/tm off`, `/tm manual` | Sets this project's mode. `on` snapshots every turn (the default), `off` takes no snapshots, and `manual` snapshots only on `/tm save`. The mode is kept across sessions, and the history stays in every mode. |
| `/tm prune 30d` or `/tm prune 50` | Forgets snapshots older than 30 days, or keeps only the newest 50. The oldest kept state becomes the new baseline. |
| `/tm commit [N] [message] [--force]` | Commits what turn N changed (default: the latest turn) to your current branch, each file as the turn left it. Your other changes, your work tree and the rest of your index are not touched. Files your repo ignores (such as `.env`) are left out. Refuses during a merge or rebase. Without `--force`, it also refuses if you have staged changes to the same files. |
| `/tm branch N name` | Creates branch `name` in your repo: a commit on top of `HEAD` with every file as it was at snapshot N. `HEAD`, the index and your files do not change. |
| `/tm patch [N]` | Writes turn N as a patch file to `~/.claude/time-machine/patches/`, binary files included, and copies it to the clipboard. Apply it with `git apply`. |
| `/tm retain 30d` or `/tm retain off` | Prunes snapshots older than 30 days, now and then once a day at session start. |
| `/tm stats` | Shows the snapshot count, disk use and mode for this project. |
| `/tm projects [rm N --yes]` | Lists every project that has a history, with its size, last activity and whether its folder still exists. `rm N --yes` deletes project N's history. |
| `/tm git` | Prints the `git` command for browsing the timeline yourself. |

### Keep paths out: `.tmignore`

A `.tmignore` file at the project root, in `.gitignore` syntax, lists paths the time machine
never snapshots, even when Git tracks them. Use it for large data folders or anything you do
not want copied:

```
data/
*.sqlite
.env
```

### Look at it with plain Git

The timeline is an ordinary Git history:

```sh
alias tmgit="git --git-dir=$HOME/.claude/time-machine/<id>.git --work-tree=$PWD"   # /tm git prints this
tmgit log --stat refs/tm/timeline
tmgit show 19a9e6f            # one step or one turn marker
tmgit diff 303149e 19a9e6f    # any two points in time
```

## How it works

```
session.start     →  create the shadow repo if missing; snapshot the work tree as "Baseline"
turn.start        →  snapshot; anything new since the last snapshot is recorded as "you"
Write/Edit        →  before: re-add that one file (catches your edits to it) · after: commit a step
Bash              →  read-only command (ls, cat, grep, git status…): nothing
                     otherwise before: full snapshot ("you" if changed) · after: full snapshot, commit a step
turn.complete     →  full snapshot (leftovers are "not Claude"), then a turn marker naming its base
/tm undo <turn>   →  for each path Claude's steps touched:
                       changed by anyone else since       → conflict, left alone (unless --force)
                       already back to before the turn    → nothing to do
                       otherwise                          → restore it from before Claude's first touch
                     then snapshot the result as an "undo" entry
```

- **One linear timeline.** It is a chain of commits on `refs/tm/timeline`: `step`, `outside`,
  `turn` markers, `undo` and `travel`. A turn marker names the commit its turn started from, and
  the history view folds that turn's steps under it. Every commit records which session made it.
  When two sessions run in the same project, each turn claims only its own session's steps.
- **Snapshots.** A snapshot is `git add -A` into the shadow repository's own index, followed by
  `git write-tree`. Git rehashes only files whose stat data changed, and the untracked cache and
  index v4 are on. A step that changes nothing costs only that snapshot.
- **Read-only commands are skipped.** A Bash command whose every part is a read-only program
  takes no snapshots. Examples: `ls`, `cat`, `grep`, `rg`, `find` without `-delete` or `-exec`,
  `sed` without `-i`, and `git status`/`log`/`diff`. A command with `>`, `$(…)` or `tee` never
  counts as read-only. If a command is wrongly judged read-only, nothing is lost: the next
  snapshot records its changes, attributed to the next step or to "not Claude".
- **Disk.** Every snapshot first stores new objects loose. After a turn, `git gc --auto` packs
  them in the background once there are more than about 1,000. `/tm prune` rewrites history and
  runs a full gc.
- **Measured cost.** `node scripts/bench.ts <project> <file>` reproduces these numbers. On a
  shallow clone of [microsoft/TypeScript](https://github.com/microsoft/TypeScript) (66,945
  files, 421 MB, Linux, SSD):

  | Operation | Time |
  | --- | --- |
  | First snapshot (once per project) | 9.7 s |
  | Packing that snapshot (background) | 12.7 s, 284 MB → 44 MB |
  | Turn start | 0.29 s |
  | Bash call that is not read-only (before + after) | 0.16 s + 0.34 s |
  | Edit or Write (before + after) | 0.29 s |
  | Turn end | 0.41 s |
  | Undo a turn | 0.72 s |

  A turn with three edits and two writing Bash calls therefore costs about 2.5 s on a project
  this size. Projects of a few thousand files cost a small fraction of that.
- **Restores.** They use `git checkout <commit> -- <paths>` and `git rm`. These restore content,
  the executable bit and symlinks exactly. They refuse to write through symlinked directories,
  and they remove directories they leave empty. The shadow repository's `info/attributes` turns
  off line-ending, LFS and `ident` conversion, so a restored file is byte for byte the
  snapshotted one.
- **Ignored files.** `.gitignore` applies to snapshots, with two exceptions:
  - Small ignored files (1 MiB or less) that are not inside an ignored directory are snapshotted.
    This covers `.env` and local configs. Build and editor debris (`*.log`, `*.pyc`, `.DS_Store`)
    stays out.
  - Any file a file tool edits is captured before the edit, even inside an ignored directory.
- **Code layout.** Only `hooks/register.tsx` touches the Claude Code API: the hooks, the state,
  and the handlers. The rest is plain TypeScript, tested under Node:

  | File | Role |
  | --- | --- |
  | `core.ts` | The `TimeMachine`: snapshots, undo, travel, save and prune |
  | `timeline.ts` | Reading commits and folding them into turns |
  | `message.ts` | The commit message format |
  | `git.ts` | Pinned git settings |
  | `projects.ts` | `/tm projects` |
  | `export.ts` | `/tm commit` and `/tm branch`: the only writes to your repository |
  | `bash.ts` | The read-only command check |
  | `commands.ts` | `/tm` |
  | `view.tsx` | The band and the pane |
  | `format.ts` | Shared text |

  `types/index.d.ts` is the state contract.

## Limitations

- **Bash changes inside ignored directories** are not recorded. Examples: `npm install` writing
  to `node_modules/`, or a build writing to `dist/`. Neither are ignored files over 1 MiB.
- **Edits you make while a Bash command runs** are attributed to that command. Outside that
  window, edits are attributed correctly.
- **Files written by MCP tools or background processes** show up as "not Claude", because no
  tool call is linked to them. Undoing the turn leaves them, but you can undo them individually.
- **Large repositories** pay two full snapshots per Bash call that is not read-only. See the
  table above for what that costs at 67,000 files. If that is too slow, `/tm manual` or
  `.tmignore` help.
- **New ignored files created by Bash** are found after the command, not before. One that
  appears between two commands, from something other than Claude, is attributed to the next
  command. If the snapshot before a turn takes more than 2 s, a
  toast says so.
- **Empty directories** are not tracked, because Git does not track them.
- **Files outside the project root** are not tracked.
- **Nested Git repositories** are recorded as a pointer to their commit, not their contents.
- **A moved or renamed project folder** starts a new history. The old one shows as
  "folder gone" in `/tm projects`.
- **A restore that fails partway** (a locked file, say) can leave some paths restored. The state
  from just before is on the timeline, so `/tm travel` to it recovers.
- **Claude Code's `/rewind`** is not linked. The mod API has no way to read or drive it, so
  rewinding the conversation stays with `/rewind`.
- **Windows** is not supported. The mod uses `test`, `find`, `du` and POSIX paths.

## Privacy and data

Everything stays on your machine. There is no network access and no telemetry.

Snapshots hold every non-ignored file, small ignored files such as `.env`, and every ignored
file Claude edited. Turn entries also hold your prompt and Claude's final answer. Claude Code
already keeps full transcripts in plain text under `~/.claude/projects/`, so this exposes nothing
new. The folder is created with mode `700`.

```
~/.claude/time-machine/<first 16 hex digits of sha256(project path)>.git
```

To delete one project's history, run `/tm projects rm N --yes`, or `rm -rf` that folder. To
delete all of it, run `rm -rf ~/.claude/time-machine`.

## Develop

```sh
npm test            # tests/*.spec.ts: real git in temp dirs, the read-only check (Node 22.18+)
npm run test:mod    # tests/plugin.test.tsx: the mod inside Claude Code's test engine
npm run validate    # claude plugin validate .
npm run types       # loads the mod once, which lays .claude-plugin/types (no credentials needed)
npm run typecheck   # tsc against those types
npm run bench -- <project> <file>   # snapshot costs on a real project
```

Try it on a demo project:

```sh
mkdir /tmp/tm-demo && cd /tmp/tm-demo && git init -q
echo 'export const a = 1' > a.ts && echo old > legacy.txt && git add -A && git commit -qm init
echo 'export const a = 1 // mine' > a.ts                  # uncommitted work of your own
claude --plugin-dir /path/to/claude-time-machine
# ask Claude: "append 'export const b = 2' to a.ts with Edit, then run: rm legacy.txt"
# then press u on the band, or /tm show 1, /tm undo 1.2, /tm undo
```

## License

MIT
