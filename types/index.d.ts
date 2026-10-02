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
  /** The entry selected, without its file list: the timeline shown may not reach back to it. */
  entry: Entry | null
  steps: Entry[]
  /** The first files, and how many more there are. */
  changes: Change[]
  more: number
  file: string | null
  diff: string
}

/** What the security diff flags in a turn's changes. */
export type FindingKind =
  'ci' | 'hooks' | 'deps' | 'install-script' | 'secrets' | 'container' | 'infra' | 'executable' | 'mass-delete'

/** One flag of the security diff: the paths it is about, and what changed in them. */
export type Finding = {
  kind: FindingKind
  paths: string[]
  /** `+left-pad`, `react 18→19`, `postinstall: node setup.js`; empty when the path says it all. */
  items: string[]
}

/** The band above the prompt after a turn that changed files. */
export type Band = {
  id: string
  summary: string
  /** The security diff of the turn, as one line; null when nothing was flagged. */
  alert: string | null
  result: string | null
}

/** What the heat map colors by: Claude's lines, later turns back at a file, undos, or Claude's share. */
export type HeatMetric = 'churn' | 'rework' | 'undo' | 'owner'

/** A file or folder of the heat map, with the sums of everything under it. */
export type HeatNode = {
  name: string
  path: string
  isDir: boolean
  /** Lines added plus deleted by Claude's steps. */
  claude: number
  /** Lines added plus deleted by anything else. */
  others: number
  edits: number
  /** Later turns that came back to a file Claude had already changed. */
  rework: number
  undos: number
  files: number
  children?: HeatNode[]
}

/** A turn that changed the file picked in the heat pane. */
export type HeatTurn = { id: string; title: string; time: number }

/** What the heat pane shows: one folder's children, and how to color them. */
export type HeatView = {
  metric: HeatMetric
  /** The folder shown, '' for the project root. */
  path: string
  /** Where Up goes; null at the top. */
  parent: string | null
  /** The start of the window read, ms; null for the whole history. */
  from: number | null
  /** The folder's children, biggest first, without their own. */
  nodes: HeatNode[]
  total: HeatNode
  turns: number
  since: number
  /** The file picked, with the turns that changed it. */
  file: { path: string; turns: HeatTurn[] } | null
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
