// Fails when the shard counts of the CI disagree: the matrices of the security suite, the local loop of
// tests/project.json, the e2e slices, and the ClamAV image of the CI against the compose file.
// Usage: tsx scripts/validate-ci-shards.ts
import { readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { clamavImageOf, findShardProblems } from './lib/ci-shards'

const read = (file: string): string => readFileSync(file, 'utf8')

interface ProjectFile {
  targets?: Record<string, { options?: { command?: string } }>
}
const project = JSON.parse(read('tests/project.json')) as ProjectFile
const securityCommand = project.targets?.['test-security']?.options?.command ?? ''

const problems = findShardProblems({
  workflow: read('.github/workflows/ci.yml'),
  securityCommand,
  composeClamav: clamavImageOf(read('docker-compose.yml')),
  actionClamav: clamavImageOf(read('.github/actions/clamav-start/action.yml'))
})

if (problems.length > 0) {
  console.error('The shard counts of the CI disagree:')
  for (const problem of problems) console.error(`  ${problem}`)
  exit(1)
}
console.log(
  'shard counts of the CI agree (security matrices, local loop, e2e slices, clamav image)'
)
