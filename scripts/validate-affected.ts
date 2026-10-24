// What CI would fail on, for the projects that the branch touches (pre-push hook). No Docker, no
// database. A branch that only changes docs/ is not checked.
// Usage: tsx scripts/validate-affected.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { exit } from 'node:process'

import { isDocsOnly } from './lib/affected'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function exists(ref: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref]).status === 0
}

const baseRef = exists('origin/main') ? 'origin/main' : 'main'
const base = git('merge-base', baseRef, 'HEAD')
const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)

if (changed.length === 0) {
  console.log(`nothing changed since ${baseRef}: nothing to check`)
  exit(0)
}
if (isDocsOnly(changed)) {
  console.log('only docs/ changed: nothing to check')
  exit(0)
}

const STEPS: { name: string; command: string[] }[] = [
  {
    name: 'lint, type-check and test (affected)',
    command: [
      'exec',
      'nx',
      'affected',
      '--targets=lint,type-check,test',
      `--base=${base}`,
      '--head=HEAD'
    ]
  },
  { name: 'format:check', command: ['format:check'] },
  { name: 'validate:deprecations', command: ['validate:deprecations'] },
  { name: 'validate:translations', command: ['validate:translations'] },
  { name: 'validate:rollbacks', command: ['validate:rollbacks'] },
  { name: 'validate:isolation', command: ['validate:isolation'] }
]

for (const { name, command } of STEPS) {
  console.log(`\n> ${name}`)
  const result = spawnSync('pnpm', command, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\n${name} failed: fix it before pushing (CI would fail on it too)`)
    exit(result.status ?? 1)
  }
}
console.log('\nall checks passed')
