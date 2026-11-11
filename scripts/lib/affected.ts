// A push that only touches docs/ is not checked: there is no code to lint, compile or test, and the
// formatter ignores docs/ (.prettierignore).
export function isDocsOnly(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(file => file.startsWith('docs/'))
}

export interface AffectedStep {
  name: string
  command: string[]
  // The step runs tests: CI owns it (required checks `unit-tests` and `integration-tests`), so the
  // pre-push hook skips it unless `--full` is passed
  tests?: boolean
}

// What the pre-push hook runs: everything cheap. The test steps run only with `--full`.
export function selectSteps(
  steps: readonly AffectedStep[],
  options: { full: boolean }
): AffectedStep[] {
  return steps.filter(step => options.full || step.tests !== true)
}
