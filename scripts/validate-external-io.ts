// Fails when a route of a controller reaches I/O outside the database (a carrier, a channel, the bucket, the mail, a stream) and is not marked
// @NoTenantTransaction (RLS phase 6, F6-3d). The routes that are not marked today are frozen in scripts/external-io-baseline.json, which can
// only shrink: mark a route (and give it short contexts of its own), then run with --update-down.
// Usage: tsx scripts/validate-external-io.ts [--init | --update-down | --require-main]
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

import { EXTERNAL_IO_PROVIDERS } from './external-io-providers'
import {
  baselineGrowth,
  type ExternalIoBaseline,
  fixedEntries,
  newlyUnmarked,
  parseClasses,
  unknownProviders,
  unmarkedExternalRoutes
} from './lib/external-io-routes'

const BASELINE_FILE = 'scripts/external-io-baseline.json'

const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps/api/src', 'libs'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
const files = [...new Set(listed.split('\0'))].filter(
  file =>
    file.endsWith('.ts') &&
    !/\.(spec|test)\.ts$|\.d\.ts$/.test(file) &&
    !file.includes('/generated/') &&
    statSync(file, { throwIfNoEntry: false })?.isFile() === true
)
if (files.length === 0) {
  console.error('external-io: no file to scan; run it from the root of the repository')
  exit(1)
}
const classes = files.flatMap(file => parseClasses(file, readFileSync(file, 'utf8')))
const current = unmarkedExternalRoutes(classes, EXTERNAL_IO_PROVIDERS)
const keys = current.map(route => route.key)

const read = (): ExternalIoBaseline => JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as string[]
const write = (list: readonly string[]): void =>
  writeFileSync(BASELINE_FILE, `${JSON.stringify(list, null, 2)}\n`)

if (argv.includes('--init')) {
  if (read().length > 0) {
    console.error('the baseline is not empty: use --update-down')
    exit(1)
  }
  write(keys)
  console.log(`baseline written: ${keys.length} routes`)
  exit(0)
}
const baseline = read()
if (argv.includes('--update-down')) {
  write(baseline.filter(key => keys.includes(key)))
  console.log(`baseline lowered: ${keys.filter(key => baseline.includes(key)).length} routes left`)
  exit(0)
}

// The baseline cannot be raised to make a check pass: it is compared with the one of main. With --require-main (CI) a missing ref fails
// the check, because skipping the comparison would let a pull request raise its own limit
function baselineOfMain(): ExternalIoBaseline | undefined {
  const ref = ['origin/main', 'main'].find(
    candidate => spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate]).status === 0
  )
  const base =
    ref === undefined
      ? undefined
      : spawnSync('git', ['merge-base', ref, 'HEAD'], { encoding: 'utf8' })
  if (base === undefined || base.status !== 0) {
    if (argv.includes('--require-main')) {
      console.error('external-io: cannot find main to compare the baseline with (fetch-depth 0?)')
      exit(1)
    }
    return undefined
  }
  const shown = spawnSync('git', ['show', `${base.stdout.trim()}:${BASELINE_FILE}`], {
    encoding: 'utf8'
  })
  // The commit that creates the baseline has nothing to compare with
  return shown.status === 0 ? (JSON.parse(shown.stdout) as string[]) : undefined
}

const failures: string[] = []
const previous = baselineOfMain()
if (previous !== undefined) {
  for (const key of baselineGrowth(previous, baseline)) {
    failures.push(`${BASELINE_FILE}: ${key} is not on the baseline of main; it can only shrink`)
  }
}
for (const route of newlyUnmarked(baseline, current)) {
  failures.push(`${route.file}:${route.line}: ${route.key} ${route.why}`)
}
for (const name of unknownProviders(classes, EXTERNAL_IO_PROVIDERS)) {
  failures.push(`scripts/external-io-providers.ts: no class named ${name}`)
}
if (failures.length > 0) {
  console.error('Routes that reach I/O outside the database and are not @NoTenantTransaction:')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    "Mark the route with @NoTenantTransaction('reason') and open short contexts of its own (PrismaService.tenantTransaction)."
  )
  exit(1)
}
const slack = fixedEntries(baseline, current)
if (slack.length > 0) {
  console.error(`external-io: ${slack.length} routes on the baseline are fixed; run --update-down`)
  exit(1)
}
console.log(`external-io: ${baseline.length} routes still on the baseline, no new one`)
