import {
  DsrNoticeStatuses,
  DsrReviewCodes,
  DsrReviewLimits,
  DsrStatus,
  DsrType
} from '@platform/core/domain'

import type { DsrRequestView } from './dsr-requests'
import {
  attentionOf,
  canApprove,
  canCancel,
  canDownloadExport,
  canReject,
  DEADLINE_ALERT_DAYS_LEFT,
  daysLeft,
  daysOverdue,
  decisionNotices,
  EMPTY_QUEUE_FILTER,
  filterRequests,
  isDeadlineAlert,
  isEndedRequest,
  isNoticeFailed,
  isOverdue,
  isReturned,
  knownCodeOf,
  reasonProblem,
  summaryRows
} from './dsr-view'

const NOW = new Date('2026-11-23T12:00:00.000Z')
const day = (offset: number): string => new Date(NOW.getTime() + offset * 86_400_000).toISOString()

function make(patch: Partial<DsrRequestView> = {}): DsrRequestView {
  return {
    id: 'r1',
    type: DsrType.ERASURE,
    status: DsrStatus.MANUAL_REVIEW,
    requestedAt: day(-10),
    deadlineAt: day(20),
    verifiedAt: day(-9),
    reviewedAt: null,
    reviewedBy: null,
    requestedBy: null,
    erasureDueAt: null,
    erasureFailureCode: null,
    completedAt: null,
    rejectionReason: null,
    noticeStatus: DsrNoticeStatuses.NONE,
    exportReady: false,
    exportExpiresAt: null,
    exportFailureCode: null,
    retainedRecordsSummary: null,
    subjectCustomerIds: ['c1'],
    approvals: [],
    notes: null,
    ...patch
  }
}

describe('the deadline of a request', () => {
  it('counts whole days left, rounded up, and goes negative once it passed', () => {
    expect(daysLeft(day(5), NOW)).toBe(5)
    expect(daysLeft(day(0.2), NOW)).toBe(1)
    expect(daysLeft(day(0), NOW)).toBe(0)
    expect(daysLeft(day(-2), NOW)).toBe(-2)
  })

  it('alerts on day 25 of 30: five days left, never earlier', () => {
    expect(DEADLINE_ALERT_DAYS_LEFT).toBe(
      DsrReviewLimits.RESPONSE_DEADLINE_DAYS - DsrReviewLimits.DEADLINE_ALERT_DAY
    )
    expect(DEADLINE_ALERT_DAYS_LEFT).toBe(5)
    expect(isDeadlineAlert(make({ deadlineAt: day(5) }), NOW)).toBe(true)
    expect(isDeadlineAlert(make({ deadlineAt: day(5.5) }), NOW)).toBe(false)
    expect(isDeadlineAlert(make({ deadlineAt: day(-3) }), NOW)).toBe(true)
  })

  it('alerts on a request in review and on an approved one, and on no other', () => {
    for (const status of [DsrStatus.MANUAL_REVIEW, DsrStatus.IN_PROGRESS]) {
      expect(isDeadlineAlert(make({ status, deadlineAt: day(1) }), NOW)).toBe(true)
    }
    for (const status of [
      DsrStatus.COMPLETED,
      DsrStatus.REJECTED,
      DsrStatus.CANCELLED,
      DsrStatus.PENDING_VERIFICATION
    ]) {
      expect(isDeadlineAlert(make({ status, deadlineAt: day(1) }), NOW)).toBe(false)
    }
  })

  it('calls a request overdue from the instant, even when it missed its deadline by hours', () => {
    expect(isOverdue(make({ deadlineAt: day(-0.1) }), NOW)).toBe(true)
    expect(daysOverdue(day(-0.1), NOW)).toBe(1)
    expect(daysOverdue(day(-2.5), NOW)).toBe(3)
  })

  it('calls a request overdue only while it is open and past its deadline', () => {
    expect(isOverdue(make({ deadlineAt: day(-1) }), NOW)).toBe(true)
    expect(isOverdue(make({ deadlineAt: day(-1), status: DsrStatus.COMPLETED }), NOW)).toBe(false)
    expect(isOverdue(make({ deadlineAt: day(0) }), NOW)).toBe(false)
  })
})

