import { z } from 'zod'

import { ReportFrequency } from './analytics-constants'
import {
  AnalyticsFileFormats,
  ReportLimits,
  ReportMetrics,
  type ReportMetric
} from './report-constants'
import { isTimeZone } from './report-schedule'

const DAY_MS = 86_400_000

const calendarDay = z.iso.date()

const metricList = z
  .array(z.enum(ReportMetrics as [ReportMetric, ...ReportMetric[]]))
  .min(1)
  .max(ReportMetrics.length)
  .refine(metrics => new Set(metrics).size === metrics.length, {
    message: 'a metric is named once'
  })

// The text of a name that a file and an email show: no control characters (a line break ends a header)
const reportName = z
  .string()
  .trim()
  .min(1)
  .max(ReportLimits.NAME_MAX_LENGTH)
  .refine(name => !/[\p{Cc}\p{Cf}]/u.test(name), { message: 'a name has no control characters' })

// What an export of the analytics keeps in `Export.filters` and what `GET /analytics/export` asks for: the period is calendar
// days (UTC, as the rollup cuts them), the last one out
export const analyticsExportFiltersSchema = z
  .strictObject({
    metrics: metricList,
    from: calendarDay,
    to: calendarDay,
    reportName: reportName.optional()
  })
  .refine(range => range.to > range.from, { path: ['to'], message: 'to must be after from' })
  .refine(
    range => (Date.parse(range.to) - Date.parse(range.from)) / DAY_MS <= ReportLimits.MAX_DAYS,
    { path: ['to'], message: 'the range is too long' }
  )
export type AnalyticsExportFilters = z.output<typeof analyticsExportFiltersSchema>

const recipients = z
  .array(
    z
      .email()
      .max(ReportLimits.EMAIL_MAX_LENGTH)
      .transform(email => email.toLowerCase())
  )
  .min(1)
  .max(ReportLimits.MAX_RECIPIENTS)
  .refine(list => new Set(list).size === list.length, { message: 'an address is named once' })

const reportFields = {
  name: reportName,
  metrics: metricList,
  frequency: z.enum(ReportFrequency),
  format: z.enum(AnalyticsFileFormats),
  recipients,
  timezone: z.string().refine(isTimeZone, { message: 'not a time zone' }),
  sendAtHour: z.number().int().min(0).max(23),
  enabled: z.boolean()
}

export const createReportSchema = z.strictObject({
  ...reportFields,
  sendAtHour: reportFields.sendAtHour.default(ReportLimits.DEFAULT_SEND_AT_HOUR),
  enabled: reportFields.enabled.default(true)
})
export type CreateReportBody = z.output<typeof createReportSchema>

// A change names only what changes: no default is filled in, or an edit of the name would put the hour back to 8
export const updateReportSchema = z
  .strictObject(reportFields)
  .partial()
  .refine(body => Object.keys(body).length > 0, { message: 'nothing to change' })
export type UpdateReportBody = z.output<typeof updateReportSchema>
