import {
  DAY_MS,
  DSR_SUMMARY_COUNT_ORDER,
  DsrApprovableTypes,
  DsrExportTypes,
  DsrNoticeStatuses,
  DsrReviewCodes,
  DsrReviewLimits,
  DsrStatus,
  DsrType
} from '@platform/core/domain'

import type { DsrRequestView, DsrSummary } from './dsr-requests'

// What the review queue decides from a request, as pure functions of the row and of the clock (so a spec can hold them).

const OPEN: readonly string[] = [String(DsrStatus.MANUAL_REVIEW), String(DsrStatus.IN_PROGRESS)]
const KNOWN_CODES: readonly string[] = Object.values(DsrReviewCodes)

const ENDED: readonly string[] = [
  String(DsrStatus.COMPLETED),
  String(DsrStatus.REJECTED),
  String(DsrStatus.CANCELLED)
]

// A request that ended: the person is told then, and not before (a request in review holds a sealed address that is not a notice yet)
export const isEndedRequest = (row: Pick<DsrRequestView, 'status'>): boolean =>
  ENDED.includes(row.status)

// A request the team still has to carry out: in review, or approved and waiting for its sweep
export const isOpenRequest = (row: Pick<DsrRequestView, 'status'>): boolean =>
  OPEN.includes(row.status)

// Whole days left of the legal deadline (rounded up, so "0" is today); negative once it passed
export function daysLeft(deadlineAt: string, now: Date): number {
  return Math.ceil((new Date(deadlineAt).getTime() - now.getTime()) / DAY_MS)
}

// The alert of day 25: an open request with this many days left or fewer. The extension does not exist, so there is nothing to wait for
export const DEADLINE_ALERT_DAYS_LEFT =
  DsrReviewLimits.RESPONSE_DEADLINE_DAYS - DsrReviewLimits.DEADLINE_ALERT_DAY

export const isDeadlineAlert = (row: DsrRequestView, now: Date): boolean =>
  isOpenRequest(row) && daysLeft(row.deadlineAt, now) <= DEADLINE_ALERT_DAYS_LEFT

// Overdue is decided from the instant, not from the day count: a deadline missed three hours ago is overdue, though it is "0 days left"
export const isOverdue = (row: DsrRequestView, now: Date): boolean =>
  isOpenRequest(row) && new Date(row.deadlineAt).getTime() < now.getTime()

// Whole days past the deadline, at least one once it is overdue
export const daysOverdue = (deadlineAt: string, now: Date): number =>
  Math.max(1, Math.ceil((now.getTime() - new Date(deadlineAt).getTime()) / DAY_MS))

// The sending of the closing notice could not be confirmed: the person may not have been told
export const isNoticeFailed = (row: Pick<DsrRequestView, 'noticeStatus'>): boolean =>
  row.noticeStatus === DsrNoticeStatuses.FAILED

// A request that came back to review with a reason (an approved erasure the sweep gave back)
export const isReturned = (row: DsrRequestView): boolean =>
  row.status === String(DsrStatus.MANUAL_REVIEW) && row.erasureFailureCode !== null

export const canApprove = (row: DsrRequestView): boolean =>
  row.status === String(DsrStatus.MANUAL_REVIEW) && DsrApprovableTypes.includes(row.type)

export const canReject = (row: DsrRequestView): boolean =>
  row.status === String(DsrStatus.MANUAL_REVIEW)

// Only an erasure can be pulled back, and only while its grace period runs
export const canCancel = (row: DsrRequestView, now: Date): boolean =>
  row.type === String(DsrType.ERASURE) &&
  row.status === String(DsrStatus.IN_PROGRESS) &&
  row.erasureDueAt !== null &&
  new Date(row.erasureDueAt) > now

export const canDownloadExport = (row: DsrRequestView, now: Date): boolean =>
  DsrExportTypes.includes(row.type) &&
  row.status === String(DsrStatus.COMPLETED) &&
  row.exportReady &&
  row.exportExpiresAt !== null &&
  new Date(row.exportExpiresAt) > now

// A code of the api this page has words for, or null (the page then says something generic)
export const knownCodeOf = (code: string | null): string | null =>
  code !== null && KNOWN_CODES.includes(code) ? code : null

// The counts of a summary this page draws, in its order
export function summaryRows(summary: DsrSummary | null): { key: string; count: number }[] {
  if (summary === null) return []
  return DSR_SUMMARY_COUNT_ORDER.flatMap(key => {
    const count = summary.counts[key]
    return count === undefined ? [] : [{ key, count }]
  })
}

export interface QueueFilter {
  status: string
  type: string
}
export const EMPTY_QUEUE_FILTER: QueueFilter = { status: '', type: '' }

export const filterRequests = (
  rows: readonly DsrRequestView[],
  filter: QueueFilter
): DsrRequestView[] =>
  rows.filter(
    row =>
      (filter.status === '' || row.status === filter.status) &&
      (filter.type === '' || row.type === filter.type)
  )

// What the banners of the queue count: over the WHOLE list, never over a filtered one
export interface QueueAttention {
  noticeFailed: DsrRequestView[]
  deadline: DsrRequestView[]
  returned: DsrRequestView[]
}
export function attentionOf(rows: readonly DsrRequestView[], now: Date): QueueAttention {
  return {
    noticeFailed: rows.filter(isNoticeFailed),
    deadline: rows.filter(row => isDeadlineAlert(row, now)),
    returned: rows.filter(isReturned)
  }
}

export type ReasonProblem = 'required' | 'tooLong'

// The reason a reviewer writes for a decision: text about a person, kept in the request and never copied to the audit log
export function reasonProblem(text: string): ReasonProblem | null {
  const reason = text.trim()
  if (reason === '') return 'required'
  return reason.length > DsrReviewLimits.REASON_MAX_LENGTH ? 'tooLong' : null
}
