import type { PageMetrics } from './lighthouse'

const DECIMALS = 2

// One line with what was measured against what it may be, so the room under a ceiling is seen on
// every run and not only when it breaks
export function metricsLine(label: string, metrics: PageMetrics, scriptCeilingKb: number): string {
  const script = metrics.scriptTransferKb
  return (
    `${label}: scripts ${script.toFixed(DECIMALS)} KB of ${scriptCeilingKb} KB ` +
    `(room ${(scriptCeilingKb - script).toFixed(DECIMALS)} KB), ` +
    `FCP ${Math.round(metrics.firstContentfulPaintMs)} ms, LCP ${Math.round(metrics.largestContentfulPaintMs)} ms, ` +
    `TTI ${Math.round(metrics.timeToInteractiveMs)} ms, TBT ${Math.round(metrics.totalBlockingTimeMs)} ms, ` +
    `CLS ${metrics.cumulativeLayoutShift.toFixed(3)}`
  )
}
