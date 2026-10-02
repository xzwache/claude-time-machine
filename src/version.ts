// The oldest Claude Code the time machine runs on: the mod API it uses (panes,
// bands, Raster, tool hooks) is there from this release on.

export const MIN_CLAUDE_CODE = '2.1.287'

/**
 * What to tell the person when this Claude Code is too old, or undefined when
 * it is recent enough. `version` is its release (`2.1.280`, `2.1.280-dev`);
 * undefined for a release so old it has no way to say. A version not spelled
 * as a release is let through.
 */
export function versionProblem(version: string | undefined): string | undefined {
  const upgrade = `Time machine needs Claude Code ${MIN_CLAUDE_CODE} or newer`
  if (version === undefined) return `${upgrade}. Update it with: claude update`
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!found) return undefined
  const have = found.slice(1).map(Number)
  const need = MIN_CLAUDE_CODE.split('.').map(Number)
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0
    const b = need[i] ?? 0
    if (a !== b) return a > b ? undefined : `${upgrade}; this is ${version}. Update it with: claude update`
  }
  return undefined
}
