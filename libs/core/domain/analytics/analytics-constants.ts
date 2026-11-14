export const AnalyticsMetrics = {
  // Volume
  CONVERSATIONS_CREATED: 'conversations.created',
  CONVERSATIONS_RESOLVED: 'conversations.resolved',
  MESSAGES_RECEIVED: 'messages.received',
  MESSAGES_SENT: 'messages.sent',

  // Performance. First response is the first reply of a person; the first reply of an automation is reported apart
  // (owner, 2026-10-29), so an automatic answer never makes the team look instant.
  FIRST_RESPONSE_TIME: 'response.first_time',
  FIRST_AUTOMATED_RESPONSE_TIME: 'response.first_automated_time',
  AVERAGE_RESPONSE_TIME: 'response.average_time',
  RESOLUTION_TIME: 'resolution.time',
  CONVERSATIONS_PER_AGENT: 'agent.conversations',

  // The three states of a conversation for the reports (owner, 2026-10-29). A conversation is judged by who answered it:
  // an automation that answers does not take it out of the pending queue or stop a response SLA, only an explicit resolve does.
  // Waiting for a person: no reply of a person and not resolved, at the end of the period (a count of the moment, not a flow).
  CONVERSATIONS_WAITING_PERSON: 'conversations.waiting_person',
  // Answered by automation: its first answer came in the period and no person had answered by then. It can hold together with waiting.
  CONVERSATIONS_ANSWERED_AUTOMATION: 'conversations.answered_automation',
  // Resolved by automation: resolved in the period with no reply of a person, after an answer of an automation.
  CONVERSATIONS_RESOLVED_AUTOMATION: 'conversations.resolved_automation',

  // Commerce
  ORDERS_CREATED: 'orders.created',
  ORDERS_REVENUE: 'orders.revenue',
  ORDERS_AVERAGE_VALUE: 'orders.average_value',
  CONVERSION_RATE: 'orders.conversion_rate',

  // Quality
  CSAT_SCORE: 'quality.csat',
  REOPEN_RATE: 'quality.reopen_rate',

  // Channels
  CHANNEL_VOLUME: 'channel.volume',
  CHANNEL_RESPONSE_TIME: 'channel.response_time'
} as const
export type AnalyticsMetric = (typeof AnalyticsMetrics)[keyof typeof AnalyticsMetrics]

// Raw events written to analytics_events by TRACK_EVENT jobs
export const AnalyticsEventNames = {
  SEARCH_PERFORMED: 'search.performed',
  EMAIL_ENGAGEMENT: 'email.engagement',
  ORDER_CREATED: 'order.created'
} as const
export type AnalyticsEventName = (typeof AnalyticsEventNames)[keyof typeof AnalyticsEventNames]

export const MetricDimensions = { NONE: '', CHANNEL: 'channel', AGENT: 'agent' } as const

export const TimeGranularity = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month' } as const
export type TimeGranularityType = (typeof TimeGranularity)[keyof typeof TimeGranularity]

export const DateRangePresets = {
  TODAY: 'today',
  YESTERDAY: 'yesterday',
  LAST_7_DAYS: 'last_7_days',
  LAST_30_DAYS: 'last_30_days',
  LAST_90_DAYS: 'last_90_days',
  THIS_MONTH: 'this_month',
  LAST_MONTH: 'last_month',
  CUSTOM: 'custom'
} as const

// Scheduled reports (TDD_11 §7.4)
export const ReportFrequency = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' } as const
export const ReportFormats = { PDF: 'pdf', CSV: 'csv', EXCEL: 'excel' } as const

// How the points of a metric are put together when a query asks for a coarser period than the rollup keeps
// (a week of daily rows). A count is added; a time, which the rollup keeps as its median and the number of
// conversations behind it, is averaged weighted by that number (adding medians would be meaningless); a count of the
// moment (waiting for a person) is the one of the last period.
export const MetricAggregations = {
  SUM: 'sum',
  WEIGHTED_MEAN: 'weighted_mean',
  LAST: 'last'
} as const
export type MetricAggregation = (typeof MetricAggregations)[keyof typeof MetricAggregations]

// The metrics the rollup writes (TDD_11 §7.2), each with its aggregation. The ones of the catalog that are not
// here (CSAT, reopen rate, conversion, channel response time) are written by the step that builds what they read.
export const RolledUpMetrics = {
  [AnalyticsMetrics.CONVERSATIONS_CREATED]: MetricAggregations.SUM,
  [AnalyticsMetrics.CONVERSATIONS_RESOLVED]: MetricAggregations.SUM,
  [AnalyticsMetrics.MESSAGES_RECEIVED]: MetricAggregations.SUM,
  [AnalyticsMetrics.MESSAGES_SENT]: MetricAggregations.SUM,
  [AnalyticsMetrics.FIRST_RESPONSE_TIME]: MetricAggregations.WEIGHTED_MEAN,
  [AnalyticsMetrics.FIRST_AUTOMATED_RESPONSE_TIME]: MetricAggregations.WEIGHTED_MEAN,
  [AnalyticsMetrics.RESOLUTION_TIME]: MetricAggregations.WEIGHTED_MEAN,
  [AnalyticsMetrics.CONVERSATIONS_PER_AGENT]: MetricAggregations.SUM,
  [AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON]: MetricAggregations.LAST,
  [AnalyticsMetrics.CONVERSATIONS_ANSWERED_AUTOMATION]: MetricAggregations.SUM,
  [AnalyticsMetrics.CONVERSATIONS_RESOLVED_AUTOMATION]: MetricAggregations.SUM,
  [AnalyticsMetrics.ORDERS_CREATED]: MetricAggregations.SUM,
  [AnalyticsMetrics.ORDERS_REVENUE]: MetricAggregations.SUM,
  [AnalyticsMetrics.CHANNEL_VOLUME]: MetricAggregations.SUM
} as const satisfies Partial<Record<AnalyticsMetric, MetricAggregation>>
export type RolledUpMetric = keyof typeof RolledUpMetrics

// Which dimension a metric is written with besides the whole-store row (MetricDimensions.NONE)
export const MetricDimensionsOf = {
  [AnalyticsMetrics.CONVERSATIONS_PER_AGENT]: MetricDimensions.AGENT,
  [AnalyticsMetrics.CHANNEL_VOLUME]: MetricDimensions.CHANNEL
} as const satisfies Partial<Record<AnalyticsMetric, string>>

// Rollup windows (TDD_08 §6): each run recomputes the two latest closed periods, so a late webhook is absorbed
export const RollupLimits = {
  RECOMPUTE_PERIODS: 2,
  STORES_PAGE_SIZE: 200,
  // Conversations created longer ago than this are not counted as waiting for a person
  WAITING_LOOKBACK_DAYS: 90,
  // The thirteen queries of a period run in one transaction, apart from the 5 s that Prisma allows by default
  TRANSACTION_MAX_WAIT_MS: 10_000,
  TRANSACTION_TIMEOUT_MS: 60_000
} as const

// What a read may ask for: a row of the hourly table is one hour, so a long range of hours is refused
export const MetricQueryLimits = {
  MAX_HOURLY_RANGE_DAYS: 14,
  MAX_DAILY_RANGE_DAYS: 800,
  // The dates a range may name: the rollups keep nothing older, and a date outside four digits is not a date of SQL
  MIN_DATE: '2000-01-01T00:00:00.000Z',
  MAX_DATE: '2100-01-01T00:00:00.000Z'
} as const
