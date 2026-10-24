// Fails when the code uses an API that the compat notes of the TDDs removed or renamed.
// Usage: tsx scripts/validate-deprecations.ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { findDeprecations } from './lib/deprecations'

// What git sees, without what .gitignore hides; a file deleted from the working tree is skipped
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8'
})
  .split('\n')
  .filter(file => file !== '' && existsSync(file))

const findings = files.flatMap(file => findDeprecations(file, readFileSync(file, 'utf8')))

if (findings.length > 0) {
  console.error('Removed or renamed APIs are back in the code:')
  for (const { file, line, api, replacement } of findings) {
    console.error(`  ${file}:${line}  ${api}  ->  ${replacement}`)
  }
  exit(1)
}
console.log(`no deprecated API in ${files.length} files`)
