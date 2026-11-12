import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import {
  type AddRemittanceLinesBody,
  type ConfirmRemittanceBody,
  type RemittanceLineInput,
  type CreateRemittanceImportProfileBody,
  type RemittanceImportPreviewBody,
  type UpdateRemittanceImportProfileBody,
  type UpdateRemittanceLineBody,
  type VoidRemittanceBody,
  CodStatus,
  PaginationLimits,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  RemittanceImportErrors,
  RemittanceImportFields,
  RemittanceLineOutcome,
  RemittanceStatus
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the remittance routes answer (TDD_17 §4.15, §6). Every amount is whole cents, never a float: a screen shows it through
// the one money formatter. The views carry amounts and guide numbers only, never the recipient or the address of an order.

const totalsSchema = z.object({
  expectedCents: z.number().int(),
  reportedCents: z.number().int(),
  feeCents: z.number().int(),
  // Reported minus expected: negative when the carrier sent less than was due
  differenceCents: z.number().int()
})
export type RemittanceTotalsView = z.output<typeof totalsSchema>

const remittanceSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  carrierId: z.string(),
  status: z.enum(RemittanceStatus),
  reference: z.string().nullable(),
  receivedOn: z.string().nullable(),
  importProfileId: z.string().nullable(),
  sourceMediaId: z.string().nullable(),
  totals: totalsSchema,
  lineCount: z.number().int(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidedBy: z.string().nullable(),
  voidReason: z.string().nullable()
})
export type RemittanceView = z.output<typeof remittanceSchema>

const remittancePageSchema = z.object({
  data: z.array(remittanceSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type RemittancePageView = z.output<typeof remittancePageSchema>

const lineSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  guideNumber: z.string(),
  shipmentId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  reportedCents: z.number().int(),
  reportedFeeCents: z.number().int().nullable(),
  expectedCents: z.number().int().nullable(),
  differenceCents: z.number().int().nullable(),
  outcome: z.enum(RemittanceLineOutcome),
  excluded: z.boolean(),
  note: z.string().nullable()
})
export type RemittanceLineView = z.output<typeof lineSchema>

const remittanceDetailSchema = remittanceSchema.extend({ lines: z.array(lineSchema) })
export type RemittanceDetailView = z.output<typeof remittanceDetailSchema>

const pendingShipmentSchema = z.object({
  shipmentId: z.string(),
  orderNumber: z.string(),
  guideNumber: z.string().nullable(),
  codStatus: z.enum(CodStatus),
  expectedCents: z.number().int(),
  remittedCents: z.number().int().nullable(),
  // Expected minus what a remittance already brought: negative when the carrier sent more than was due
  owedCents: z.number().int(),
  deliveredAt: z.string().nullable(),
  ageDays: z.number().int().nullable()
})
export type PendingShipmentView = z.output<typeof pendingShipmentSchema>

const pendingConnectionSchema = z.object({
  connectionId: z.string(),
  connectionName: z.string(),
  carrierId: z.string(),
  count: z.number().int(),
  totalOwedCents: z.number().int(),
  oldestDeliveredAt: z.string().nullable(),
  oldestAgeDays: z.number().int().nullable(),
  // Filled only when one connection is asked for, oldest first and bounded
  shipments: z.array(pendingShipmentSchema),
  truncated: z.boolean()
})
export type PendingConnectionView = z.output<typeof pendingConnectionSchema>
const pendingSchema = z.array(pendingConnectionSchema)

// ------------------------------------------------------------------------------------------------------ the import

const columnRefSchema = z.union([z.string(), z.number().int()])

const mappingSchema = z.object({
  guideNumber: columnRefSchema,
  amount: columnRefSchema,
  fee: columnRefSchema.optional(),
  date: columnRefSchema.optional(),
  reference: columnRefSchema.optional()
})

const profileSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  name: z.string(),
  delimiter: z.enum([
    RemittanceDelimiters.COMMA,
    RemittanceDelimiters.SEMICOLON,
    RemittanceDelimiters.TAB
  ]),
  hasHeader: z.boolean(),
  decimalSeparator: z.enum([RemittanceDecimalSeparators.DOT, RemittanceDecimalSeparators.COMMA]),
  dateFormat: z.enum([
    RemittanceDateFormats.ISO,
    RemittanceDateFormats.DAY_FIRST_SLASH,
    RemittanceDateFormats.MONTH_FIRST_SLASH,
    RemittanceDateFormats.DAY_FIRST_DASH
  ]),
  columns: mappingSchema,
  createdAt: z.string(),
  updatedAt: z.string()
})
export type RemittanceImportProfileView = z.output<typeof profileSchema>
const profilesSchema = z.array(profileSchema)

