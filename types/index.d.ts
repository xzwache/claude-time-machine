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

/** What the heat map colors by: Claude's lines, files Claude came back to in later turns, undos, or who wrote it. */
export type HeatMetric = 'churn' | 'rework' | 'undo' | 'owner'

/** A file or folder of the heat map, with the sums of everything under it. */
export type HeatNode = {
  name: string
  path: string
  isDir: boolean
  /** Lines added plus deleted by Claude's steps. */
  claude: number
  /** Lines added plus deleted by anything else. */
  human: number
  /** Claude's steps that changed it. */
  edits: number
  /** Later turns that came back to a file Claude had already changed. */
  rework: number
  undos: number
  files: number
  children?: HeatNode[]
}

/** What the heat pane shows: one folder's children, and how to color them. */
export type HeatView = {
  metric: HeatMetric
  /** The folder shown, '' for the project root. */
  path: string
  /** Its children, the biggest first, without their own children. */
  nodes: HeatNode[]
  total: HeatNode
  turns: number
  since: number
  /** The interactive page, once written. */
  page: string | null
  notice: string
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
      heat: HeatView | null
    }
  }
}
