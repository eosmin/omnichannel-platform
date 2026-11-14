import { AnalyticsMetrics, MetricDimensionsOf } from './analytics-constants'
import { ReportLimits, ReportMetrics } from './report-constants'
import {
  analyticsExportFiltersSchema,
  createReportSchema,
  updateReportSchema
} from './report-schemas'

const valid = {
  name: 'Weekly summary',
  metrics: [AnalyticsMetrics.CONVERSATIONS_CREATED, AnalyticsMetrics.ORDERS_REVENUE],
  frequency: 'weekly',
  format: 'pdf',
  recipients: ['Owner@Example.com'],
  timezone: 'America/El_Salvador'
}

describe('report metrics', () => {
  it('leaves out the metrics that are read by a breakdown', () => {
    const names: string[] = [...ReportMetrics]
    for (const metric of Object.keys(MetricDimensionsOf)) expect(names).not.toContain(metric)
    expect(names).toContain(AnalyticsMetrics.CONVERSATIONS_CREATED)
  })
})

describe('createReportSchema', () => {
  it('fills the hour and the switch, and lowercases the addresses', () => {
    const parsed = createReportSchema.parse(valid)
    expect(parsed.sendAtHour).toBe(ReportLimits.DEFAULT_SEND_AT_HOUR)
    expect(parsed.enabled).toBe(true)
    expect(parsed.recipients).toEqual(['owner@example.com'])
  })

  it.each([
    ['an unknown field', { ...valid, storeId: 'x' }],
    ['a store id in the body', { ...valid, createdBy: 'x' }],
    ['no metrics', { ...valid, metrics: [] }],
    ['a metric read by a breakdown', { ...valid, metrics: [AnalyticsMetrics.CHANNEL_VOLUME] }],
    ['a repeated metric', { ...valid, metrics: ['orders.created', 'orders.created'] }],
    ['no recipients', { ...valid, recipients: [] }],
    ['an address that is not one', { ...valid, recipients: ['not-an-address'] }],
    ['a repeated address', { ...valid, recipients: ['a@b.co', 'A@B.co'] }],
    [
      'too many addresses',
      { ...valid, recipients: Array.from({ length: 11 }, (_, i) => `a${i}@b.co`) }
    ],
    ['a time zone that does not exist', { ...valid, timezone: 'Mars/Olympus' }],
    ['an hour of 24', { ...valid, sendAtHour: 24 }],
    ['a name with a line break', { ...valid, name: 'a\nb' }],
    ['a name with an invisible character', { ...valid, name: 'a​b' }],
    ['a name that is blank', { ...valid, name: '   ' }],
    ['a format that is not offered', { ...valid, format: 'zip' }],
    ['a frequency that is not offered', { ...valid, frequency: 'hourly' }]
  ])('refuses %s', (_label, body) => {
    expect(createReportSchema.safeParse(body).success).toBe(false)
  })
})

describe('updateReportSchema', () => {
  it('does not fill what the change does not name', () => {
    expect(updateReportSchema.parse({ name: 'New name' })).toEqual({ name: 'New name' })
  })

  it('refuses an empty change', () => {
    expect(updateReportSchema.safeParse({}).success).toBe(false)
  })

  it('refuses a field the creation refuses', () => {
    expect(updateReportSchema.safeParse({ recipients: ['nope'] }).success).toBe(false)
    expect(updateReportSchema.safeParse({ createdBy: 'someone' }).success).toBe(false)
  })
})

describe('analyticsExportFiltersSchema', () => {
  const filters = { metrics: ['orders.created'], from: '2026-11-01', to: '2026-11-08' }

  it('takes calendar days, the last one out', () => {
    expect(analyticsExportFiltersSchema.safeParse(filters).success).toBe(true)
  })

  it('refuses a period that is empty, backwards or too long', () => {
    expect(analyticsExportFiltersSchema.safeParse({ ...filters, to: '2026-11-01' }).success).toBe(
      false
    )
    expect(analyticsExportFiltersSchema.safeParse({ ...filters, to: '2026-10-01' }).success).toBe(
      false
    )
    expect(
      analyticsExportFiltersSchema.safeParse({ ...filters, from: '2020-01-01', to: '2026-01-01' })
        .success
    ).toBe(false)
  })

  it('refuses a date that is not a calendar day and a store of the body', () => {
    expect(analyticsExportFiltersSchema.safeParse({ ...filters, from: '2026-02-30' }).success).toBe(
      false
    )
    expect(analyticsExportFiltersSchema.safeParse({ ...filters, storeId: 'x' }).success).toBe(false)
  })
})