const fieldSchema = z.enum([
  RemittanceImportFields.GUIDE_NUMBER,
  RemittanceImportFields.AMOUNT,
  RemittanceImportFields.FEE,
  RemittanceImportFields.DATE,
  RemittanceImportFields.REFERENCE
])

// A code the page does not know yet (a server newer than the page) is kept as it came and shown as the generic text
const rowErrorSchema = z.object({
  row: z.number().int(),
  field: fieldSchema.nullable(),
  code: z.string(),
  value: z.string().nullable()
})
export type ImportRowErrorView = z.output<typeof rowErrorSchema>

const importedLineSchema = z.object({
  guideNumber: z.string(),
  reportedCents: z.number().int(),
  reportedFeeCents: z.number().int().optional(),
  row: z.number().int()
})
export type ImportedLineView = z.output<typeof importedLineSchema>

const previewSchema = z.object({
  headers: z.array(z.string()),
  rowCount: z.number().int(),
  lines: z.array(importedLineSchema),
  errors: z.array(rowErrorSchema),
  errorCount: z.number().int(),
  reference: z.string().nullable(),
  receivedOn: z.string().nullable()
})
export type ImportPreviewView = z.output<typeof previewSchema>

// The codes of a row error that a screen has a text for; any other code is the generic text
export const KnownImportErrorCodes: readonly string[] = Object.values(RemittanceImportErrors)

// ------------------------------------------------------------------------------------------------------ the calls

export interface ListRemittancesParams {
  cursor?: string | null
  limit?: number
  status?: RemittanceStatus
  connectionId?: string
}

export function fetchRemittances(
  client: ApiClient,
  storeId: string,
  params: ListRemittancesParams = {},
  signal?: AbortSignal
): Promise<RemittancePageView> {
  const search = new URLSearchParams()
  if (params.status !== undefined) search.set('status', params.status)
  if (params.connectionId !== undefined) search.set('connectionId', params.connectionId)
  if (params.cursor !== undefined && params.cursor !== null) search.set('cursor', params.cursor)
  search.set('limit', String(params.limit ?? PaginationLimits.DEFAULT))
  return client.request(`${ApiRoutes.remittances.list}?${search.toString()}`, {
    schema: remittancePageSchema,
    storeId,
    signal
  })
}

// What the carriers still owe, per connection. With one connection the answer also names its shipments, oldest first
export function fetchRemittancePending(
  client: ApiClient,
  storeId: string,
  connectionId?: string,
  signal?: AbortSignal
): Promise<PendingConnectionView[]> {
  const query =
    connectionId === undefined ? '' : `?${new URLSearchParams({ connectionId }).toString()}`
  return client.request(`${ApiRoutes.remittances.pending}${query}`, {
    schema: pendingSchema,
    storeId,
    signal
  })
}

