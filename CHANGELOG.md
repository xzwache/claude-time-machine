# Changelog

All notable changes to this project are documented here. Versions before 0.5.0 were not tagged. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Secrets are left out of snapshots: `.env` files (not `.env.example`), keys and certificates, `.npmrc`, `.pypirc`,
  `.netrc`, credentials and kubeconfigs are never copied, and undo and travel never write them, even from an older
  snapshot that holds a copy. A turn whose file tools wrote one still flags it in the security diff. In a history made
  before this, the next snapshot records them as removed from snapshots (not from your project); older snapshots keep
  their copies until the history is deleted with `/tm projects rm N --yes`.

### Added

- `/tm secrets keep | skip`: keep secrets in a project's snapshots, so they can be undone, or leave them out.

## [0.7.0] - 2026-10-02

### Added

- Security diff: after a turn that touched CI config, git hooks, dependencies or an install script, secrets, container
  or infrastructure config, a new executable or many deleted files, the band says what with **Undo these** (`x`) to
  revert only that. `/tm show` lists it under "Sensitive" and the pane marks those files.
- `/tm undo [N] --sensitive`: revert only what the security diff flags in a turn.

## [0.6.0] - 2026-10-02

### Added

- `/tm heat`: where Claude worked, as a treemap of the project in a pane (folder by folder, colored by Claude's
  churn, rework, undos or Claude's share against everyone else's) plus the hottest files. Picking a file lists the
  turns that changed it.
- `/tm heat open`: the same map as a self-contained, zoomable HTML page opened in the browser.
- `npm run sandbox` for contributors: a throwaway project with a real history, and `--run` to run every `/tm`
  command on it through `claude -p`.

### Changed

- The README has license and support sections.

## [0.5.0] - 2026-10-02

### Changed

- Source code moved to `src/`; the time machine is split into the shadow repository, history, pending turns, restore
  and prune modules. No change in behaviour.
- Code is formatted with Prettier, checked in CI.

### Added

- Release workflow: pushing a `v*` tag publishes a GitHub release from this changelog.
- CI checks that `package.json`, `plugin.json` and the changelog agree on the version.
- Contributing guide, security policy, code of conduct, issue and pull request templates.

## 0.4.1 - 2026-10-02

### Fixed

- The time machine starts on its own only in git projects. Started in a home folder or `/tmp`, it no longer snapshots
  everything under it. The home folder and `/` can never be turned on.
- The pane no longer stores every entry's file list, which could exceed the state size limit.

## 0.4.0 - 2026-10-02

### Added

- `/tm commit [N] [message]`: commit what a turn changed to the current branch.
- `/tm branch N name`: a new branch holding a whole snapshot.
- `/tm patch [N]`: a turn as a patch file, also copied to the clipboard.
- `/tm retain 30d`: prune old snapshots once a day.
- `scripts/bench.ts` and measured costs in the README.
- GitHub Actions CI.

### Changed

- Faster snapshots on large projects: about 40% less time per Bash call on a 67,000-file repository.

## 0.3.0 - 2026-10-02

### Added

- `/tm on`, `/tm off`, `/tm manual`, per project.
- `/tm save [name]` checkpoints and `/tm travel <name>`.
- `.tmignore` to keep paths out of snapshots.
- Read-only Bash commands (`ls`, `grep`, `git status`…) take no snapshots.

### Fixed

- Undoing a turn older than the first 800 snapshots undid only part of it.
- `prune` could cut a turn of another session that started earlier.
- A second `/tm redo` undid the turn again.

## 0.2.0 - 2026-10-02

### Added

- Each tool call that changes files is its own step; undo a whole turn or one step.
- Edits made during a turn by anything else are kept apart and survive an undo.
- Undo band above the prompt, status line, `/tm projects`, `/tm prune`, `/tm stats`.
- Claude's final answer is kept with each turn.
- Small ignored files such as `.env` are snapshotted.
- Several sessions in one project keep their steps apart.

## 0.1.0 - 2026-10-02

### Added

- First release: a snapshot before and after every turn in a shadow git repository, `/tm` pane, `/tm undo`,
  `/tm redo`, `/tm travel`, `/tm log`.

[Unreleased]: https://github.com/xzwache/claude-time-machine/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/xzwache/claude-time-machine/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/xzwache/claude-time-machine/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/xzwache/claude-time-machine/releases/tag/v0.5.0
