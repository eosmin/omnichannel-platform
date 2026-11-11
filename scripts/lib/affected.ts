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

export interface AffectedArgs {
  full: boolean
  since: string | undefined
  unknown: string[]
}

// `pnpm validate:affected -- --since <sha>` (the pre-push hook) hands the script a lone `--`
// with pnpm 11: it is a separator, not a flag, so it is ignored.
export function parseArgs(args: readonly string[]): AffectedArgs {
  const result: AffectedArgs = { full: false, since: undefined, unknown: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') continue
    if (arg === '--full') result.full = true
    else if (arg === '--since') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) result.unknown.push(arg)
      else {
        result.since = value
        i++
      }
    } else result.unknown.push(arg)
  }
  return result
}
