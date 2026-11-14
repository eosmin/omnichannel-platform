import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  AnalyticsFileFormats,
  metricMessageKey,
  ReportFrequency,
  ReportMetrics
} from '@platform/core/analytics'

interface AnalyticsMessages {
  analytics: {
    metrics: Record<string, unknown>
    export: { formats: Record<string, unknown> }
    reports: { frequency: Record<string, unknown> }
  }
}

const messages = (locale: string): AnalyticsMessages['analytics'] =>
  (
    JSON.parse(
      readFileSync(resolve(__dirname, `../../messages/routes/analytics.${locale}.json`), 'utf8')
    ) as AnalyticsMessages
  ).analytics

const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

// A metric, a file type or a frequency without text would draw a raw key on the screen: the pickers read their keys from the
// catalogs, so a value added there fails here until it is worded
describe.each(['en', 'es'])('the words of the reports in %s', locale => {
  const words = messages(locale)

  it.each(ReportMetrics)('names the metric %s', metric => {
    expect(hasText(words.metrics[metricMessageKey(metric)])).toBe(true)
  })

  it('names nothing that is not a metric of the catalog', () => {
    expect(Object.keys(words.metrics).sort()).toEqual(ReportMetrics.map(metricMessageKey).sort())
  })

  it.each(AnalyticsFileFormats)('names the file type %s', format => {
    expect(hasText(words.export.formats[format])).toBe(true)
  })

  it.each(Object.values(ReportFrequency))('names the frequency %s', frequency => {
    expect(hasText(words.reports.frequency[frequency])).toBe(true)
  })
})
