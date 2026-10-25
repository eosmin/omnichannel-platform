// Fails when the code uses an API that the compat notes of the TDDs removed or renamed.
// Usage: tsx scripts/validate-deprecations.ts
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { exit } from 'node:process'

import { findDeprecations, isScanned } from './lib/deprecations'

// What git sees, without what .gitignore hides. NUL-separated, so that a name with accents is not
// quoted. A file deleted from the working tree, a symlink to a directory or a submodule is skipped.
const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
// A file in conflict is listed once per stage
const files = [...new Set(listed.split('\0'))].filter(
  file => file !== '' && statSync(file, { throwIfNoEntry: false })?.isFile() === true
)

// Only the files that are scanned are read; the rule on middleware.ts needs the path alone
const findings = files.flatMap(file =>
  findDeprecations(file, isScanned(file) ? readFileSync(file, 'utf8') : '')
)

if (findings.length > 0) {
  console.error('Removed or renamed APIs are back in the code:')
  for (const { file, line, api, replacement } of findings) {
    console.error(`  ${file}:${line}  ${api}  ->  ${replacement}`)
  }
  exit(1)
}
console.log(`no deprecated API in ${files.filter(isScanned).length} files`)
