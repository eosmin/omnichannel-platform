import { appendFileSync } from 'node:fs'

import { githubStepSummary } from './env'
import type { PageMetrics } from './lighthouse'
import { metricsLine } from './metrics-line'

const SCRIPTS_LISTED = 25

// To the log of the job and, on GitHub, to the summary of the run. The summary is a convenience: a
// file that cannot be written is said and never fails the test, whose job is the budgets.
export function reportMetrics(label: string, metrics: PageMetrics, scriptCeilingKb: number): void {
  const line = metricsLine(label, metrics, scriptCeilingKb)
  process.stdout.write(`[lighthouse] ${line}\n`)
  // The heaviest scripts of the load, one per line, to see what the ceiling is made of; and how much of
  // the figure the listing explains (the rest are requests it does not list)
  const listing = metrics.scripts
    .slice(0, SCRIPTS_LISTED)
    .map(script => `[lighthouse] ${label} script ${script.transferKb.toFixed(2)} KB ${script.name}`)
  const explained = metrics.scripts.reduce((sum, script) => sum + script.transferKb, 0)
  try {
    process.stdout.write(
      [
        ...listing,
        `[lighthouse] ${label} scripts listed: ${metrics.scripts.length}, ${explained.toFixed(2)} KB of ${metrics.scriptTransferKb.toFixed(2)} KB`
      ].join('\n') + '\n'
    )
  } catch {
    // A closed stdout must not decide a budget
  }
  if (githubStepSummary === undefined || githubStepSummary === '') return
  try {
    appendFileSync(githubStepSummary, `- Lighthouse, ${line}\n`)
  } catch (error) {
    process.stderr.write(`[lighthouse] the run summary could not be written: ${String(error)}\n`)
  }
}
