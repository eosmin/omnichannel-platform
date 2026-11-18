// Fails when a backup left by a tool (`*.md-e` from `sed -i -e` on macOS, `.orig`, `.rej`, `.bak`, `~`)
// is in the repository, tracked or about to be. Usage: tsx scripts/validate-stray-files.ts
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { exit } from 'node:process'

import { findStrayFiles } from './lib/stray-files'

// What git sees, without what .gitignore hides; NUL-separated so that accents are not quoted.
// A file deleted from the working tree is skipped.
const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
const files = [...new Set(listed.split('\0'))].filter(
  file => file !== '' && statSync(file, { throwIfNoEntry: false })?.isFile() === true
)

const strays = findStrayFiles(files)
if (strays.length > 0) {
  console.error('Backup files left by a tool are in the repository (delete them):')
  for (const { file, suffix } of strays) console.error(`  ${file}  (${suffix})`)
  exit(1)
}
console.log(`no stray backup file in ${files.length} files`)