describe('when a request has ended', () => {
  it('has ended when it is completed, rejected or cancelled, and not while the person verifies or it is open', () => {
    for (const status of [DsrStatus.COMPLETED, DsrStatus.REJECTED, DsrStatus.CANCELLED]) {
      expect(isEndedRequest(make({ status }))).toBe(true)
    }
    for (const status of [
      DsrStatus.PENDING_VERIFICATION,
      DsrStatus.MANUAL_REVIEW,
      DsrStatus.IN_PROGRESS
    ]) {
      expect(isEndedRequest(make({ status }))).toBe(false)
    }
  })
})

describe('the marks of a request', () => {
  it('marks only a notice that FAILED, not one that is pending, sent or has no address', () => {
    expect(isNoticeFailed(make({ noticeStatus: DsrNoticeStatuses.FAILED }))).toBe(true)
    for (const noticeStatus of [
      DsrNoticeStatuses.NONE,
      DsrNoticeStatuses.PENDING,
      DsrNoticeStatuses.SENT,
      'something_new'
    ]) {
      expect(isNoticeFailed(make({ noticeStatus }))).toBe(false)
    }
  })

  it('marks as returned a request in review that carries a code, and not an approved one', () => {
    expect(isReturned(make({ erasureFailureCode: DsrReviewCodes.SUBJECT_CHANGED }))).toBe(true)
    expect(isReturned(make({ erasureFailureCode: null }))).toBe(false)
    expect(
      isReturned(
        make({ erasureFailureCode: DsrReviewCodes.SUBJECT_CHANGED, status: DsrStatus.IN_PROGRESS })
      )
    ).toBe(false)
  })

  it('knows the codes of the api and nothing else', () => {
    for (const code of Object.values(DsrReviewCodes)) expect(knownCodeOf(code)).toBe(code)
    expect(knownCodeOf('a_future_code')).toBeNull()
    expect(knownCodeOf(null)).toBeNull()
  })
})

describe('what the reviewer may do', () => {
  it('approves from review, only the kinds the platform carries out', () => {
    for (const type of [DsrType.ERASURE, DsrType.ACCESS, DsrType.PORTABILITY]) {
      expect(canApprove(make({ type }))).toBe(true)
    }
    for (const type of [DsrType.RECTIFICATION, DsrType.RESTRICTION, DsrType.OBJECTION]) {
      expect(canApprove(make({ type }))).toBe(false)
      expect(canReject(make({ type }))).toBe(true)
    }
    expect(canApprove(make({ status: DsrStatus.IN_PROGRESS }))).toBe(false)
    expect(canApprove(make({ status: DsrStatus.COMPLETED }))).toBe(false)
  })

  it('rejects only from review', () => {
    expect(canReject(make())).toBe(true)
    for (const status of [DsrStatus.IN_PROGRESS, DsrStatus.COMPLETED, DsrStatus.REJECTED]) {
      expect(canReject(make({ status }))).toBe(false)
    }
  })

  it('cancels only an approved erasure whose grace period has not ended', () => {
    const approved = { status: DsrStatus.IN_PROGRESS, erasureDueAt: day(3) }
    expect(canCancel(make(approved), NOW)).toBe(true)
    expect(canCancel(make({ ...approved, erasureDueAt: day(-0.01) }), NOW)).toBe(false)
    expect(canCancel(make({ ...approved, erasureDueAt: null }), NOW)).toBe(false)
    expect(canCancel(make({ ...approved, type: DsrType.ACCESS }), NOW)).toBe(false)
    expect(canCancel(make({ ...approved, status: DsrStatus.MANUAL_REVIEW }), NOW)).toBe(false)
  })

  it('downloads only the ready, unexpired file of a finished access or portability request', () => {
    const done = {
      type: DsrType.ACCESS,
      status: DsrStatus.COMPLETED,
      exportReady: true,
      exportExpiresAt: day(2)
    }
    expect(canDownloadExport(make(done), NOW)).toBe(true)
    expect(canDownloadExport(make({ ...done, type: DsrType.PORTABILITY }), NOW)).toBe(true)
    expect(canDownloadExport(make({ ...done, exportReady: false }), NOW)).toBe(false)
    expect(canDownloadExport(make({ ...done, exportExpiresAt: day(-1) }), NOW)).toBe(false)
    expect(canDownloadExport(make({ ...done, exportExpiresAt: null }), NOW)).toBe(false)
    expect(canDownloadExport(make({ ...done, type: DsrType.ERASURE }), NOW)).toBe(false)
    expect(canDownloadExport(make({ ...done, status: DsrStatus.IN_PROGRESS }), NOW)).toBe(false)
  })
})

