// Every project's shadow repository under ~/.claude/time-machine: listing
// them for /tm projects, and deleting one.

import type { Project } from '../types'
import { diskUsage } from './git.ts'
import type { Exec } from './git.ts'

const PROJECT_NAME = /^[0-9a-f]{16}\.git$/
const TIMELINE = 'refs/tm/timeline'

/** Every project's shadow repository under `home`, newest activity first. */
export async function listProjects(exec: Exec, home: string): Promise<Project[]> {
  const listed = await exec(['ls', '-1', home], {})
  const names = listed.exitCode === 0 ? listed.stdout.split('\n').filter(name => PROJECT_NAME.test(name)) : []
  const projects: Project[] = []
  for (const name of names) {
    const gitDir = `${home}/${name}`
    const git = async (args: string[]) => (await exec(['git', `--git-dir=${gitDir}`, ...args], {})).stdout.trim()
    const root = await git(['config', 'tm.root'])
    const entries = Number(await git(['rev-list', '--count', TIMELINE])) || 0
    const lastTime = (Number(await git(['log', '-1', '--format=%ct', TIMELINE])) || 0) * 1000
    const isRootPresent = root !== '' && (await exec(['test', '-d', root], {})).exitCode === 0
    projects.push({ name, gitDir, root, isRootPresent, entries, bytes: await diskUsage(exec, gitDir), lastTime })
  }
  return projects.sort((a, b) => b.lastTime - a.lastTime)
}

/** Deletes one project's shadow repository: its whole history. */
export async function deleteProject(exec: Exec, home: string, name: string): Promise<void> {
  if (!PROJECT_NAME.test(name)) throw new Error(`Not a time machine repository: ${name}`)
  const result = await exec(['rm', '-rf', '--', `${home}/${name}`], {})
  if (result.exitCode !== 0) throw new Error(`Could not delete ${name}: ${result.stderr.trim()}`)
}
