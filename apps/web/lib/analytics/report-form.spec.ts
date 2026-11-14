import type { ReportView } from '@platform/api-client'
import { AnalyticsMetrics, ReportFormats, ReportFrequency } from '@platform/core/analytics'

import {
  createInputOf,
  emptyReportDraft,
  recipientsOf,
  ReportFields,
  reportDraftOf,
  reportProblem,
  sortedMetrics,
  updateInputOf
} from './report-form'

const report: ReportView = {
  id: 'r1',
  name: 'Weekly',
  metrics: [AnalyticsMetrics.CONVERSATIONS_CREATED, AnalyticsMetrics.ORDERS_REVENUE],
  frequency: ReportFrequency.WEEKLY,
  format: ReportFormats.PDF,
  recipients: ['boss@example.com'],
  timezone: 'America/El_Salvador',
  sendAtHour: 6,
  enabled: true,
  lastSentAt: null,
  createdAt: '2026-11-01T00:00:00.000Z'
}

describe('recipientsOf', () => {
  it('splits on lines, commas, semicolons and spaces and drops empty pieces', () => {
    expect(recipientsOf('a@x.com, b@x.com;c@x.com\n\n d@x.com ')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com'
    ])
    expect(recipientsOf('  ')).toEqual([])
  })
})

describe('reportProblem', () => {
  const good = { ...emptyReportDraft('UTC'), name: 'Weekly', recipients: 'a@x.com' }

  it('accepts a complete draft', () => {
    expect(reportProblem(good)).toBeNull()
  })

  it('names the field the api would refuse', () => {
    expect(reportProblem({ ...good, name: '   ' })).toBe(ReportFields.NAME)
    expect(reportProblem({ ...good, metrics: [] })).toBe(ReportFields.METRICS)
    expect(reportProblem({ ...good, recipients: '' })).toBe(ReportFields.RECIPIENTS)
    expect(reportProblem({ ...good, recipients: 'not-an-address' })).toBe(ReportFields.RECIPIENTS)
    expect(reportProblem({ ...good, recipients: 'a@x.com, A@x.com' })).toBe(ReportFields.RECIPIENTS)
    expect(reportProblem({ ...good, timezone: 'Mars/Olympus' })).toBe(ReportFields.TIMEZONE)
  })

  it('refuses a name with a control character, which would end a mail header', () => {
    expect(reportProblem({ ...good, name: 'a\r\nBcc: x@y.com' })).toBe(ReportFields.NAME)
  })
})

describe('createInputOf', () => {
  it('lists the metrics in catalog order and the addresses in lower case', () => {
    const draft = {
      ...emptyReportDraft('UTC'),
      name: ' Weekly ',
      metrics: [AnalyticsMetrics.ORDERS_REVENUE, AnalyticsMetrics.CONVERSATIONS_CREATED],
      recipients: 'Boss@Example.com'
    }

    const body = createInputOf(draft)

    expect(body.name).toBe('Weekly')
    expect(body.metrics).toEqual([
      AnalyticsMetrics.CONVERSATIONS_CREATED,
      AnalyticsMetrics.ORDERS_REVENUE
    ])
    expect(body.recipients).toEqual(['boss@example.com'])
  })
})

describe('updateInputOf', () => {
  it('sends nothing when nothing changed', () => {
    expect(updateInputOf(report, reportDraftOf(report))).toEqual({})
  })

  it('sends only the keys that changed, so a rename does not put the hour back', () => {
    const draft = { ...reportDraftOf(report), name: 'Monday summary' }

    expect(updateInputOf(report, draft)).toEqual({ name: 'Monday summary' })
  })

  it('sends the pause and the new list of addresses', () => {
    const draft = {
      ...reportDraftOf(report),
      enabled: false,
      recipients: 'boss@example.com\nops@example.com'
    }

    expect(updateInputOf(report, draft)).toEqual({
      enabled: false,
      recipients: ['boss@example.com', 'ops@example.com']
    })
  })

  it('does not see the order the metrics were ticked in as a change', () => {
    const draft = { ...reportDraftOf(report), metrics: [...report.metrics].reverse() }

    expect(updateInputOf(report, draft)).toEqual({})
  })
})

describe('sortedMetrics', () => {
  it('drops a metric the catalog does not have', () => {
    expect(sortedMetrics(['nope', AnalyticsMetrics.ORDERS_REVENUE])).toEqual([
      AnalyticsMetrics.ORDERS_REVENUE
    ])
  })
})

describe('a value this form does not offer', () => {
  const good = { ...emptyReportDraft('UTC'), name: 'Weekly', recipients: 'a@x.com' }

  it('blames the frequency or the file type, not the name', () => {
    expect(reportProblem({ ...good, frequency: 'hourly' })).toBe(ReportFields.FREQUENCY)
    expect(reportProblem({ ...good, format: 'docx' })).toBe(ReportFields.FORMAT)
  })
})

describe('an hour outside the day', () => {
  it('is refused, and the first field is where the person starts again', () => {
    const draft = { ...emptyReportDraft('UTC'), name: 'Weekly', recipients: 'a@x.com' }

    expect(reportProblem({ ...draft, sendAtHour: 25 })).toBe(ReportFields.NAME)
  })
})
