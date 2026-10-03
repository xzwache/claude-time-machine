# Architecture

## The shadow repository

Each project gets a bare git repository at `~/.claude/time-machine/<id>.git`, where `<id>` is the first 16 hex digits
of the SHA-256 of the project path. Its work tree is the project, but its index, objects and refs are its own, so the
project's `.git` is never read or written (except by `/tm commit` and `/tm branch`, on request).

The shadow repository pins a few settings so snapshots and restores are byte for byte: no line-ending conversion, no
LFS or other filters, hooks disabled, symlinks and file modes kept.

## The timeline

History is one linear chain of commits on `refs/tm/timeline`. Each commit records what kind of change it was:

| Kind             | Meaning                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `baseline`       | The first snapshot, or the oldest one left after a prune.                                  |
| `step`           | One tool call (Write, Edit, NotebookEdit or Bash) that changed files.                      |
| `outside`        | Changes made by something other than Claude's tools: you, an editor, a background process. |
| `turn`           | A marker closing a turn. It names the commit the turn started from.                        |
| `capture`        | An ignored file's content, saved just before Claude's first edit to it.                    |
| `checkpoint`     | A snapshot saved with `/tm save`.                                                          |
| `undo`, `travel` | The result of a restore.                                                                   |

The history view folds a turn's steps under its marker. Every commit also records the Claude Code session that made
it, so two sessions in one project each claim only their own steps.

## When snapshots are taken

| Moment                | What happens                                                          |
| --------------------- | --------------------------------------------------------------------- |
| Session start         | Create the repository and the baseline if missing.                    |
| Turn start            | Snapshot; anything new is recorded as `outside`.                      |
| Before Write/Edit     | Re-add that one file, so an edit you made to it counts as yours.      |
| After Write/Edit      | Re-add that file and commit a `step`.                                 |
| Before a Bash command | Full snapshot; changes are `outside`. Skipped for read-only commands. |
| After a Bash command  | Full snapshot, committed as a `step`. Skipped for read-only commands. |
| Turn end              | Full snapshot (leftovers are `outside`), then the `turn` marker.      |

A snapshot is `git add -A` into the shadow index followed by `git write-tree`. Git only rehashes files whose size or
modification time changed, and the untracked cache is on.

A command counts as read-only when every part of it is a known read-only program (`ls`, `cat`, `grep`, `rg`, `find`
without `-delete`/`-exec`, `sed` without `-i`, `git status`/`log`/`diff`…) and it has no `>`, `$(…)` or `tee`. If one
is misjudged, nothing is lost: the next snapshot picks up its changes.

## Undo

Undoing a turn goes over every path Claude's steps touched:

- changed by someone else since the turn (or between its steps): a conflict, left as it is unless `--force`;
- already back to how it was before: nothing to do;
- otherwise: checked out from the snapshot before Claude's first change to it, or removed if Claude created it.

Before any undo or travel, the current state is snapshotted, so the restore itself can be undone. Restores use
`git checkout <commit> -- <paths>` and `git rm`, which restore content, the executable bit and symlinks, refuse to write
through symlinked directories, and remove directories they leave empty.

## Ignored files

`.gitignore` applies, with two exceptions. Small ignored files (up to 1 MiB) outside ignored directories are
snapshotted, which covers local config; build and editor debris (`*.log`, `*.pyc`, `.DS_Store`) stays out. And any
file a file tool is about to edit is captured first, even inside an ignored directory. `.tmignore` overrides both.

## Secrets

Secrets are left out of every snapshot unless the project keeps them (`/tm secrets keep`): the same files the
sensitive-change check calls secrets, written in `.gitignore` syntax into the shadow repository's `info/exclude` ahead
of `.tmignore`, and dropped from its index if an older snapshot had them. They are never staged, captured or
force-added. When one of Claude's file tools writes one, the turn records its path (`tm-secret:`), not its content, so
it can be flagged as a sensitive change. Undo and travel skip these paths, so an older snapshot that still holds a copy
never writes it back.

## Disk and speed

New objects are first written loose. After each turn `git gc --auto` packs them in the background once there are more
than about 1,000. `/tm prune` rewrites the history from a new baseline and runs a full gc.

Measured with `npm run bench` on a shallow clone of microsoft/TypeScript (66,945 files, 421 MB, Linux, SSD):

| Operation                                 | Time                   |
| ----------------------------------------- | ---------------------- |
| First snapshot (once per project)         | 9.7 s                  |
| Packing it (background)                   | 12.7 s, 284 MB → 44 MB |
| Turn start                                | 0.29 s                 |
| Bash call that may write (before + after) | 0.16 s + 0.34 s        |
| Edit or Write (before + after)            | 0.29 s                 |
| Turn end                                  | 0.41 s                 |
| Undo a turn                               | 0.72 s                 |

## Code layout

`hooks/register.tsx` holds every hook and is the only file that uses the Claude Code mod API: the engine follows `$`
only inside the hooks module. Everything under `src/` takes plain values and functions and is tested under Node
against real git.

| File                  | Role                                                    |
| --------------------- | ------------------------------------------------------- |
| `src/time-machine.ts` | Facade: turn lifecycle, serialized access               |
| `src/shadow.ts`       | The shadow repository: git, snapshots, commits, ignores |
| `src/history.ts`      | Reading the timeline, grouping turns, planning undos    |
| `src/timeline.ts`     | Parsing git output, folding steps into turns            |
| `src/pending.ts`      | Turns in progress, per session                          |
| `src/restore.ts`      | Undo and travel                                         |
| `src/prune.ts`        | Forgetting old snapshots                                |
| `src/export.ts`       | `/tm commit` and `/tm branch`                           |
| `src/commands.ts`     | `/tm` and its subcommands                               |
| `src/view.tsx`        | The band and the pane                                   |

## Limitations

- Bash changes inside ignored directories (`npm install` into `node_modules/`, a build into `dist/`) and ignored files
  over 1 MiB are not recorded.
- Edits you make while a Bash command runs count as that command's.
- Files written by MCP tools or background processes are recorded as `outside`: undoing the turn leaves them, but they
  can be undone on their own.
- Large repositories pay two full snapshots per Bash call that may write; see the numbers above. `/tm manual` or
  `.tmignore` help.
- Empty directories are not tracked, and nothing outside the project folder is.
- Nested git repositories are recorded as a pointer to their commit, not their contents.
- Moving or renaming the project folder starts a new history; the old one shows as "folder gone" in `/tm projects`.
- A restore that fails halfway (a locked file) can leave some paths restored. The state from just before is on the
  timeline, so `/tm travel` to it recovers.
- `/rewind` and the time machine are not linked: the mod API cannot read or drive `/rewind`.
- Windows is not supported.
