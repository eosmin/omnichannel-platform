import { ApiError, type AuditLogFilter } from '@platform/api-client'
import { ClientErrorCodes } from '@platform/core/errors'

// What the fields of the audit log screen hold: text, as typed. The days are 'YYYY-MM-DD' (what a date input gives).
export interface AuditFilterForm {
  action: string
  userId: string
  from: string
  to: string
}

export const EMPTY_AUDIT_FILTER: AuditFilterForm = { action: '', userId: '', from: '', to: '' }

const DAY = /^\d{4}-\d{2}-\d{2}$/

// A day in the zone of the browser, as a Date at its first instant; undefined for an empty or malformed one
function startOfDay(day: string): Date | undefined {
  if (!DAY.test(day)) return undefined
  const date = new Date(`${day}T00:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

// True when both days are set and the first is after the last: the api would answer 400, so the screen says it first
export function isAuditRangeReversed(form: Pick<AuditFilterForm, 'from' | 'to'>): boolean {
  const start = startOfDay(form.from)
  const end = startOfDay(form.to)
  return start !== undefined && end !== undefined && start.getTime() > end.getTime()
}

// The filter the api takes. `from` is the first instant of the first day (inclusive) and `before` the first instant of the day
// AFTER the last one (exclusive), so the last day is whole. A field left empty narrows nothing; the action is kept as typed
// (the api matches it exactly), cut of the spaces around it.
export function auditFilterOf(form: AuditFilterForm): AuditLogFilter {
  const action = form.action.trim()
  const start = startOfDay(form.from)
  const end = startOfDay(form.to)
  if (end !== undefined) end.setDate(end.getDate() + 1)
  return {
    action: action === '' ? undefined : action,
    userId: form.userId === '' ? undefined : form.userId,
    from: start?.toISOString(),
    before: end?.toISOString()
  }
}

// The range the filters ask has more rows than the file may carry: the screen tells the person to narrow the dates
export function isExportTooLarge(error: unknown): boolean {
  return error instanceof ApiError && error.code === ClientErrorCodes.EXPORT_TOO_LARGE
}

// The metadata of an entry as text a person can read: formatted JSON, never markup. A value that cannot be written as JSON
// (the writer put none there, or a cycle that the api never sends) is shown as empty.
export function metadataText(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return ''
  try {
    return JSON.stringify(metadata, null, 2)
  } catch {
    return ''
  }
}

const SHORT_ID_LENGTH = 8

// An id the screen has no name for (a member who left, a plugin): its first characters, enough to tell two apart
export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH)
}
