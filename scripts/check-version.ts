// Fails when package.json, the plugin manifest and the changelog disagree on
// the version, or (on a tag build) when the tag does not match them.

import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
const plugin = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8')) as { version: string }
const changelog = await readFile('CHANGELOG.md', 'utf8')
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined

const problems: string[] = []
if (plugin.version !== pkg.version) problems.push(`plugin.json is ${plugin.version}, package.json is ${pkg.version}`)
if (!changelog.includes(`## [${pkg.version}]`)) problems.push(`CHANGELOG.md has no section for ${pkg.version}`)
if (tag !== undefined && tag !== `v${pkg.version}`) problems.push(`tag ${tag} does not match version ${pkg.version}`)

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`version ${pkg.version} ok`)
