import { AnalyticsMetrics } from '@platform/core/analytics'
import type { BucketRow } from '@platform/core/messaging'

import { buildReportTable } from './report-table'

const row = (day: string, fields: Partial<BucketRow> = {}): BucketRow => ({
  dimensionId: '',
  bucket: new Date(`${day}T00:00:00.000Z`),
  total: 0,
  weighted: 0,
  count: 0,
  last: 0,
  lastCount: 0,
  ...fields
})

const filters = {
  from: '2026-11-01',
  to: '2026-11-04'
}

describe('buildReportTable', () => {
  it('has a row for every day of the period, written or not', () => {
    const table = buildReportTable(
      { ...filters, metrics: [AnalyticsMetrics.CONVERSATIONS_CREATED] },
      new Map([
        [AnalyticsMetrics.CONVERSATIONS_CREATED, [row('2026-11-02', { total: 5, count: 5 })]]
      ])
    )
    expect(table.rows.map(entry => entry.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
  })

  it('reads an idle day of a count as zero and the total as their sum', () => {
    const table = buildReportTable(
      { ...filters, metrics: [AnalyticsMetrics.CONVERSATIONS_CREATED] },
      new Map([
        [
          AnalyticsMetrics.CONVERSATIONS_CREATED,
          [row('2026-11-02', { total: 5, count: 5 }), row('2026-11-03', { total: 2, count: 2 })]
        ]
      ])
    )
    expect(table.rows.map(entry => entry.values[0])).toEqual([0, 5, 2])
    expect(table.totals).toEqual([7])
  })

  it('leaves a time with no conversations empty instead of zero, and weights the total', () => {
    const table = buildReportTable(
      { ...filters, metrics: [AnalyticsMetrics.FIRST_RESPONSE_TIME] },
      new Map([
        [
          AnalyticsMetrics.FIRST_RESPONSE_TIME,
          [
            // 60 s over one conversation and 120 s over three: the mean weighted by conversations is 105 s
            row('2026-11-01', { weighted: 60, count: 1 }),
            row('2026-11-03', { weighted: 360, count: 3 })
          ]
        ]
      ])
    )
    expect(table.rows.map(entry => entry.values[0])).toEqual([60, null, 120])
    expect(table.totals[0]).toBeCloseTo(105)
  })

  it('has no total for a time nobody measured', () => {
    const table = buildReportTable(
      { ...filters, metrics: [AnalyticsMetrics.RESOLUTION_TIME] },
      new Map()
    )
    expect(table.totals).toEqual([null])
    expect(table.rows.every(entry => entry.values[0] === null)).toBe(true)
  })

  it('takes the last day for a count of the moment', () => {
    const table = buildReportTable(
      { ...filters, metrics: [AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON] },
      new Map([
        [
          AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON,
          [
            row('2026-11-01', { last: 9, lastCount: 1 }),
            row('2026-11-03', { last: 4, lastCount: 1 })
          ]
        ]
      ])
    )
    expect(table.totals).toEqual([4])
  })

  it('keeps the columns in the order of the metrics asked', () => {
    const table = buildReportTable(
      {
        ...filters,
        metrics: [AnalyticsMetrics.ORDERS_REVENUE, AnalyticsMetrics.ORDERS_CREATED]
      },
      new Map([
        [AnalyticsMetrics.ORDERS_REVENUE, [row('2026-11-01', { total: 1000, count: 1 })]],
        [AnalyticsMetrics.ORDERS_CREATED, [row('2026-11-01', { total: 1, count: 1 })]]
      ])
    )
    expect(table.rows[0]?.values).toEqual([1000, 1])
  })
})
