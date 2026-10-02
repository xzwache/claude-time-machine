// The security diff: which of the files a turn changed deserve a second look.
// CI and git hooks, dependencies and install scripts, secrets, container and
// infrastructure config, new executables and mass deletes. Judged on what
// landed on disk, so a change made through Bash counts like one made by Edit.

import type { Finding, FindingKind } from '../types'
import { chunks } from './git.ts'
import type { ShadowRepo } from './shadow.ts'
import type { PathPlan } from './timeline.ts'

const RULES: readonly [FindingKind, RegExp][] = [
  [
    'ci',
    /^(\.github\/(workflows|actions)\/|\.circleci\/|\.buildkite\/|\.gitlab-ci\.ya?ml$|azure-pipelines\.ya?ml$|bitbucket-pipelines\.ya?ml$|\.travis\.ya?ml$|\.drone\.ya?ml$)|(^|\/)Jenkinsfile$/,
  ],
  ['hooks', /^(\.husky|\.githooks|\.git-hooks)\/|^\.pre-commit-config\.ya?ml$|(^|\/)lefthook(-local)?\.ya?ml$/],
  [
    'deps',
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?|poetry\.lock|uv\.lock|setup\.(py|cfg)|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/,
  ],
  [
    'secrets',
    /(^|\/)(\.env(\.(?!(example|sample|template|dist)$)[^/]+)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|kubeconfig|id_(rsa|dsa|ecdsa|ed25519))$|\.(pem|key|p12|pfx|jks|keystore)$/,
  ],
  ['container', /(^|\/)((Dockerfile|Containerfile)(\.[^/]+)?|(docker-)?compose(\.[^/]+)?\.ya?ml)$/],
  ['infra', /\.(tf|tfvars)$|^(k8s|kubernetes|helm|deploy)\/.+\.ya?ml$/],
]

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

const INSTALL_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'preuninstall',
  'uninstall',
  'postuninstall',
])

const EXECUTABLE = '100755'
const MASS_DELETE = 20
const SHOWN_ITEMS = 2
const COMMAND_CHARS = 60

/** The kind of a path by its name alone; undefined for an ordinary file. */
export function kindOfPath(path: string): FindingKind | undefined {
  return RULES.find(([, rule]) => rule.test(path))?.[0]
}

type Manifest = {
  dependencies: Map<string, string>
  scripts: Map<string, string>
}

function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) return { dependencies: new Map(), scripts: new Map() }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const record = json as Record<string, unknown>
  const entries = (field: unknown) =>
    typeof field === 'object' && field !== null
      ? Object.entries(field).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      : []
  return {
    dependencies: new Map(DEPENDENCY_FIELDS.flatMap(field => entries(record[field]))),
    scripts: new Map(entries(record.scripts)),
  }
}

/**
 * What changed in a package.json between two versions (undefined: absent):
 * `+name`, `-name` and `name a→b` for dependencies, and the install scripts
 * added or changed. Undefined when either side is not valid JSON.
 */
export function manifestChanges(
  before: string | undefined,
  after: string | undefined,
): { dependencies: string[]; scripts: string[] } | undefined {
  const old = parseManifest(before)
  const now = parseManifest(after)
  if (!old || !now) return undefined
  const dependencies: string[] = []
  for (const [name, version] of now.dependencies) {
    const was = old.dependencies.get(name)
    if (was === undefined) dependencies.push(`+${name}`)
    else if (was !== version) dependencies.push(`${name} ${was}→${version}`)
  }
  for (const name of old.dependencies.keys()) if (!now.dependencies.has(name)) dependencies.push(`-${name}`)
  const scripts = [...now.scripts]
    .filter(([name, command]) => INSTALL_SCRIPTS.has(name) && old.scripts.get(name) !== command)
    .map(
      ([name, command]) =>
        `${name}: ${command.length > COMMAND_CHARS ? `${command.slice(0, COMMAND_CHARS - 1)}…` : command}`,
    )
  return { dependencies, scripts }
}

/** What one changed path looked like before and after, as `assess` needs it. */
export type PathFacts = {
  path: string
  isDeleted: boolean
  modeBefore: string | undefined
  modeAfter: string | undefined
  /** The two versions of a package.json; absent for any other file. */
  manifest?: { before: string | undefined; after: string | undefined }
}

