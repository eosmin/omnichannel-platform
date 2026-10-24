export const AnalyticsMetrics = {
  // Volume
  CONVERSATIONS_CREATED: 'conversations.created',
  CONVERSATIONS_RESOLVED: 'conversations.resolved',
  MESSAGES_RECEIVED: 'messages.received',
  MESSAGES_SENT: 'messages.sent',

  // Performance. First response is the first agent reply.
  FIRST_RESPONSE_TIME: 'response.first_time',
  AVERAGE_RESPONSE_TIME: 'response.average_time',
  RESOLUTION_TIME: 'resolution.time',
  CONVERSATIONS_PER_AGENT: 'agent.conversations',

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
