// The public surface: what the hooks and the tests use.

export { TimeMachine } from './time-machine.ts'
export { deleteProject, listProjects } from './projects.ts'
export type { BranchReport, CommitReport } from './export.ts'
export type { Deps, Exec, ExecInit, ExecResult } from './git.ts'
export type { PruneReport } from './prune.ts'
export type { RestoreReport } from './restore.ts'
