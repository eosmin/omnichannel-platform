import { DsrType } from './status-enums'

// What the review queue of the data requests (Settings → Data requests, Step 7.2-H2b-3) reads from the api. They live in the domain lib,
// which the browser may import, and not in `libs/core/platform/compliance`, which only the server reads; a spec of that lib holds the two
// in step (`dsr-review-constants.spec.ts`).

// Whether the person was told how their request ended (derived by the api from the request, never stored as a word). `failed` means the
// person was NEVER told and the reviewer has to reach them another way (TDD_05 §10.3)
export const DsrNoticeStatuses = {
  NONE: 'none',
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed'
} as const
export type DsrNoticeStatus = (typeof DsrNoticeStatuses)[keyof typeof DsrNoticeStatuses]

// Why an approved request came back to review or why its file or its notice failed: the name of what went wrong, never a message
export const DsrReviewCodes = {
  SUBJECT_CHANGED: 'subject_changed',
  UNDOABLE_MERGE: 'undoable_merge',
  BLOCKED_BY_OPEN_WORK: 'blocked_by_open_work',
  ATTEMPTS_EXHAUSTED: 'attempts_exhausted',
  EXPORT_FAILED: 'export_failed',
  EXPORT_TOO_LARGE: 'export_too_large',
  MAIL_FAILED: 'mail_failed',
  MAIL_LOST: 'mail_lost',
  ADDRESS_UNREADABLE: 'address_unreadable'
} as const
export type DsrReviewCode = (typeof DsrReviewCodes)[keyof typeof DsrReviewCodes]

// What a reviewer decides on a request
export const DsrDecisions = {
  APPROVE: 'approve',
  REJECT: 'reject',
  CANCEL: 'cancel'
} as const
export type DsrDecision = (typeof DsrDecisions)[keyof typeof DsrDecisions]

// The legal bases a closing summary can name (TDD_05 §10.1)
export const DsrLegalBaseCodes = {
  CONSENT: 'consent',
  CONTRACT: 'contract',
  LEGAL_OBLIGATION: 'legal_obligation',
  LEGITIMATE_INTERESTS: 'legitimate_interests'
} as const

// The counts a closing summary can carry, in the order the screen lists them: what an erasure kept (orders, conversations) and what an
// export holds (all of them). A key the screen does not know is not drawn
export const DsrSummaryCounts = {
  CUSTOMERS: 'customers',
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  ORDERS: 'orders',
  ADDRESSES: 'addresses',
  CONSENTS: 'consents',
  FILES: 'files'
} as const
export const DSR_SUMMARY_COUNT_ORDER: readonly string[] = Object.values(DsrSummaryCounts)

// The kinds the platform carries out once approved; the others can only be rejected (the api answers DSR_EXECUTOR_UNAVAILABLE)
export const DsrApprovableTypes: readonly string[] = [
  DsrType.ERASURE,
  DsrType.ACCESS,
  DsrType.PORTABILITY
]
// The kinds that end in a file for the reviewer to download
export const DsrExportTypes: readonly string[] = [DsrType.ACCESS, DsrType.PORTABILITY]

// The numbers of the screen (the same as `ComplianceConfig`; a spec holds them in step)
export const DsrReviewLimits = {
  RESPONSE_DEADLINE_DAYS: 30,
  DEADLINE_ALERT_DAY: 25,
  ERASURE_GRACE_DAYS: 7,
  REASON_MAX_LENGTH: 500,
  PAGE_SIZE: 100,
  // The queue is read whole (the marks and the alerts count every request); a store that has more than this many gets "load more"
  MAX_AUTO_PAGES: 20
} as const
