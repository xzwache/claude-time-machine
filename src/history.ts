// Reading the timeline: commits grouped into turns, entries by reference,
// and the plan for putting each path an entry touched back.

import type { Entry } from '../types'
import type { ShadowRepo } from './shadow.ts'
import { TIMELINE } from './shadow.ts'
import { group, isDefined, missingBases, planCommit, planTurn } from './timeline.ts'
import type { PathPlan, Raw } from './timeline.ts'

export type Timeline = { top: Entry[]; raws: Raw[]; byId: Map<string, Entry>; byRaw: Map<string, Raw> }

export class History {
  private readonly shadow: ShadowRepo
  private readonly window: number
  private cache: { tip: string; timeline: Timeline } | undefined

  /** `window`: how many commits a read starts with (tests shrink it). */
  constructor(shadow: ShadowRepo, window: number) {
    this.shadow = shadow
    this.window = window
  }

  /** Top-level entries, newest first. */
  async top(limit: number): Promise<Entry[]> {
    return (await this.read()).top.slice(0, limit)
  }

  async entry(ref: string): Promise<Entry | undefined> {
    const id = await this.shadow.resolve(ref)
    return id === undefined ? undefined : (await this.read(id)).byId.get(id)
  }

  async steps(turn: Entry): Promise<Entry[]> {
    if (turn.steps.length === 0) return []
    const { byId } = await this.read(turn.id)
    return turn.steps.map(step => byId.get(step)).filter(isDefined)
  }

  /** The newest checkpoint saved under `name` (any case). */
  async checkpoint(name: string): Promise<Entry | undefined> {
    const out = await this.shadow.git(['log', '--format=%H%x1f%s', '--grep=^tm-kind: checkpoint$', TIMELINE])
    const wanted = name.trim().toLowerCase()
    const found = out.split('\n').find(line => (line.split('\x1f')[1] ?? '').toLowerCase() === wanted)
    return found === undefined ? undefined : this.entry(found.split('\x1f')[0] ?? '')
  }

  /** For each path an entry changed: where it goes back to, and from what. */
  async plan(entry: Entry): Promise<PathPlan[]> {
    if (!entry.parent) return []
    if (entry.kind === 'turn' && entry.base !== null) return planTurn(entry, (await this.read(entry.id)).byRaw)
    return planCommit(entry.id, entry.parent, entry.changes)
  }

  /** The whole timeline, however long. */
  async all(): Promise<Timeline> {
    return toTimeline(await this.shadow.readRaws([TIMELINE]))
  }

  /**
   * The newest commits, grouped into turns. Reads `window` commits, and
   * further back while `including` is missing or a turn's base is, so every
   * turn read is whole.
   */
  private async read(including?: string): Promise<Timeline> {
    const tip = await this.shadow.tipId()
    let timeline = this.cache?.tip === tip ? this.cache.timeline : undefined
    for (let window = this.window; ; window *= 4) {
      const hasIt = timeline !== undefined && (including === undefined || timeline.byRaw.has(including))
      if (hasIt && timeline !== undefined && missingBases(timeline.raws).length === 0) break
      timeline = toTimeline(await this.shadow.readRaws([TIMELINE, '-n', String(window)]))
      if (timeline.raws.length < window) break
    }
    this.cache = { tip, timeline }
    return timeline
  }
}

function toTimeline(raws: Raw[]): Timeline {
  const { top, byId } = group(raws)
  return { top, raws, byId, byRaw: new Map(raws.map(raw => [raw.id, raw])) }
}
