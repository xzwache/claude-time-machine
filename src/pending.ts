// Turns in progress, one per session, kept as refs under refs/tm/pending/ so
// a crashed session's turn is found and closed by its next one.

import type { ShadowRepo } from './shadow.ts'

export type PendingTurn = { turnId: string; prompt: string; startedAt: number; base: string; session: string }

const PENDING = 'refs/tm/pending/'
const STALE_MS = 12 * 60 * 60 * 1000

export class PendingTurns {
  private readonly shadow: ShadowRepo
  /** Each session's pending turn as this process last read or wrote it. */
  private readonly known = new Map<string, PendingTurn | null>()

  constructor(shadow: ShadowRepo) {
    this.shadow = shadow
  }

  async get(session: string): Promise<PendingTurn | undefined> {
    const known = this.known.get(session)
    if (known !== undefined) return known ?? undefined
    const id = await this.shadow.objectId(refOf(session))
    const read = id === undefined ? undefined : await this.load(id)
    this.known.set(session, read ?? null)
    return read
  }

  async set(turn: PendingTurn): Promise<void> {
    const blob = await this.shadow.git(['hash-object', '-w', '--stdin'], { stdin: JSON.stringify(turn) })
    await this.shadow.git(['update-ref', refOf(turn.session), blob])
    this.known.set(turn.session, turn)
  }

  async clear(session: string): Promise<void> {
    await this.shadow.git(['update-ref', '-d', refOf(session)])
    this.known.set(session, null)
  }

  async any(): Promise<boolean> {
    return (await this.refs()).length > 0
  }

  /** Forgets turns other sessions left open long ago (a crashed session). */
  async dropStale(): Promise<void> {
    for (const { ref, blob } of await this.refs()) {
      const turn = await this.load(blob)
      if (turn && Date.now() - turn.startedAt <= STALE_MS) continue
      await this.shadow.git(['update-ref', '-d', ref])
      this.known.clear()
    }
  }

  private async refs(): Promise<{ ref: string; blob: string }[]> {
    const out = await this.shadow.git(['for-each-ref', '--format=%(refname) %(objectname)', PENDING])
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [ref = '', blob = ''] = line.split(' ')
        return { ref, blob }
      })
  }

  private async load(blob: string): Promise<PendingTurn | undefined> {
    try {
      return JSON.parse(await this.shadow.git(['cat-file', 'blob', blob])) as PendingTurn
    } catch {
      return undefined
    }
  }
}

function refOf(session: string): string {
  return `${PENDING}${session.replace(/[^A-Za-z0-9_-]/g, '') || 'default'}`
}
