import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import { type ExportView, exportSchema } from './exports-api'

// One entry of the audit log as the api tells it (TDD_05 §9.3). The row keeps ids, counts and the name of the action: the
// `metadata` is whatever the writer of the action put there, so it is read as an unknown value and drawn as text.
export const auditLogEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  // Null for the actions of the system and of a plugin
  userId: z.string().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  metadata: z.unknown(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  timestamp: z.string()
})
export type AuditLogEntryView = z.output<typeof auditLogEntrySchema>

export const auditLogPageSchema = z.object({
  data: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type AuditLogPageView = z.output<typeof auditLogPageSchema>

// What the screen narrows the log by. Every field is optional: an empty filter is the whole log of the store. `from` is
// inclusive and `before` exclusive, both instants (ISO 8601).
export interface AuditLogFilter {
  action?: string | undefined
  userId?: string | undefined
  from?: string | undefined
  before?: string | undefined
}

function filterQuery(filter: AuditLogFilter, cursor: string | null): string {
  const params = new URLSearchParams()
  if (filter.action !== undefined) params.set('action', filter.action)
  if (filter.userId !== undefined) params.set('userId', filter.userId)
  if (filter.from !== undefined) params.set('from', filter.from)
  if (filter.before !== undefined) params.set('before', filter.before)
  if (cursor !== null) params.set('cursor', cursor)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

// The log of the store of the request, newest first, one page at a time
export function fetchAuditLog(
  client: ApiClient,
  storeId: string,
  filter: AuditLogFilter,
  cursor: string | null,
  signal?: AbortSignal
): Promise<AuditLogPageView> {
  return client.request(`${ApiRoutes.organizations.auditLog}${filterQuery(filter, cursor)}`, {
    schema: auditLogPageSchema,
    storeId,
    signal
  })
}

export function fetchAuditLogEntry(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<AuditLogEntryView> {
  return client.request(ApiRoutes.organizations.auditLogEntry(encodeURIComponent(id)), {
    schema: auditLogEntrySchema,
    storeId,
    signal
  })
}

// "Export CSV": queues the file for the filters the screen shows and answers (202) with its row. With no `before` the api
// takes the moment of the request as the end, so the file is the log as it was when it was asked for. A range with more rows
// than the ceiling is refused with EXPORT_TOO_LARGE (400).
export function requestAuditLogExport(
  client: ApiClient,
  storeId: string,
  filter: AuditLogFilter
): Promise<ExportView> {
  return client.request(`${ApiRoutes.organizations.auditLogExport}${filterQuery(filter, null)}`, {
    schema: exportSchema,
    storeId
  })
}