export function assess(facts: readonly PathFacts[]): Finding[] {
  const findings: Finding[] = []
  for (const fact of facts) {
    const kind = kindOfPath(fact.path)
    const changes = fact.manifest && manifestChanges(fact.manifest.before, fact.manifest.after)
    if (changes) {
      if (changes.dependencies.length > 0) {
        findings.push({ kind: 'deps', paths: [fact.path], items: changes.dependencies })
      }
      if (changes.scripts.length > 0) {
        findings.push({ kind: 'install-script', paths: [fact.path], items: changes.scripts })
      }
    } else if (kind !== undefined) {
      findings.push({ kind, paths: [fact.path], items: [] })
    }
    if (fact.modeAfter === EXECUTABLE && fact.modeBefore !== EXECUTABLE && kind === undefined) {
      findings.push({ kind: 'executable', paths: [fact.path], items: [] })
    }
  }
  const deleted = facts.filter(fact => fact.isDeleted).map(fact => fact.path)
  if (deleted.length >= MASS_DELETE) findings.push({ kind: 'mass-delete', paths: deleted, items: [] })
  return findings
}

const LABELS: Record<FindingKind, string> = {
  ci: 'CI config',
  hooks: 'git hooks',
  deps: 'dependencies',
  'install-script': 'install script',
  secrets: 'secrets',
  container: 'container config',
  infra: 'infrastructure',
  executable: 'new executable',
  'mass-delete': 'files deleted',
}

/** One line for the band: `CI config · deps +left-pad -lodash · install script · .env`. */
export function alertLine(findings: readonly Finding[]): string {
  const byKind = new Map<FindingKind, Finding[]>()
  for (const finding of findings) byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding])
  return [...byKind]
    .map(([kind, found]) => {
      const items = found.flatMap(one => one.items)
      const paths = found.flatMap(one => one.paths)
      if (kind === 'mass-delete') return `${paths.length} ${LABELS[kind]}`
      if (kind === 'deps' && items.length > 0) return `deps ${listed(items)}`
      if (kind === 'secrets') return listed(paths.map(path => path.slice(path.lastIndexOf('/') + 1)))
      return LABELS[kind]
    })
    .join(' · ')
}

/** The lines `/tm show` prints under "Sensitive:". */
export function findingLines(findings: readonly Finding[]): string[] {
  return findings.map(finding => {
    const where = finding.kind === 'mass-delete' ? `${finding.paths.length} files` : finding.paths.join(', ')
    const what = finding.items.length > 0 ? `  ${finding.items.join(', ')}` : ''
    return `  ⚠ ${LABELS[finding.kind].padEnd(16)} ${where}${what}`
  })
}

/** Every path the findings name, once. */
export function findingPaths(findings: readonly Finding[]): string[] {
  return [...new Set(findings.flatMap(finding => finding.paths))]
}

function listed(items: readonly string[]): string {
  const more = items.length - SHOWN_ITEMS
  return `${items.slice(0, SHOWN_ITEMS).join(' ')}${more > 0 ? ` +${more} more` : ''}`
}

/** The findings for the paths an entry changed, read off the shadow repository. */
export async function findingsOf(shadow: ShadowRepo, plans: readonly PathPlan[]): Promise<Finding[]> {
  const modesBefore = await modesAt(shadow, plans, plan => plan.before)
  const modesAfter = await modesAt(shadow, plans, plan => plan.after)
  const facts: PathFacts[] = []
  for (const plan of plans) {
    const isDeleted = plan.lastStatus === 'deleted'
    if (plan.isNew && isDeleted) continue
    const fact: PathFacts = {
      path: plan.path,
      isDeleted,
      modeBefore: plan.isNew ? undefined : modesBefore.get(`${plan.before}:${plan.path}`),
      modeAfter: isDeleted ? undefined : modesAfter.get(`${plan.after}:${plan.path}`),
    }
    if (/(^|\/)package\.json$/.test(plan.path)) {
      fact.manifest = {
        before: plan.isNew ? undefined : await blob(shadow, plan.before, plan.path),
        after: isDeleted ? undefined : await blob(shadow, plan.after, plan.path),
      }
    }
    facts.push(fact)
  }
  return assess(facts)
}

/** File modes at each plan's `pick` commit, keyed `commit:path`. */
async function modesAt(
  shadow: ShadowRepo,
  plans: readonly PathPlan[],
  pick: (plan: PathPlan) => string,
): Promise<Map<string, string>> {
  const byCommit = new Map<string, string[]>()
  for (const plan of plans) byCommit.set(pick(plan), [...(byCommit.get(pick(plan)) ?? []), plan.path])
  const modes = new Map<string, string>()
  for (const [commit, paths] of byCommit) {
    for (const chunk of chunks(paths)) {
      const out = await shadow.git(['ls-tree', '-z', '--full-tree', commit, '--', ...chunk], { trim: false })
      for (const line of out.split('\0').filter(Boolean)) {
        const [info = '', path = ''] = line.split('\t')
        modes.set(`${commit}:${path}`, info.split(' ')[0] ?? '')
      }
    }
  }
  return modes
}

async function blob(shadow: ShadowRepo, commit: string, path: string): Promise<string | undefined> {
  const ref = `${commit}:${path}`
  return (await shadow.succeeds(['cat-file', '-e', ref])) ? shadow.gitComplete(['cat-file', 'blob', ref]) : undefined
}
