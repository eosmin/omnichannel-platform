// Fails when the worker gains an access to the database with no tenant context (RLS phase 0b). The accesses that exist are frozen in
// scripts/rls-worker-baseline.json, which can only shrink: as a file adopts JobContext (or proves that it sees every row with
// assertSeesEveryRow), run with --update-down to lower its entry. Usage: tsx scripts/validate-rls-worker.ts [--update-down | --require-main]
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

import {
  type WorkerBaseline,
  baselineGrowth,
  checkAgainstBaseline,
  countContextFree,
  isScanned,
  lowerBaseline,
  slackOf
} from './lib/rls-worker-baseline'

const BASELINE_FILE = 'scripts/rls-worker-baseline.json'

const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps/worker/src'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
const files = [...new Set(listed.split('\0'))].filter(
  file => isScanned(file) && statSync(file, { throwIfNoEntry: false })?.isFile() === true
)
if (files.length === 0) {
  console.error('rls-worker: no file to scan; run it from the root of the repository')
  exit(1)
}

const current: Record<string, number> = {}
for (const file of files) {
  const count = countContextFree(readFileSync(file, 'utf8'))
  if (count > 0) current[file] = count
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as WorkerBaseline

// The first run, when the baseline is empty: it freezes what exists today
if (argv.includes('--init')) {
  if (Object.keys(baseline).length > 0) {
    console.error('the baseline is not empty: use --update-down')
    exit(1)
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`baseline written: ${Object.keys(current).length} files`)
  exit(0)
}

if (argv.includes('--update-down')) {
  try {
    const lowered = lowerBaseline(baseline, current)
    writeFileSync(BASELINE_FILE, `${JSON.stringify(lowered, null, 2)}\n`)
    console.log(`baseline lowered: ${Object.keys(lowered).length} files still run with no context`)
    exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('fix the code instead: do the work inside JobContext.forStore / forOrganization')
    exit(1)
  }
}

// The baseline cannot be raised to make a check pass: it is compared with the one of main. With --require-main (CI) a missing ref
// fails the check, because skipping the comparison would let a pull request raise its own limit
function baselineOfMain(): WorkerBaseline | undefined {
  const ref = ['origin/main', 'main'].find(
    candidate => spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate]).status === 0
  )
  const base =
    ref === undefined
      ? undefined
      : spawnSync('git', ['merge-base', ref, 'HEAD'], { encoding: 'utf8' })
  if (base === undefined || base.status !== 0) {
    if (argv.includes('--require-main')) {
      console.error('rls-worker: cannot find main to compare the baseline with (fetch-depth 0?)')
      exit(1)
    }
    return undefined
  }
  const shown = spawnSync('git', ['show', `${base.stdout.trim()}:${BASELINE_FILE}`], {
    encoding: 'utf8'
  })
  // The commit that creates the baseline has nothing to compare with
  return shown.status === 0 ? (JSON.parse(shown.stdout) as WorkerBaseline) : undefined
}

const failures: string[] = []
const previous = baselineOfMain()
if (previous !== undefined) {
  for (const file of baselineGrowth(previous, baseline)) {
    failures.push(
      `${BASELINE_FILE}: the entry of ${file} is higher than on main; it can only shrink`
    )
  }
}
for (const { file, allowed, found } of checkAgainstBaseline(baseline, current)) {
  failures.push(`${file}: ${found} accesses with no tenant context (${allowed} allowed)`)
}

if (failures.length > 0) {
  console.error('Worker accesses with no tenant context (RLS phase 0b):')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    'Do the work inside JobContext.forStore / forOrganization / forUser (libs/core/database).'
  )
  exit(1)
}
const slack = slackOf(baseline, current)
if (slack.length > 0) {
  console.warn(
    `rls-worker: the baseline can go down for ${slack.length} files (not a failure): pnpm validate:rls-worker --update-down`
  )
}
console.log(
  `rls-worker: ${files.length} files scanned, ${Object.keys(current).length} still run with no context`
)
