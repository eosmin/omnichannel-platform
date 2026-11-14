import type { CreateReportInput, ReportView, UpdateReportInput } from '@platform/api-client'
import {
  createReportSchema,
  isTimeZone,
  ReportFormats,
  ReportFrequency,
  ReportLimits,
  ReportMetrics
} from '@platform/core/analytics'

// The form of a scheduled report (TDD_11 §7.4). The rules are the ones of the api (`createReportSchema`), read from the same
// schema, so the page never accepts what the server refuses or the other way round; this file only turns the form's text into
// the body and says which field is wrong.

export const ReportFields = {
  NAME: 'name',
  METRICS: 'metrics',
  FREQUENCY: 'frequency',
  FORMAT: 'format',
  RECIPIENTS: 'recipients',
  TIMEZONE: 'timezone'
} as const
export type ReportField = (typeof ReportFields)[keyof typeof ReportFields]

export interface ReportDraft {
  name: string
  metrics: string[]
  frequency: string
  format: string
  // The addresses as typed: one per line, or separated by commas or spaces
  recipients: string
  timezone: string
  sendAtHour: number
  enabled: boolean
}

// The zone of this browser when it is one the api knows, else UTC
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isTimeZone(zone) ? zone : ReportLimits.FALLBACK_TIME_ZONE
  } catch {
    return ReportLimits.FALLBACK_TIME_ZONE
  }
}

export function emptyReportDraft(timezone: string = browserTimeZone()): ReportDraft {
  return {
    name: '',
    metrics: [...ReportMetrics],
    frequency: ReportFrequency.WEEKLY,
    format: ReportFormats.CSV,
    recipients: '',
    timezone,
    sendAtHour: ReportLimits.DEFAULT_SEND_AT_HOUR,
    enabled: true
  }
}

export function reportDraftOf(report: ReportView): ReportDraft {
  return {
    name: report.name,
    metrics: [...report.metrics],
    frequency: report.frequency,
    format: report.format,
    recipients: report.recipients.join('\n'),
    timezone: report.timezone,
    sendAtHour: report.sendAtHour,
    enabled: report.enabled
  }
}

// Addresses separated by a line break, a comma, a semicolon or a space; an empty piece is no address
export function recipientsOf(text: string): string[] {
  return text.split(/[\s,;]+/).filter(piece => piece !== '')
}

// The metrics in the order of the catalog, whatever order they were ticked in
export function sortedMetrics(metrics: readonly string[]): string[] {
  return ReportMetrics.filter(metric => metrics.includes(metric))
}

function bodyOf(draft: ReportDraft): Record<string, unknown> {
  return {
    name: draft.name,
    metrics: sortedMetrics(draft.metrics),
    frequency: draft.frequency,
    format: draft.format,
    recipients: recipientsOf(draft.recipients),
    timezone: draft.timezone,
    sendAtHour: draft.sendAtHour,
    enabled: draft.enabled
  }
}

// The first field the api would refuse, or null when the draft is good
export function reportProblem(draft: ReportDraft): ReportField | null {
  const parsed = createReportSchema.safeParse(bodyOf(draft))
  if (parsed.success) return null
  const known: readonly string[] = Object.values(ReportFields)
  for (const issue of parsed.error.issues) {
    const head = issue.path[0]
    if (typeof head === 'string' && known.includes(head)) return head as ReportField
  }
  // An hour this form does not offer cannot be typed: the first field is where the person starts again
  return ReportFields.NAME
}

export function createInputOf(draft: ReportDraft): CreateReportInput {
  return createReportSchema.parse(bodyOf(draft))
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, at) => item === b[at])

// Only what the person changed: an edit of the name must not put the hour back (the api fills no default on a change)
export function updateInputOf(report: ReportView, draft: ReportDraft): UpdateReportInput {
  const body = createInputOf(draft)
  const changes: UpdateReportInput = {}
  if (body.name !== report.name) changes.name = body.name
  if (!sameList(body.metrics, sortedMetrics(report.metrics))) changes.metrics = body.metrics
  if (body.frequency !== report.frequency) changes.frequency = body.frequency
  if (body.format !== report.format) changes.format = body.format
  if (!sameList(body.recipients, report.recipients)) changes.recipients = body.recipients
  if (body.timezone !== report.timezone) changes.timezone = body.timezone
  if (body.sendAtHour !== report.sendAtHour) changes.sendAtHour = body.sendAtHour
  if (body.enabled !== report.enabled) changes.enabled = body.enabled
  return changes
}

// The label of an hour of the day, the same in the form and in the list
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}
