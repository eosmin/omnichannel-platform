// What CI would fail on, for the projects that the branch touches (pre-push hook). No Docker, no
// database. A push that only changes docs/ is not checked.
// Usage: tsx scripts/validate-affected.ts [--since <sha>]
//   --since: the commit the remote branch is at, which the pre-push hook passes. What is pushed is
//   then the commits after it, so a documentation commit on top of code that was already checked
//   is not checked again.
import { execFileSync, spawnSync } from 'node:child_process'
import { argv, exit } from 'node:process'

import { isDocsOnly } from './lib/affected'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function exists(ref: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref]).status === 0
}

function changedSince(commit: string): string[] {
  return git('diff', '--name-only', commit, 'HEAD').split('\n').filter(Boolean)
}

const baseRef = exists('origin/main') ? 'origin/main' : 'main'
const base = git('merge-base', baseRef, 'HEAD')
const changed = changedSince(base)

if (changed.length === 0) {
  console.log(`nothing changed since ${baseRef}: nothing to check`)
  exit(0)
}

// A remote commit this clone does not have (a branch rewritten elsewhere) cannot tell what is
// pushed: then the whole branch is checked
const sinceIndex = argv.indexOf('--since')
const since = sinceIndex === -1 ? undefined : argv[sinceIndex + 1]
const pushed = since !== undefined && exists(`${since}^{commit}`) ? changedSince(since) : changed
if (isDocsOnly(pushed)) {
  console.log('only docs/ changed in what is pushed: nothing to check')
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
