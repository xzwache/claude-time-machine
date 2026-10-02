# Commands and settings

Snapshots are referred to by their number in `/tm log` (`3`), a step of a turn (`3.2`), a commit id (`19a9e6f`), or
the name of a saved checkpoint (`"before refactor"`).

## Looking

| Command                   | What it does                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/tm`                     | Opens the pane: the timeline, and for the selected entry its prompt, answer, steps, files and diffs. |
| `/tm log [N] [--session]` | Lists the newest N snapshots (15 by default). `--session` shows only this session's.                 |
| `/tm show N`              | Files, steps and Claude's answer of snapshot N.                                                      |
| `/tm stats`               | Number of snapshots, disk use and mode of this project.                                              |
| `/tm git`                 | Prints the git command for browsing the history yourself.                                            |

In the pane, **Undo this** reverts the selected turn or step. **Travel to before** and **Travel to after** move the
whole project and ask for a second press.

## Heat map

| Command                                | What it does                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tm heat [30d] [rework\|undo\|owner]` | Lists the hottest files and opens the Heat pane: a treemap of the project, one folder at a time.                                                                           |
| `/tm heat open [30d]`                  | Writes the map as one self-contained HTML page to `~/.claude/time-machine/heat/` and opens it in your browser: zoom into folders, hover for numbers, filter the file list. |

In the pane, pick a folder to go in and `b` to go back up; `1` to `4` change the color; `o` opens the page. Picking a
file lists the turns that changed it, and picking one of those opens it in the Time machine pane, ready to review or
undo.

Size is every line changed in a file. The color is one of:

| Color    | What it counts                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------- |
| `churn`  | Lines added plus deleted by Claude's steps.                                                         |
| `rework` | Later turns that changed a file Claude had already changed: the places Claude keeps coming back to. |
| `undo`   | Undos that put the file back.                                                                       |
| `owner`  | Claude's share of the lines changed, from blue (others) to orange (Claude).                         |

"Others" is everything that was not one of Claude's tools: you, your editor, a formatter on save, a `git pull` or a
branch switch. These are counts of what happened, not a verdict on the code: a file can be hot because it is where the
work is. The window is the history you kept; `30d` narrows it. A single change too large to read (a checkout of tens of
thousands of files) is left out. The page uses no network and no model calls.

## Going back

| Command                       | What it does                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tm undo [N\|N.k] [--force]` | Reverts turn N, or step k of it. Without an argument, the latest turn. Files changed by someone else since are left alone and listed; `--force` overwrites them (still undoable). |
| `/tm redo`                    | Reverts the latest undo.                                                                                                                                                          |
| `/tm travel N\|name`          | Puts every file back to how it was at snapshot N or a saved checkpoint.                                                                                                           |
| `/tm save [name]`             | Saves the project as it is now under a name.                                                                                                                                      |

## Taking work out

| Command                              | What it does                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tm commit [N] [message] [--force]` | Commits the files turn N changed to your current branch, as the turn left them. Your other changes, your files and the rest of the index are untouched. Files your repository ignores are left out. Refuses during a merge or rebase, and, without `--force`, when those files have staged changes. |
| `/tm branch N name`                  | Creates branch `name` on top of `HEAD` holding the whole project as it was at snapshot N. `HEAD`, the index and your files do not change.                                                                                                                                                           |
| `/tm patch [N]`                      | Writes turn N as a patch (binary files included) to `~/.claude/time-machine/patches/` and copies it to the clipboard. Apply with `git apply`.                                                                                                                                                       |

## Modes

| Command      | Effect                                                    |
| ------------ | --------------------------------------------------------- |
| `/tm on`     | Snapshot every turn and tool call.                        |
| `/tm manual` | Snapshot only on `/tm save`.                              |
| `/tm off`    | No snapshots. The existing history stays and can be used. |

The mode is stored per project and survives restarts. Until you set one, a git project is `on` and any other folder is
`off`, so starting Claude in `~` or `/tmp` never snapshots everything under it. The home folder and `/` can't be
turned on.

## Keeping history small

| Command                   | What it does                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `/tm prune 30d`           | Forgets snapshots older than 30 days. The oldest kept state becomes the new baseline.         |
| `/tm prune 50`            | Keeps only the newest 50 entries.                                                             |
| `/tm retain 30d` / `off`  | Prunes by age automatically, once a day at session start.                                     |
| `/tm projects`            | Lists every project with a history: size, last activity, and whether its folder still exists. |
| `/tm projects rm N --yes` | Deletes project N's history.                                                                  |

## `.tmignore`

A `.tmignore` file at the project root, in `.gitignore` syntax, lists paths that are never snapshotted, even when git
tracks them. Useful for large data folders or files you don't want copied:

```
data/
*.sqlite
.env
```

## Browsing with git

The history is an ordinary git repository:

```sh
alias tmgit="git --git-dir=$HOME/.claude/time-machine/<id>.git --work-tree=$PWD"   # /tm git prints this
tmgit log --stat refs/tm/timeline
tmgit show 19a9e6f
tmgit diff 303149e 19a9e6f
```
