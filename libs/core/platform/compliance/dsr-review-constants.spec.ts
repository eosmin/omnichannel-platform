import {
  DsrLegalBaseCodes,
  DsrNoticeStatuses as WebNoticeStatuses,
  DsrReviewCodes,
  DsrReviewLimits
} from '@platform/core/domain'

import { ComplianceConfig, DsrErasureReturnReasons, LegalBases } from './compliance-constants'

// The review queue of the web reads its vocabulary from the domain lib (the browser may not import this one). The two must not drift.
describe('the vocabulary of the review queue of the web', () => {
  it('has the numbers of the platform', () => {
    expect(DsrReviewLimits.RESPONSE_DEADLINE_DAYS).toBe(ComplianceConfig.DSR_RESPONSE_DEADLINE_DAYS)
    expect(DsrReviewLimits.DEADLINE_ALERT_DAY).toBe(ComplianceConfig.DSR_DEADLINE_ALERT_DAY)
    expect(DsrReviewLimits.ERASURE_GRACE_DAYS).toBe(ComplianceConfig.ERASURE_GRACE_PERIOD_DAYS)
    expect(DsrReviewLimits.REASON_MAX_LENGTH).toBe(ComplianceConfig.DSR_REVIEW_REASON_MAX_LENGTH)
    expect(DsrReviewLimits.PAGE_SIZE).toBe(ComplianceConfig.DSR_REVIEW_MAX_PAGE_SIZE)
  })

  it('names every reason an approved erasure goes back to review', () => {
    const known: readonly string[] = Object.values(DsrReviewCodes)
    for (const reason of Object.values(DsrErasureReturnReasons)) expect(known).toContain(reason)
  })

  it('names every legal basis', () => {
    expect(Object.values(DsrLegalBaseCodes).sort()).toEqual(Object.values(LegalBases).sort())
  })

  it('knows the four states of a closing notice', () => {
    expect(Object.values(WebNoticeStatuses).sort()).toEqual(['failed', 'none', 'pending', 'sent'])
  })
})
