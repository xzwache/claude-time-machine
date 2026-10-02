// The time machine's type contract: the values it keeps in `$.state`, and the
// shapes of a snapshot that hooks/core.ts reads off the shadow repository.

/**
 * What a snapshot records: the first snapshot (`baseline`), changes nobody's
 * tool call made (`outside`), one tool call of Claude's (`step`), the marker
 * that closes a turn (`turn`), an ignored file's content before Claude's
 * first edit (`capture`), a snapshot saved by name (`checkpoint`), and the
 * time machine's own `undo` and `travel`.
 */
export type EntryKind = 'baseline' | 'outside' | 'turn' | 'step' | 'capture' | 'checkpoint' | 'undo' | 'travel'

/** When snapshots are taken: around every turn, only on /tm save, or never. */
export type Mode = 'auto' | 'manual' | 'off'

export type Counts = { added: number; modified: number; deleted: number }

export type ChangeStatus = 'added' | 'modified' | 'deleted'

export type Change = { status: ChangeStatus; path: string }

/** One snapshot on the timeline: a commit of the shadow repository. */
export type Entry = {
  id: string
  parent: string | null
  time: number
  kind: EntryKind
  title: string
  prompt: string
  /** Claude's final answer, for a turn. */
  answer: string
  /** The Claude Code session that made it, when one did. */
  session: string | null
  /** For a turn: the snapshot its first step started from. */
  base: string | null
  /** For an undo or a travel: the snapshot it went back to or reverted. */
  target: string | null
  isInterrupted: boolean
  /** For a turn, what its steps changed together; else the commit's own. */
  changes: Change[]
  counts: Counts
  /** For a turn: its steps and the outside changes between them, oldest first. */
  steps: string[]
}

/** One project's shadow repository, for /tm projects. */
export type Project = {
  name: string
  gitDir: string
  root: string
  isRootPresent: boolean
  entries: number
  bytes: number
  lastTime: number
}

/** What the pane shows for the selected snapshot. */
export type Details = {
  id: string
  steps: Entry[]
  /** The first files, and how many more there are. */
  changes: Change[]
  more: number
  file: string | null
  diff: string
}

/** The band above the prompt after a turn that changed files. */
export type Band = {
  id: string
  summary: string
  result: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'time-machine': {
      entries: Entry[]
      selected: string | null
      details: Details | null
      confirm: string | null
      notice: string
      band: Band | null
    }
  }
}
