// What the review queue of the data requests answers (`GET /compliance/dsr`, `GET /compliance/dsr/:id`, Step 7.2-H2b-2). The web draws against
// THIS (Step 7.2-H2b-3), so a field is never renamed or removed without telling its owner: `DSR_REQUEST_VIEW_KEYS` is pinned by a spec of the
// api that compares it with the answer of the service, and a new field is added to both on purpose.
export type DsrRequestNoticeState = 'none' | 'pending' | 'sent' | 'failed'

export interface DsrRequestViewContract {
  id: string
  type: string
  status: string
  requestedAt: string
  deadlineAt: string
  verifiedAt: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  requestedBy: string | null
  erasureDueAt: string | null
  // A name or a reason code, never a message
  erasureFailureCode: string | null
  completedAt: string | null
  rejectionReason: string | null
  // `failed`: the person was NEVER told how their request ended
  noticeStatus: DsrRequestNoticeState
  exportReady: boolean
  exportExpiresAt: string | null
  exportFailureCode: string | null
  retainedRecordsSummary: { legalBasis: string; orders: number; conversations: number } | null
  subjectCustomerIds: string[]
  approvals: { userId: string; at: string }[]
  notes: string | null
}

export const DSR_REQUEST_VIEW_KEYS = [
  'id',
  'type',
  'status',
  'requestedAt',
  'deadlineAt',
  'verifiedAt',
  'reviewedAt',
  'reviewedBy',
  'requestedBy',
  'erasureDueAt',
  'erasureFailureCode',
  'completedAt',
  'rejectionReason',
  'noticeStatus',
  'exportReady',
  'exportExpiresAt',
  'exportFailureCode',
  'retainedRecordsSummary',
  'subjectCustomerIds',
  'approvals',
  'notes'
] as const satisfies readonly (keyof DsrRequestViewContract)[]
