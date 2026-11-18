// A backup that a tool leaves beside a file must never reach the repository. `sed -i -e` on macOS
// writes `<file>-e`; merges and patches leave `.orig` and `.rej`; editors leave `.bak` and `~`.
// docs/IMPLEMENTATION_PLAN.md-e reached main that way (#670) and #683 removed it.

export const STRAY_FILE_SUFFIXES = ['.md-e', '.orig', '.rej', '.bak'] as const
export const STRAY_FILE_TILDE = '~'

export interface StrayFile {
  file: string
  suffix: string
}

// The suffix that marks the file as a leftover, or null for a normal file
export function strayFileSuffix(file: string): string | null {
  const name = file.slice(file.lastIndexOf('/') + 1)
  if (name.endsWith(STRAY_FILE_TILDE)) return STRAY_FILE_TILDE
  return STRAY_FILE_SUFFIXES.find(suffix => name.endsWith(suffix)) ?? null
}

export function findStrayFiles(files: readonly string[]): StrayFile[] {
  return files.flatMap(file => {
    const suffix = strayFileSuffix(file)
    return suffix === null ? [] : [{ file, suffix }]
  })
}
