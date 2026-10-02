# Claude Time Machine

**Every Claude turn is a snapshot.** See what Claude changed, undo one turn, or travel the whole
workspace back. You keep the work you had before Claude touched it.

A [Claude Code](https://claude.com/claude-code) mod (a plugin of function hooks). It is local,
deterministic and uses no model calls.

```
> /tm log
 1. 14:02 claude  add login form              +1 ~2 -1  3509459
 2. 13:58 you     Changes outside Claude      ~1        9f1c2aa
 3. 13:41 claude  fix the flaky date test     ~1        77d0e41
 4. 13:30 start   Baseline                              421c44c

> /tm undo
Undo claude "add login form":
✓ Restored 2 modified files
✓ Removed 1 file
✓ Brought back 1 file
```

- **Undo a turn without losing your own changes.** If you had uncommitted edits in a file before
  Claude edited it, undo puts the file back to your version, not to `HEAD`.
- **Bash changes are covered too.** Snapshots are taken of the work tree, not of tool calls, so
  `mv`, formatters, codegen and `rm` are all on the timeline.
- **Conflict-safe.** If you edit a file after Claude's turn, undo leaves that file alone and tells
  you. `--force` overrides this, and even a forced undo can be undone.
- **Nothing is ever lost.** Before any undo or travel, the current state is snapshotted first.
- **Your repository is not touched.** No commits, no stash, no branch or index changes. History
  lives in a separate "shadow" Git repository under `~/.claude/time-machine/`.
- **No model tokens.** Snapshots, diffs and restores are plain local Git. Nothing goes into the
  model's context. The one exception: a `/tm` command's text output becomes a transcript row,
  like any slash command's output. The pane writes no transcript row.

## Install

Requires Claude Code with function-hook plugins (developed against 2.1.287) and `git` on `PATH`.

```sh
git clone https://github.com/xzwache/claude-time-machine
claude --plugin-dir ./claude-time-machine
```

To load it in every session, list the folder in `CLAUDE_CODE_PLUGIN_DIRS`, for example in the
`env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/claude-time-machine" } }
```

## Use

| Command | What it does |
| --- | --- |
| `/tm` | Opens the Time machine pane: the timeline, each snapshot's files and diffs, and buttons for **Undo this** and **Travel to before / after** (travel asks for a second press). |
| `/tm log [N]` | Lists the last N snapshots, newest first. |
| `/tm show N` | Lists the files snapshot N changed. `N` is a number from `/tm log` or a commit id. |
| `/tm undo [N] [--force]` | Reverts what snapshot N changed and leaves everything else alone. Defaults to the latest Claude turn. |
| `/tm redo` | Undoes the latest undo. |
| `/tm travel N` | Puts every tracked file back to how it was at snapshot N. |
| `/tm git` | Prints the `git` command for browsing the timeline yourself. |

After each turn that changed files, a toast shows what changed, for example
`⏱ Turn saved: 2 modified · 1 created`.

### Look at it with plain Git

The timeline is an ordinary Git history, so every Git tool works on it:

```sh
alias tmgit="git --git-dir=$HOME/.claude/time-machine/<id>.git --work-tree=$PWD"   # /tm git prints this
tmgit log --stat refs/tm/timeline
tmgit show 3509459            # everything one turn did
tmgit diff 421c44c 3509459    # any two points in time
```

## How it works

```
session.start  →  shadow repo exists? else snapshot the work tree as "Baseline"
turn.start     →  snapshot; anything new since the last snapshot is recorded as "you"
tool.call      →  (Write/Edit/NotebookEdit on a gitignored file) capture its pre-image
turn.complete  →  snapshot; if the tree changed, record it as "claude" with the prompt
/tm undo N     →  snapshot now; for each path N changed:
                    unchanged since N  → put back N's parent version (or delete it)
                    already as before  → nothing to do
                    changed since N    → conflict, left alone (unless --force)
                  snapshot the result as an "undo" entry
```

- A snapshot is `git add -A` into the shadow repository's own index, then `git write-tree`. Git
  only rehashes files whose stat data changed, and stores identical content once, so a snapshot
  that finds little changed is quick and adds almost nothing to disk.
- Each recorded entry is a commit on `refs/tm/timeline` in the shadow repository. The commit
  message holds the kind (`turn`, `outside`, `undo`, `travel`) and the prompt.
- Restores use `git checkout <commit> -- <paths>` and `git rm`. These restore content, the
  executable bit and symlinks exactly, refuse to write through symlinked directories, and remove
  directories they leave empty.
- The shadow repository's `info/attributes` turns off line-ending, LFS and `ident` conversion. A
  restored file is byte-for-byte the snapshotted one.
- `.gitignore` rules apply to snapshots, which keeps `node_modules/` and build output out. The
  exception is a gitignored file that Claude edits through Write, Edit or NotebookEdit (a `.env`,
  say): it is captured before the edit and tracked from then on.
- Code layout: `hooks/core.ts` has all Git logic and no Claude Code API, so it is tested against
  real Git. `hooks/register.tsx` has the hooks, the `/tm` command and the pane.
  `types/index.d.ts` is the state contract.

## Limitations

- **Gitignored files changed by Bash are not covered.** If a command rewrites something under an
  ignored path (`npm install` in `node_modules/`, a build into `dist/`), that change is not on the
  timeline. Only gitignored files that Claude edits with a file tool are captured.
- **Edits you make while a turn runs** are attributed to that turn, since the snapshot cannot tell
  who wrote a file.
- **Run one Claude session per project at a time.** Two sessions in one project share one shadow
  repository, and each would record the other's changes as its own.
- **Empty directories** are not tracked (Git does not track them). Directories that become empty
  after a removal are deleted.
- **Files outside the project root** (`/etc`, `~`, sibling repos) are not tracked.
- **Nested Git repositories** are recorded as a pointer to their commit, not their contents.
- **Large untracked, non-ignored files** are snapshotted like any other file and take disk space
  in the shadow repository. Ignore them, or delete the shadow repository now and then.
- **A restore that fails partway** (say, a file locked by another process) can leave some paths
  restored. The state from just before the restore is on the timeline, so `/tm travel` to it
  recovers.

## Privacy and data

Everything stays on your machine. There is no network access and no telemetry. Snapshots contain
every non-ignored file in the project, and every ignored file Claude edited, which may include
secrets such as `.env`. They are stored at:

```
~/.claude/time-machine/<first 16 hex digits of sha256(project path)>.git
```

To delete a project's history, run `rm -rf` on that folder. `/tm git` prints the exact path.
To delete all of it, run `rm -rf ~/.claude/time-machine`.

## Develop

```sh
npm test            # tests/core.spec.ts: real git in temp dirs (Node 22.18+)
npm run test:mod    # tests/plugin.test.ts: the mod inside Claude Code's test engine
npm run validate    # claude plugin validate .
npm run typecheck   # tsc; needs .claude-plugin/types, which Claude Code lays on first load
```

Try it on a demo project:

```sh
mkdir /tmp/tm-demo && cd /tmp/tm-demo && git init -q
echo 'export const a = 1' > a.ts && echo old > legacy.txt && git add -A && git commit -qm init
echo 'export const a = 1 // mine' > a.ts                  # uncommitted work of your own
claude --plugin-dir /path/to/claude-time-machine
# ask Claude: "append 'export const b = 2' to a.ts, create b.ts, and rm legacy.txt"
# then: /tm   or   /tm undo   → a.ts is back to "// mine", b.ts gone, legacy.txt back
```

## License

MIT
