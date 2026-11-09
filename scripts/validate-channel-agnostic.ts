// Fails when core, API, worker, SDK, runtime, web or the api-client gain knowledge of a channel or of
// Meta (CLAUDE.md rule 13). The knowledge that exists is frozen in scripts/channel-agnostic-baseline.json,
// which can only shrink: as a file is made agnostic, run with --update-down to lower its entry.
// Usage: tsx scripts/validate-channel-agnostic.ts [--update-down | --require-main]
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

import {
  type Baseline,
  type Counts,
  baselineGrowth,
  checkAgainstBaseline,
  countReferences,
  isScanned,
  lowerBaseline,
  slackOf
} from './lib/channel-agnostic'

const BASELINE_FILE = 'scripts/channel-agnostic-baseline.json'

const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
const files = [...new Set(listed.split('\0'))].filter(
  file => isScanned(file) && statSync(file, { throwIfNoEntry: false })?.isFile() === true
)

const current: Record<string, Counts> = {}
for (const file of files) {
  const counts = countReferences(readFileSync(file, 'utf8'))
  if (counts.code + counts.comment > 0) current[file] = counts
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline

if (argv.includes('--update-down')) {
  try {
    const lowered = lowerBaseline(baseline, current)
    writeFileSync(BASELINE_FILE, `${JSON.stringify(lowered, null, 2)}\n`)
    console.log(`baseline lowered: ${Object.keys(lowered).length} files still name a channel`)
    exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error('fix the code instead: a new reference to a channel belongs in libs/channels/*')
    exit(1)
  }
}

if (files.length === 0) {
  console.error('channel-agnostic: no file to scan; run it from the root of the repository')
  exit(1)
}

// The baseline file itself cannot be raised to make a check pass: it is compared with the one of
// main. With --require-main (CI) a missing ref fails the check, because skipping the comparison would let a pull request
// raise its own limit
function baselineOfMain(): Baseline | undefined {
  const ref = ['origin/main', 'main'].find(
    candidate => spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate]).status === 0
  )
  const base =
    ref === undefined
      ? undefined
      : spawnSync('git', ['merge-base', ref, 'HEAD'], { encoding: 'utf8' })
  if (base === undefined || base.status !== 0) {
    if (argv.includes('--require-main')) {
      console.error(
        'channel-agnostic: cannot find main to compare the baseline with (fetch-depth 0?)'
      )
      exit(1)
    }
    return undefined
  }
  const shown = spawnSync('git', ['show', `${base.stdout.trim()}:${BASELINE_FILE}`], {
    encoding: 'utf8'
  })
  // The commit that creates the baseline has nothing to compare with
  return shown.status === 0 ? (JSON.parse(shown.stdout) as Baseline) : undefined
}

const show = ({ code, comment }: Counts): string => `${code} code / ${comment} comment lines`

const failures: string[] = []
const previous = baselineOfMain()
if (previous !== undefined) {
  for (const file of baselineGrowth(previous, baseline)) {
    failures.push(
      `${BASELINE_FILE}: the entry of ${file} is higher than on main; it can only shrink`
    )
  }
}
for (const { file, kind, allowed, found } of checkAgainstBaseline(baseline, current)) {
  failures.push(
    `${file}: ${show(found)} name a channel or Meta (${kind === 'new' ? 'new in this file' : `${show(allowed)} allowed`}). Declare it in the plugin (libs/channels/*) and read it as data`
  )
}

if (failures.length > 0) {
  console.error('Channel knowledge outside libs/channels/* (CLAUDE.md rule 13):')
  for (const failure of failures) console.error(`  ${failure}`)
  exit(1)
}
const slack = slackOf(baseline, current)
if (slack.length > 0) {
  console.warn(
    `channel-agnostic: the baseline can go down for ${slack.length} files (not a failure): pnpm validate:channel-agnostic --update-down`
  )
}
console.log(
  `channel-agnostic: ${files.length} files scanned, ${Object.keys(current).length} still in the baseline`
)
