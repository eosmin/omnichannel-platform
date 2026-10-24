// A push that only touches docs/ is not checked: there is no code to lint, compile or test, and the
// formatter ignores docs/ (.prettierignore).
export function isDocsOnly(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(file => file.startsWith('docs/'))
}
