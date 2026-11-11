// What CI would fail on, for the projects that the branch touches (pre-push hook). No Docker, no
// database. A push that only changes docs/ is not checked, except for the validators that read the plan.
// Usage: tsx scripts/validate-affected.ts [--since <sha>] [--full]
//   --full: also run the unit tests (`nx affected --targets=test`), which the hook leaves to CI (required
//   check `unit-tests`, with the coverage thresholds).
//   --since: the commit the remote branch is at, which the pre-push hook passes. What is pushed is
//   then the commits after it, so a documentation commit on top of code that was already checked
//   is not checked again.
import { execFileSync, spawnSync } from 'node:child_process'
import { argv, exit } from 'node:process'

import { type AffectedStep, isDocsOnly, parseArgs, selectSteps } from './lib/affected'

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const hint =
      args[0] === 'merge-base' ? '\nis this a shallow clone? try `git fetch --unshallow`' : ''
    console.error(`git ${args.join(' ')} failed: ${detail}${hint}`)
    exit(1)
  }
}

function exists(ref: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref]).status === 0
}

function isAncestorOfHead(commit: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0
}

function changedSince(commit: string): string[] {
  return git('diff', '--name-only', '--no-renames', commit, 'HEAD').split('\n').filter(Boolean)
}

const args = parseArgs(argv.slice(2))
if (args.unknown.length > 0) {
  console.error(
    `unknown or incomplete argument(s): ${args.unknown.join(' ')} (known: --since <sha> --full)`
  )
  exit(1)
}

const baseRef = ['origin/main', 'main'].find(exists)
if (baseRef === undefined) {
  console.error('neither origin/main nor main exists here: run `git fetch origin main` first')
  exit(1)
}
const base = git('merge-base', baseRef, 'HEAD')
const changed = changedSince(base)

if (changed.length === 0) {
  console.log(`nothing changed since ${baseRef}: nothing to check`)
  exit(0)
}

// A remote commit that this clone does not have, or that is no longer behind HEAD (a branch that
// was rebased or rewritten), cannot tell what is pushed: then the whole branch is checked
const { since, full } = args
const pushed = since !== undefined && isAncestorOfHead(since) ? changedSince(since) : changed
if (pushed.length === 0) {
  console.log('nothing new is pushed: nothing to check')
  exit(0)
}
// The plan is read by two validators (the isolation exemptions and the frontend map), so a push that
// only edits it runs those two: a step renamed or deferred must not first break in CI
const PLAN_FILE = 'docs/IMPLEMENTATION_PLAN.md'
const PLAN_CHECKS = ['validate:isolation', 'validate:frontend']
const docsOnly = isDocsOnly(pushed)
if (docsOnly && !pushed.includes(PLAN_FILE)) {
  console.log('only docs/ changed in what is pushed: nothing to check')
  exit(0)
}

const STEPS: AffectedStep[] = [
  {
    name: 'lint and type-check (affected)',
    command: [
      'exec',
      'nx',
      'affected',
      '--targets=lint,type-check',
      `--base=${base}`,
      '--head=HEAD'
    ]
  },
  {
    name: 'test (affected)',
    tests: true,
    command: ['exec', 'nx', 'affected', '--targets=test', `--base=${base}`, '--head=HEAD']
  },
  { name: 'format:check', command: ['format:check'] },
  { name: 'validate:env', command: ['validate:env'] },
  { name: 'validate:deprecations', command: ['validate:deprecations'] },
  { name: 'validate:translations', command: ['validate:translations'] },
  { name: 'validate:rollbacks', command: ['validate:rollbacks'] },
  { name: 'validate:isolation', command: ['validate:isolation'] },
  { name: 'validate:frontend', command: ['validate:frontend'] },
  { name: 'validate:channel-agnostic', command: ['validate:channel-agnostic'] },
  { name: 'validate:image-hosts', command: ['validate:image-hosts'] },
  // Pure code, a second to run: a contract that breaks is seen before the push and not in CI
  { name: 'test:contracts', command: ['test:contracts'] }
]

const toRun = selectSteps(STEPS, { full })
for (const { name, command } of docsOnly
  ? toRun.filter(({ name }) => PLAN_CHECKS.includes(name))
  : toRun) {
  console.log(`\n> ${name}`)
  const result = spawnSync('pnpm', command, { stdio: 'inherit' })
  if (result.error !== undefined) console.error(`could not run pnpm: ${result.error.message}`)
  if (result.status !== 0) {
    console.error(`\n${name} failed: fix it before pushing (CI would fail on it too)`)
    exit(result.status ?? 1)
  }
}
console.log(
  full
    ? '\nall checks passed'
    : '\nall checks passed (the tests run in CI: `pnpm validate:affected --full` runs them here)'
)
