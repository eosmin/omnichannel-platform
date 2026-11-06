import { appendFileSync } from 'node:fs'

import { githubStepSummary } from './env'
import type { PageMetrics } from './lighthouse'
import { metricsLine } from './metrics-line'

// To the log of the job and, on GitHub, to the summary of the run. The summary is a convenience: a
// file that cannot be written is said and never fails the test, whose job is the budgets.
export function reportMetrics(label: string, metrics: PageMetrics, scriptCeilingKb: number): void {
  const line = metricsLine(label, metrics, scriptCeilingKb)
  process.stdout.write(`[lighthouse] ${line}\n`)
  if (githubStepSummary === undefined || githubStepSummary === '') return
  try {
    appendFileSync(githubStepSummary, `- Lighthouse, ${line}\n`)
  } catch (error) {
    process.stderr.write(`[lighthouse] the run summary could not be written: ${String(error)}\n`)
  }
}
