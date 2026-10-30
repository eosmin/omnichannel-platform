import lighthouse from 'lighthouse'
import desktopConfig from 'lighthouse/core/config/desktop-config.js'
import { z } from 'zod'

import { RUNS_PER_PAGE } from '../lighthouse/budgets'

const BYTES_PER_KB = 1_024

// Set when the run could not finish
const runFailureSchema = z.object({
  runtimeError: z.object({ code: z.string(), message: z.string() }).optional()
})

function pathAndSearch(address: string): string {
  const { pathname, search } = new URL(address)
  return `${pathname}${search}`
}

const numericAudit = z.object({ numericValue: z.number() })
const resultSchema = z.object({
  finalDisplayedUrl: z.string(),
  audits: z.object({
    'first-contentful-paint': numericAudit,
    'largest-contentful-paint': numericAudit,
    interactive: numericAudit,
    'total-blocking-time': numericAudit,
    'cumulative-layout-shift': numericAudit,
    'resource-summary': z.object({
      details: z.object({
        items: z.array(z.object({ resourceType: z.string(), transferSize: z.number() }))
      })
    })
  })
})

export interface PageMetrics {
  firstContentfulPaintMs: number
  largestContentfulPaintMs: number
  timeToInteractiveMs: number
  totalBlockingTimeMs: number
  cumulativeLayoutShift: number
  scriptTransferKb: number
}

// One navigation of the page the browser has open. Lighthouse clears the cache and the origin's
// storage but not the cookies, so the session it starts with is the one of the browser.
async function measureOnce(url: string, port: number): Promise<PageMetrics> {
  const result = await lighthouse(
    url,
    { port, hostname: '127.0.0.1', logLevel: 'error', output: 'json' },
    { ...desktopConfig, settings: { ...desktopConfig.settings, onlyCategories: ['performance'] } }
  )
  if (result === undefined) throw new Error(`Lighthouse returned no result for ${url}`)
  // The report crosses a boundary: the audits that the budgets read are checked before they are used
  // First the error of the run: a run that failed has no audits, and the code says why
  const failure = runFailureSchema.parse(result.lhr).runtimeError
  if (failure !== undefined) throw new Error(`${url}: ${failure.code} ${failure.message}`)
  const parsed = resultSchema.safeParse(result.lhr)
  if (!parsed.success)
    throw new Error(`Lighthouse report of ${url} lacks an audit: ${parsed.error.message}`)
  const { audits, finalDisplayedUrl } = parsed.data
  // A lost session lands on the login, which would measure the wrong page and pass
  if (pathAndSearch(finalDisplayedUrl) !== pathAndSearch(url))
    throw new Error(`${url} ended on ${finalDisplayedUrl}`)
  const script = audits['resource-summary'].details.items.find(
    item => item.resourceType === 'script'
  )
  // No row would read as 0 KB and pass every ceiling, as the warm cache did
  if (script === undefined) throw new Error(`${url}: the resource summary has no script row`)
  return {
    firstContentfulPaintMs: audits['first-contentful-paint'].numericValue,
    largestContentfulPaintMs: audits['largest-contentful-paint'].numericValue,
    timeToInteractiveMs: audits.interactive.numericValue,
    totalBlockingTimeMs: audits['total-blocking-time'].numericValue,
    cumulativeLayoutShift: audits['cumulative-layout-shift'].numericValue,
    scriptTransferKb: script.transferSize / BYTES_PER_KB
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

// The median of each metric over several runs, taken one after the other (they share the browser).
// `prepare` runs before each one: the refresh token rotates on every load and Lighthouse cuts the
// load short, so a session is good for one run, and each run starts with its own.
export async function measure(
  url: string,
  port: number,
  prepare: () => Promise<void>
): Promise<PageMetrics> {
  const runs: PageMetrics[] = []
  for (let run = 0; run < RUNS_PER_PAGE; run += 1) {
    await prepare()
    runs.push(await measureOnce(url, port))
  }
  const of = (pick: (metrics: PageMetrics) => number): number => median(runs.map(pick))
  return {
    firstContentfulPaintMs: of(m => m.firstContentfulPaintMs),
    largestContentfulPaintMs: of(m => m.largestContentfulPaintMs),
    timeToInteractiveMs: of(m => m.timeToInteractiveMs),
    totalBlockingTimeMs: of(m => m.totalBlockingTimeMs),
    cumulativeLayoutShift: of(m => m.cumulativeLayoutShift),
    scriptTransferKb: of(m => m.scriptTransferKb)
  }
}