describe('the queue', () => {
  const rows = [
    make({ id: 'a', noticeStatus: DsrNoticeStatuses.FAILED, status: DsrStatus.COMPLETED }),
    make({ id: 'b', deadlineAt: day(2) }),
    make({ id: 'c', erasureFailureCode: DsrReviewCodes.UNDOABLE_MERGE }),
    make({ id: 'd', type: DsrType.ACCESS, status: DsrStatus.REJECTED })
  ]

  it('counts what needs attention over the whole list', () => {
    const attention = attentionOf(rows, NOW)
    expect(attention.noticeFailed.map(row => row.id)).toEqual(['a'])
    expect(attention.deadline.map(row => row.id)).toEqual(['b'])
    expect(attention.returned.map(row => row.id)).toEqual(['c'])
  })

  it('filters by status and by type, and with no filter shows every request', () => {
    expect(filterRequests(rows, EMPTY_QUEUE_FILTER)).toHaveLength(4)
    expect(filterRequests(rows, { status: DsrStatus.REJECTED, type: '' }).map(r => r.id)).toEqual([
      'd'
    ])
    expect(filterRequests(rows, { status: '', type: DsrType.ACCESS }).map(r => r.id)).toEqual(['d'])
    expect(filterRequests(rows, { status: DsrStatus.REJECTED, type: DsrType.ERASURE })).toEqual([])
  })

  it('lists the counts of a summary in its own order and skips the ones it does not draw', () => {
    expect(summaryRows(null)).toEqual([])
    expect(
      summaryRows({
        legalBasis: null,
        counts: { orders: 2, conversations: 1, something_else: 9 }
      })
    ).toEqual([
      { key: 'conversations', count: 1 },
      { key: 'orders', count: 2 }
    ])
  })
})

describe('the reason of a decision', () => {
  it('is required and is measured after trimming', () => {
    expect(reasonProblem('')).toBe('required')
    expect(reasonProblem('   \n ')).toBe('required')
    expect(reasonProblem('  checked  ')).toBeNull()
  })

  it('fits the limit of the api, and no more', () => {
    expect(reasonProblem('x'.repeat(DsrReviewLimits.REASON_MAX_LENGTH))).toBeNull()
    expect(reasonProblem('x'.repeat(DsrReviewLimits.REASON_MAX_LENGTH + 1))).toBe('tooLong')
  })
})

describe('decisionNotices', () => {
  const base = { allowed: true, blocked: false, refusalCode: null }

  it('says nothing while nothing is wrong', () => {
    expect(decisionNotices(base)).toEqual({ stale: false, blocked: false, refusal: false })
  })

  it.each(['DSR_NOT_REVIEWABLE', 'DSR_ALREADY_COMPLETED'])(
    'says the request changed once: the refusal %s is not drawn again',
    code => {
      expect(decisionNotices({ ...base, allowed: false, refusalCode: code })).toEqual({
        stale: true,
        blocked: false,
        refusal: false
      })
    }
  )

  it.each(['RATE_LIMIT_EXCEEDED', 'PERMISSION_DENIED', 'INTERNAL_ERROR', ''])(
    'still shows %s when the request also changed: only the refusals that repeat a line are dropped',
    code => {
      expect(decisionNotices({ ...base, allowed: false, refusalCode: code })).toEqual({
        stale: true,
        blocked: false,
        refusal: true
      })
    }
  )

  it('says the open work once: the line before is left out only for the refusal about open work', () => {
    expect(decisionNotices({ ...base, blocked: true }).blocked).toBe(true)
    expect(
      decisionNotices({ ...base, blocked: true, refusalCode: 'DSR_BLOCKED_BY_OPEN_WORK' })
    ).toEqual({ stale: false, blocked: false, refusal: true })
    expect(decisionNotices({ ...base, blocked: true, refusalCode: 'INTERNAL_ERROR' })).toEqual({
      stale: false,
      blocked: true,
      refusal: true
    })
  })
})
