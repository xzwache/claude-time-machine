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
| `/tm undo [N] --sensitive`    | Reverts only the files the security diff flags in turn N, and leaves the rest of the turn as it is.                                                                               |
| `/tm redo`                    | Reverts the latest undo.                                                                                                                                                          |
| `/tm travel N\|name`          | Puts every file back to how it was at snapshot N or a saved checkpoint.                                                                                                           |
| `/tm save [name]`             | Saves the project as it is now under a name.                                                                                                                                      |

## Security diff

After every turn, the files Claude changed are checked for what deserves a second look. It is judged on what landed on
disk, so a change made through Bash counts like one made by Edit. The band names what it found and offers **Undo
these** (`x`); `/tm show N` lists it under "Sensitive", and the pane marks those files with `⚠`.

| Flag             | When                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| CI config        | `.github/workflows`, `.github/actions`, GitLab, CircleCI, Buildkite, Azure, Bitbucket, Travis, Drone, a `Jenkinsfile` |
| git hooks        | `.husky/`, `.githooks/`, `.pre-commit-config.yaml`, `lefthook.yml`                                                    |
| dependencies     | Dependencies added, removed or changed in a `package.json`; any change to a lockfile or another ecosystem's manifest  |
| install script   | A `preinstall`, `install`, `postinstall`, `prepare` or other lifecycle script added or changed in a `package.json`    |
| secrets          | `.env` files (not `.env.example`), keys and certificates, `.npmrc`, `.pypirc`, `.netrc`, credentials, a kubeconfig    |
| container config | Dockerfiles, Containerfiles, compose files                                                                            |
| infrastructure   | Terraform files, YAML under `k8s/`, `kubernetes/`, `helm/` or `deploy/`                                               |
| new executable   | A file that became executable, unless one of the flags above already covers it                                        |
| files deleted    | 20 or more files deleted in one turn                                                                                  |

A version bump in `package.json` alone is not flagged. The flags point at changes worth reading; they do not say the
change is wrong, and a change the rules do not know about is not flagged.

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

## Command guard

Before Claude runs a shell command, the guard looks for effects undo cannot take back. In the default mode it has
Claude Code ask you first, with the reason, even where your permission settings would let the command run; the worst
are refused, and you can still run those yourself. In a `claude -p` run there is no one to ask, so such a command does
not run, and Claude is told why. A command that only changes the project's files is left alone: undo covers it.

| Command                   | What it does                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- |
| `/tm guard`               | The mode, the rules allowed in this project, and every rule.                     |
| `/tm guard ask`           | The default: ask before a risky command, refuse the worst.                       |
| `/tm guard warn`          | Never ask or refuse; a toast says what the command does.                         |
| `/tm guard off`           | No questions, no warnings.                                                       |
| `/tm guard allow RULE`    | Stop asking about one rule in this project. The refused rules cannot be allowed. |
| `/tm guard reset`         | Ask about every rule again.                                                      |
| `/tm guard check COMMAND` | What the guard would say about a command, without running it.                    |

| Rule              | When                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `delete-root`     | Refused. `rm` of `/`, your home folder or above it, or `--no-preserve-root`.                                                                    |
| `disk`            | Refused. `mkfs`, `dd of=/dev/…`, a redirect into a disk device, a fork bomb.                                                                    |
| `delete-outside`  | `rm` or `mv` of the project itself or of files outside it (temporary folders aside).                                                            |
| `force-push`      | `git push --force`, `-f`, `--force-with-lease`, `--mirror`, a `+refspec`.                                                                       |
| `remote-delete`   | `git push --delete`, a `:branch` refspec.                                                                                                       |
| `history-rewrite` | `git filter-branch`, `git filter-repo`.                                                                                                         |
| `clean-ignored`   | `git clean -x` or `-X`: ignored files, which snapshots do not keep.                                                                             |
| `pipe-to-shell`   | `curl` or `wget` piped into a shell or an interpreter, `bash <(curl …)`, `sh -c "$(curl …)"`.                                                   |
| `privilege`       | `sudo`, `doas`, `su`.                                                                                                                           |
| `publish`         | `npm`/`yarn`/`pnpm`/`bun`/`cargo`/`poetry publish` (not `--dry-run`), `twine upload`, `gem push`, `docker push`.                                |
| `infra`           | `terraform`/`tofu apply`, `destroy`, `import`; `pulumi up`; `kubectl apply`, `delete`…; `helm install`…; deletes through `aws`, `gcloud`, `az`. |
| `database`        | `DROP` or `TRUNCATE` through `psql`, `mysql`, `sqlite3`…; `dropdb`; `prisma migrate reset`; `rails db:drop`.                                    |
| `docker-prune`    | `docker system prune`, `docker volume rm` or `prune`.                                                                                           |
| `persistence`     | Writes to your shell profile, `~/.ssh/` or `/etc/`; `crontab`; `launchctl load`; `systemctl enable`.                                            |

The guard reads the command line as written: `sudo`, `env`, `nohup`, `timeout` and `bash -c "…"` are seen through, and
a `cd` earlier on the same line is followed. A command assembled at run time (a variable, a script file) is not.

## Secrets

| Command            | What it does                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `/tm secrets`      | Says whether this project's snapshots keep secrets.                                                           |
| `/tm secrets skip` | The default: `.env` files, keys and other credentials are never copied, and undo and travel never write them. |
| `/tm secrets keep` | Keeps them in this project's snapshots, so a change to them can be undone.                                    |

Skipping does not remove copies made while they were kept; `/tm projects rm N --yes` deletes the whole history.

## `.tmignore`

A `.tmignore` file at the project root, in `.gitignore` syntax, lists paths that are never snapshotted, even when git
tracks them. Useful for large data folders or files you don't want copied:

```
data/
*.sqlite
```

## Browsing with git

The history is an ordinary git repository:

```sh
alias tmgit="git --git-dir=$HOME/.claude/time-machine/<id>.git --work-tree=$PWD"   # /tm git prints this
tmgit log --stat refs/tm/timeline
tmgit show 19a9e6f
tmgit diff 303149e 19a9e6f
```