export function fetchRemittance(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<RemittanceDetailView> {
  return client.request(ApiRoutes.remittances.byId(encodeURIComponent(id)), {
    schema: remittanceDetailSchema,
    storeId,
    signal
  })
}

export interface CreateRemittanceInput {
  connectionId: string
  reference?: string
  receivedOn?: string
  note?: string
  lines?: RemittanceLineInput[]
}

export function createRemittance(
  client: ApiClient,
  storeId: string,
  input: CreateRemittanceInput
): Promise<RemittanceDetailView> {
  return client.request(ApiRoutes.remittances.list, {
    method: 'POST',
    body: input,
    schema: remittanceDetailSchema,
    storeId
  })
}

// A draft nobody wants; a confirmed remittance is never deleted, it is voided
export async function discardRemittance(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<void> {
  await client.request(ApiRoutes.remittances.byId(encodeURIComponent(id)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

export function addRemittanceLines(
  client: ApiClient,
  storeId: string,
  id: string,
  input: AddRemittanceLinesBody
): Promise<RemittanceDetailView> {
  return client.request(ApiRoutes.remittances.lines(encodeURIComponent(id)), {
    method: 'POST',
    body: input,
    schema: remittanceDetailSchema,
    storeId
  })
}

export function updateRemittanceLine(
  client: ApiClient,
  storeId: string,
  id: string,
  lineId: string,
  input: UpdateRemittanceLineBody
): Promise<RemittanceDetailView> {
  return client.request(
    ApiRoutes.remittances.lineById(encodeURIComponent(id), encodeURIComponent(lineId)),
    { method: 'PATCH', body: input, schema: remittanceDetailSchema, storeId }
  )
}

export function confirmRemittance(
  client: ApiClient,
  storeId: string,
  id: string,
  input: ConfirmRemittanceBody
): Promise<RemittanceDetailView> {
  return client.request(ApiRoutes.remittances.confirm(encodeURIComponent(id)), {
    method: 'POST',
    body: input,
    schema: remittanceDetailSchema,
    storeId
  })
}

export function voidRemittance(
  client: ApiClient,
  storeId: string,
  id: string,
  input: VoidRemittanceBody
): Promise<RemittanceDetailView> {
  return client.request(ApiRoutes.remittances.void(encodeURIComponent(id)), {
    method: 'POST',
    body: input,
    schema: remittanceDetailSchema,
    storeId
  })
}

export function fetchRemittanceImportProfiles(
  client: ApiClient,
  storeId: string,
  connectionId?: string,
  signal?: AbortSignal
): Promise<RemittanceImportProfileView[]> {
  const query =
    connectionId === undefined ? '' : `?${new URLSearchParams({ connectionId }).toString()}`
  return client.request(`${ApiRoutes.remittances.importProfiles}${query}`, {
    schema: profilesSchema,
    storeId,
    signal
  })
}

export function createRemittanceImportProfile(
  client: ApiClient,
  storeId: string,
  input: CreateRemittanceImportProfileBody
): Promise<RemittanceImportProfileView> {
  return client.request(ApiRoutes.remittances.importProfiles, {
    method: 'POST',
    body: input,
    schema: profileSchema,
    storeId
  })
}

export function updateRemittanceImportProfile(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateRemittanceImportProfileBody
): Promise<RemittanceImportProfileView> {
  return client.request(ApiRoutes.remittances.importProfileById(encodeURIComponent(id)), {
    method: 'PATCH',
    body: input,
    schema: profileSchema,
    storeId
  })
}

export async function deleteRemittanceImportProfile(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<void> {
  await client.request(ApiRoutes.remittances.importProfileById(encodeURIComponent(id)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// The mapper: a sample of the file read with the mapping being tried. It writes nothing
export function previewRemittanceImport(
  client: ApiClient,
  storeId: string,
  input: RemittanceImportPreviewBody,
  signal?: AbortSignal
): Promise<ImportPreviewView> {
  return client.request(ApiRoutes.remittances.importPreview, {
    method: 'POST',
    body: input,
    schema: previewSchema,
    storeId,
    signal
  })
}

// The file itself is the body. A file with an unreadable row answers 400 REMITTANCE_IMPORT_INVALID with every error and makes
// nothing; a good one becomes a draft
export function importRemittanceFile(
  client: ApiClient,
  storeId: string,
  input: { connectionId: string; profileId: string; text: string; contentType: string }
): Promise<RemittanceDetailView> {
  const query = new URLSearchParams({
    connectionId: input.connectionId,
    profileId: input.profileId
  })
  return client.request(`${ApiRoutes.remittances.imports}?${query.toString()}`, {
    method: 'POST',
    textBody: { text: input.text, contentType: input.contentType },
    schema: remittanceDetailSchema,
    storeId
  })
}
