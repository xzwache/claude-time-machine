// The time machine's type contract: the values it keeps in `$.state`, and the
// shapes of a snapshot that hooks/core.ts reads off the shadow repository.

export type EntryKind = 'baseline' | 'outside' | 'turn' | 'capture' | 'undo' | 'travel'

export type Counts = { added: number; modified: number; deleted: number }

/** One snapshot on the timeline: a commit of the shadow repository. */
export type Entry = {
  id: string
  parent: string | null
  time: number
  kind: EntryKind
  title: string
  prompt: string
  target: string | null
  isInterrupted: boolean
  counts: Counts
}

export type ChangeStatus = 'added' | 'modified' | 'deleted'

export type Change = { status: ChangeStatus; path: string }

/** What the pane shows for the selected snapshot. */
export type Details = {
  id: string
  changes: Change[]
  file: string | null
  diff: string
}

declare module 'claude-code' {
  interface PluginState {
    'time-machine': {
      entries: Entry[]
      selected: string | null
      details: Details | null
      confirm: string | null
      notice: string
    }
  }
}
