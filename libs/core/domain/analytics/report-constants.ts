import { ExportFileExtensions } from '../exports/export-constants'

import {
  AnalyticsMetrics,
  MetricDimensionsOf,
  MetricQueryLimits,
  ReportFormats,
  RolledUpMetrics,
  type RolledUpMetric
} from './analytics-constants'

// What a figure is counted in, so a file can say it and a reader can format it. Times are seconds (the rollup keeps seconds)
// and money is whole cents of the currency of the store.
export const MetricUnits = { COUNT: 'count', SECONDS: 'seconds', CENTS: 'cents' } as const
export type MetricUnit = (typeof MetricUnits)[keyof typeof MetricUnits]

export const RolledUpMetricUnits = {
  [AnalyticsMetrics.CONVERSATIONS_CREATED]: MetricUnits.COUNT,
  [AnalyticsMetrics.CONVERSATIONS_RESOLVED]: MetricUnits.COUNT,
  [AnalyticsMetrics.MESSAGES_RECEIVED]: MetricUnits.COUNT,
  [AnalyticsMetrics.MESSAGES_SENT]: MetricUnits.COUNT,
  [AnalyticsMetrics.FIRST_RESPONSE_TIME]: MetricUnits.SECONDS,
  [AnalyticsMetrics.FIRST_AUTOMATED_RESPONSE_TIME]: MetricUnits.SECONDS,
  [AnalyticsMetrics.RESOLUTION_TIME]: MetricUnits.SECONDS,
  [AnalyticsMetrics.CONVERSATIONS_PER_AGENT]: MetricUnits.COUNT,
  [AnalyticsMetrics.AGENT_FIRST_RESPONSE_TIME]: MetricUnits.SECONDS,
  [AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON]: MetricUnits.COUNT,
  [AnalyticsMetrics.CONVERSATIONS_ANSWERED_AUTOMATION]: MetricUnits.COUNT,
  [AnalyticsMetrics.CONVERSATIONS_RESOLVED_AUTOMATION]: MetricUnits.COUNT,
  [AnalyticsMetrics.ORDERS_CREATED]: MetricUnits.COUNT,
  [AnalyticsMetrics.ORDERS_REVENUE]: MetricUnits.CENTS,
  [AnalyticsMetrics.CHANNEL_VOLUME]: MetricUnits.COUNT
} as const satisfies Record<RolledUpMetric, MetricUnit>

const withBreakdown: readonly string[] = Object.keys(MetricDimensionsOf)

// The metrics a file can hold: the whole-store ones. A metric read by channel or by agent needs a column for every channel or
// person (and the name of the person), which a table of days does not give (left in the plan for the step that owns it).
export const ReportMetrics = (Object.keys(RolledUpMetrics) as RolledUpMetric[]).filter(
  metric => !withBreakdown.includes(metric)
)
export type ReportMetric = (typeof ReportMetrics)[number]

export const ReportLimits = {
  // Reports of one store: the dispatcher reads them all every hour
  MAX_PER_STORE: 20,
  NAME_MAX_LENGTH: 80,
  MAX_RECIPIENTS: 10,
  EMAIL_MAX_LENGTH: 254,
  // The days a file may span: a column for each metric and a row for each day
  MAX_DAYS: MetricQueryLimits.MAX_DAILY_RANGE_DAYS,
  DEFAULT_SEND_AT_HOUR: 8
} as const

// The kinds of file a report or an export of the analytics may be, in the order a form offers them
export const AnalyticsFileFormats = [
  ReportFormats.CSV,
  ReportFormats.EXCEL,
  ReportFormats.PDF
] as const
export type AnalyticsFileFormat = (typeof AnalyticsFileFormats)[number]

// The key of the text of a metric in the message files: a key with a dot would be read as a path
export const metricMessageKey = (metric: string): string => metric.replaceAll('.', '_')

// The extension of the file of each kind of report
export const ReportFormatExtensions = {
  [ReportFormats.CSV]: ExportFileExtensions.CSV,
  [ReportFormats.EXCEL]: ExportFileExtensions.EXCEL,
  [ReportFormats.PDF]: ExportFileExtensions.PDF
} as const satisfies Record<AnalyticsFileFormat, string>
