// Fails when a backup left by a tool (`*.md-e` from `sed -i -e` on macOS, `.orig`, `.rej`, `.bak`, `~`)
// is in the repository, tracked or about to be. Usage: tsx scripts/validate-stray-files.ts
import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { exit } from 'node:process'

import { findStrayFiles } from './lib/stray-files'

// What the commit will hold (the index, even when the file was deleted in the working tree and the deletion is not staged) and what
// git does not track yet and does not ignore. NUL-separated, so that accents are not quoted.
const git = (args: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
    .split('\0')
    .filter(file => file !== '')
const untracked = git(['--others', '--exclude-standard']).filter(
  file => lstatSync(file, { throwIfNoEntry: false }) !== undefined
)
const files = [...new Set([...git(['--cached']), ...untracked])]

const strays = findStrayFiles(files)
if (strays.length > 0) {
  console.error('Backup files left by a tool are in the repository (delete them):')
  for (const { file, suffix } of strays) console.error(`  ${file}  (${suffix})`)
  exit(1)
}
console.log(`no stray backup file in ${files.length} files`)
