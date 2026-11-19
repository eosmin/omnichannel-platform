// Fails when `PrismaService.replicaTenantRead()` is called where a read may not lag (TDD_08 §2.5, Step 5.3): outside the files of
// scripts/replica-readers.ts, in a guard, in a route that writes, or in a function that also writes or locks.
// Usage: tsx scripts/check-replica-routing.ts
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { exit } from 'node:process'

import { checkReplicaUse, type ReplicaViolation, staleReaders } from './lib/replica-routing'
import { REPLICA_READERS } from './replica-readers'

const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
const files = [...new Set(listed.split('\0'))].filter(
  file =>
    /^(apps|libs)\/.+\.ts$/.test(file) &&
    !/\.(spec|test)\.ts$/.test(file) &&
    !file.includes('/generated/') &&
    statSync(file, { throwIfNoEntry: false })?.isFile() === true
)
if (files.length === 0) {
  console.error('replica routing: no file to scan; run it from the root of the repository')
  exit(1)
}

const violations: ReplicaViolation[] = []
const callsByFile = new Map<string, number>()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  // The definition and its own comments mention the word; a file with neither name cannot call it
  if (!text.includes('replica(') && !text.includes('replicaTenantRead')) continue
  const result = checkReplicaUse(file, text, REPLICA_READERS)
  callsByFile.set(file, result.calls)
  violations.push(...result.violations)
}
const stale = staleReaders(REPLICA_READERS, callsByFile)

for (const v of violations) console.error(`${v.file}:${v.line}: ${v.message}`)
for (const file of stale)
  console.error(`${file}: listed in scripts/replica-readers.ts but never calls replicaTenantRead()`)
if (violations.length > 0 || stale.length > 0) exit(1)
console.log(`replica routing: ${REPLICA_READERS.length} readers, no call in a write path`)
