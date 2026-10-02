// Prints the CHANGELOG.md section of one version: node scripts/release-notes.ts 0.5.0

import { readFile } from 'node:fs/promises'

const version = process.argv[2]
if (!version) throw new Error('usage: node scripts/release-notes.ts <version>')

const lines = (await readFile('CHANGELOG.md', 'utf8')).split('\n')
const start = lines.findIndex(line => line.startsWith(`## [${version}]`))
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`)
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
console.log(
  lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim(),
)
