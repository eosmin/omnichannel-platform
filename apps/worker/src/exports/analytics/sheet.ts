import {
  MetricUnits,
  type MetricUnit,
  RolledUpMetricUnits,
  type ReportMetric
} from '@platform/core/analytics'

import type { ReportTable } from './report-table'

// A report written as a sheet: the words are already in the language of whoever asked, so the writers hold no text of their own
export interface ReportSheet {
  title: string
  // The period, as a line a person reads
  subtitle: string
  // The first column is the day; the others are the metrics, in the order of the table
  headers: string[]
  // What each metric column is counted in (the first column, the day, has none)
  units: MetricUnit[]
  rows: { label: string; values: (number | null)[]; total: boolean }[]
}

export interface SheetTexts {
  title: string
  subtitle: string
  dayHeader: string
  totalLabel: string
  // The header of a metric, with its unit
  header: (metric: ReportMetric) => string
}

const CENTS_PER_UNIT = 100

// What a spreadsheet or a CSV holds for a figure: money in whole units of the currency (the rollup already keeps it that way, so it is
// not divided again), a time in seconds, a count as it is. Money is cut to the cent here and only here, from the four decimals the
// rollup stores (the rollup sums whole cents and divides once, so a figure is always a whole number of cents: no half cent exists to round). The document formats it for a person on its own (`formatCell`), from the same raw figure.
export function displayValue(value: number | null, unit: MetricUnit): number | null {
  if (value === null) return null
  return unit === MetricUnits.CURRENCY ? Math.round(value * CENTS_PER_UNIT) / CENTS_PER_UNIT : value
}

export function sheetOf(table: ReportTable, texts: SheetTexts): ReportSheet {
  return {
    title: texts.title,
    subtitle: texts.subtitle,
    headers: [texts.dayHeader, ...table.metrics.map(metric => texts.header(metric))],
    units: table.metrics.map(metric => RolledUpMetricUnits[metric]),
    rows: [
      ...table.rows.map(row => ({ label: row.day, values: row.values, total: false })),
      { label: texts.totalLabel, values: table.totals, total: true }
    ]
  }
}
