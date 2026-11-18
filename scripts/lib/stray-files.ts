// A backup that a tool leaves beside a file must never reach the repository. `sed -i -e` on macOS
// writes `<file>-e` beside whatever it edited; merges and patches leave `.orig` and `.rej`; editors
// leave `.bak` and `~`. docs/IMPLEMENTATION_PLAN.md-e reached main that way (#670) and #683 removed it.

export const STRAY_FILE_SUFFIXES = ['.orig', '.rej', '.bak'] as const
export const STRAY_FILE_TILDE = '~'
// What `sed -i -e` appends: `-e` after an extension (`a.ts-e`, `package.json-e`, `plan.md-e`)
export const SED_BACKUP_PATTERN = /\.[A-Za-z0-9]+-e$/

export interface StrayFile {
  file: string
  suffix: string
}

function strayNameSuffix(name: string): string | null {
  if (name.endsWith(STRAY_FILE_TILDE)) return STRAY_FILE_TILDE
  const sed = SED_BACKUP_PATTERN.exec(name)
  if (sed !== null) return '-e'
  return STRAY_FILE_SUFFIXES.find(suffix => name.endsWith(suffix)) ?? null
}

// The suffix that marks the path as a leftover, or null for a normal one. Every segment counts: a file
// inside a `x.bak/` directory is as stray as the directory.
export function strayFileSuffix(file: string): string | null {
  for (const segment of file.split('/')) {
    const suffix = strayNameSuffix(segment)
    if (suffix !== null) return suffix
  }
  return null
}

export function findStrayFiles(files: readonly string[]): StrayFile[] {
  return files.flatMap(file => {
    const suffix = strayFileSuffix(file)
    return suffix === null ? [] : [{ file, suffix }]
  })
}
