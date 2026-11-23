import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import { DsrReviewLimits } from '@platform/core/domain'

// Settings → Data requests: what the api answers about the data requests of a store (the review queue of Step 7.2-H1b and the closing
// notice, the export and the retained summary of Step 7.2-H2b-2). Kept with the page and not in `@platform/api-client`, whose barrel the
// inbox loads whole. A type, a status or a code this page does not know (a newer server) stays as the text it came as and is drawn
// generically. No address and no name ever comes: the customers are named by id.

const approvalSchema = z.object({ userId: z.string(), at: z.string() })

// What was kept (an erasure) or what the file holds (an export): the basis and counts. Whatever does not fit is no summary at all
const summarySchema = z
  .object({ legalBasis: z.string().optional() })
  .catchall(z.unknown())
  .transform(raw => {
    const counts: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (
        key !== 'legalBasis' &&
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0
      ) {
        counts[key] = value
      }
    }
    return { legalBasis: raw.legalBasis ?? null, counts }
  })
export type DsrSummary = z.output<typeof summarySchema>

const requestSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  requestedAt: z.string(),
  deadlineAt: z.string(),
  verifiedAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  requestedBy: z.string().nullable(),
  erasureDueAt: z.string().nullable(),
  erasureFailureCode: z.string().nullable(),
  completedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  noticeStatus: z.string(),
  exportReady: z.boolean(),
  exportExpiresAt: z.string().nullable(),
  exportFailureCode: z.string().nullable(),
  retainedRecordsSummary: summarySchema.nullable().catch(null),
  subjectCustomerIds: z.array(z.string()),
  approvals: z.array(approvalSchema),
  notes: z.string().nullable()
})
export type DsrRequestView = z.output<typeof requestSchema>

// What an erasure would wait for, counted now
const openWorkSchema = z.object({
  orders: z.number().int(),
  shipments: z.number().int(),
  returns: z.number().int(),
  remittances: z.number().int(),
  receivables: z.number().int()
})
export type DsrOpenWorkView = z.output<typeof openWorkSchema>

const detailSchema = requestSchema.extend({ openWork: openWorkSchema.nullable() })
export type DsrRequestDetailView = z.output<typeof detailSchema>

const pageSchema = z.object({
  data: z.array(requestSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type DsrRequestPageView = z.output<typeof pageSchema>

const exportLinkSchema = z.object({
  url: z.url(),
  filename: z.string(),
  expiresInSeconds: z.number(),
  fileExpiresAt: z.string()
})
export type DsrExportLinkView = z.output<typeof exportLinkSchema>

export function fetchDsrRequests(
  client: ApiClient,
  storeId: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<DsrRequestPageView> {
  const params = new URLSearchParams({ limit: String(DsrReviewLimits.PAGE_SIZE) })
  if (cursor !== null) params.set('cursor', cursor)
  return client.request(`${ApiRoutes.compliance.dsr}?${params.toString()}`, {
    schema: pageSchema,
    storeId,
    signal
  })
}

export function fetchDsrRequest(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<DsrRequestDetailView> {
  return client.request(ApiRoutes.compliance.dsrById(id), {
    schema: detailSchema,
    storeId,
    signal
  })
}

// Approving is a written decision: the box is ticked and the reason is given
export function approveDsrRequest(
  client: ApiClient,
  storeId: string,
  id: string,
  reason: string
): Promise<DsrRequestView> {
  return client.request(ApiRoutes.compliance.dsrApprove(id), {
    method: 'POST',
    body: { confirm: true, reason },
    schema: requestSchema,
    storeId
  })
}

export function rejectDsrRequest(
  client: ApiClient,
  storeId: string,
  id: string,
  reason: string
): Promise<DsrRequestView> {
  return client.request(ApiRoutes.compliance.dsrReject(id), {
    method: 'POST',
    body: { reason },
    schema: requestSchema,
    storeId
  })
}

export function cancelDsrErasure(
  client: ApiClient,
  storeId: string,
  id: string,
  reason: string
): Promise<DsrRequestView> {
  return client.request(ApiRoutes.compliance.dsrCancel(id), {
    method: 'POST',
    body: { reason },
    schema: requestSchema,
    storeId
  })
}

// A short signed link, asked each time: the api audits who asked for it
export function fetchDsrExportLink(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<DsrExportLinkView> {
  return client.request(ApiRoutes.compliance.dsrExport(id), {
    schema: exportLinkSchema,
    storeId
  })
}
