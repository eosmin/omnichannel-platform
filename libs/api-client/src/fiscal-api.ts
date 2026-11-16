import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import {
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  type FiscalEvidenceKind,
  FiscalIssueOn,
  type FiscalReceiverPatchBody,
  type PutFiscalIssuerBody
} from '@platform/core/domain'

import type { ApiClient } from './api-client'
import { mediaUrlsSchema, type MediaUrlsView } from './media-api'

// The fiscal documents of the organization and their issuer (TDD_18 §8, §12; Step 4B.9b-2). Reading is for fiscal:view; changing the
// issuer, fixing a receiver, retrying, voiding and replacing a document are for fiscal:manage (the api checks it on every call). The api
// answers `{ data }` here. An amount is whole cents of one document (an Int of the database) and a date is an ISO instant. The customer
// data of a document is minimized by the api: the name and the tax id masked, never the full record.

const receiverSchema = z.object({
  name: z.string().nullable(),
  taxIdMasked: z.string().nullable(),
  complete: z.boolean()
})

const documentSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  orderId: z.string(),
  kind: z.enum(FiscalDocumentKind),
  returnId: z.string().nullable(),
  parentDocumentId: z.string().nullable(),
  replacesDocumentId: z.string().nullable(),
  journalEntryId: z.string().nullable(),
  sequenceNumber: z.number().int(),
  documentType: z.string(),
  status: z.enum(FiscalDocumentStatus),
  providerId: z.string(),
  environment: z.enum(FiscalEnvironment),
  externalNumber: z.string().nullable(),
  currency: z.string(),
  totalCents: z.number().int(),
  taxCents: z.number().int(),
  rejectionReason: z.string().nullable(),
  attempts: z.number().int(),
  voidReason: z.string().nullable(),
  voidedAt: z.string().nullable(),
  issuedAt: z.string().nullable(),
  createdAt: z.string(),
  receiver: receiverSchema
})
export type FiscalDocumentView = z.output<typeof documentSchema>

const documentEnvelopeSchema = z.object({ data: documentSchema })

const documentPageSchema = z.object({
  data: z.array(documentSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type FiscalDocumentPageView = z.output<typeof documentPageSchema>

const providerSchema = z.object({
  id: z.string(),
  countryCode: z.string(),
  manifest: z.object({
    documentTypes: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        requiredReceiverFields: z.array(z.string()),
        creditNote: z.boolean().optional()
      })
    ),
    requiredIssuerFields: z.array(z.string()),
    // The names of the credentials the provider reads, never their values
    credentialKeys: z.array(z.string()),
    environments: z.array(z.enum(FiscalEnvironment))
  }),
  // What the provider does while the authority is down, in its own words
  contingency: z.string().nullable()
})
export type FiscalProviderView = z.output<typeof providerSchema>

const issuerSchema = z.object({
  providerId: z.string(),
  legalName: z.string(),
  taxId: z.string(),
  registrationId: z.string().nullable(),
  address: z.record(z.string(), z.unknown()),
  activityCode: z.string().nullable(),
  establishmentCode: z.string().nullable(),
  environment: z.enum(FiscalEnvironment),
  issueOn: z.enum(FiscalIssueOn),
  nextSequence: z.number().int(),
  // The credentials are written and never read back: only whether there are some
  credentialsSet: z.boolean(),
  updatedAt: z.string()
})
export type FiscalIssuerView = z.output<typeof issuerSchema>

const issuerEnvelopeSchema = z.object({ data: issuerSchema.nullable() })
const savedIssuerEnvelopeSchema = z.object({ data: issuerSchema })
const providersEnvelopeSchema = z.object({ data: z.array(providerSchema) })
const queuedEnvelopeSchema = z.object({ data: z.object({ queued: z.literal(true) }) })

// What the list is narrowed by: a key left out (or empty) is not a filter
export interface FiscalDocumentFilters {
  status?: FiscalDocumentStatus
  orderId?: string
}

export async function fetchFiscalProviders(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FiscalProviderView[]> {
  const answer = await client.request(ApiRoutes.fiscal.providers, {
    schema: providersEnvelopeSchema,
    storeId,
    signal
  })
  return answer.data
}

// Null while the organization has not set its issuer up (it issues no document yet)
export async function fetchFiscalIssuer(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FiscalIssuerView | null> {
  const answer = await client.request(ApiRoutes.fiscal.issuer, {
    schema: issuerEnvelopeSchema,
    storeId,
    signal
  })
  return answer.data
}

export async function putFiscalIssuer(
  client: ApiClient,
  storeId: string,
  body: PutFiscalIssuerBody
): Promise<FiscalIssuerView> {
  const answer = await client.request(ApiRoutes.fiscal.issuer, {
    method: 'PUT',
    body,
    schema: savedIssuerEnvelopeSchema,
    storeId
  })
  return answer.data
}

export function fetchFiscalDocumentPage(
  client: ApiClient,
  storeId: string,
  filters: FiscalDocumentFilters,
  cursor: string | null,
  signal?: AbortSignal
): Promise<FiscalDocumentPageView> {
  const search = new URLSearchParams()
  if (filters.status !== undefined) search.set('status', filters.status)
  if (filters.orderId !== undefined && filters.orderId !== '') {
    search.set('orderId', filters.orderId)
  }
  if (cursor !== null) search.set('cursor', cursor)
  const text = search.toString()
  return client.request(
    text === '' ? ApiRoutes.fiscal.documents.list : `${ApiRoutes.fiscal.documents.list}?${text}`,
    { schema: documentPageSchema, storeId, signal }
  )
}

export async function fetchFiscalDocument(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<FiscalDocumentView> {
  const answer = await client.request(ApiRoutes.fiscal.documents.byId(encodeURIComponent(id)), {
    schema: documentEnvelopeSchema,
    storeId,
    signal
  })
  return answer.data
}

export async function patchFiscalReceiver(
  client: ApiClient,
  storeId: string,
  id: string,
  body: FiscalReceiverPatchBody
): Promise<FiscalDocumentView> {
  const answer = await client.request(ApiRoutes.fiscal.documents.receiver(encodeURIComponent(id)), {
    method: 'PATCH',
    body,
    schema: documentEnvelopeSchema,
    storeId
  })
  return answer.data
}

// Sends the document again: it goes back to the queue and the provider is asked once more
export async function retryFiscalDocument(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<void> {
  await client.request(ApiRoutes.fiscal.documents.retry(encodeURIComponent(id)), {
    method: 'POST',
    schema: queuedEnvelopeSchema,
    storeId
  })
}

// Irreversible: the invalidation goes to the authority through the provider; the interface asks before it sends this
export async function voidFiscalDocument(
  client: ApiClient,
  storeId: string,
  id: string,
  reason: string
): Promise<FiscalDocumentView> {
  const answer = await client.request(ApiRoutes.fiscal.documents.void(encodeURIComponent(id)), {
    method: 'POST',
    body: { reason },
    schema: documentEnvelopeSchema,
    storeId
  })
  return answer.data
}

// The sale document made again after the one before was voided: a new document with a new number
export async function replaceFiscalDocument(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<FiscalDocumentView> {
  const answer = await client.request(ApiRoutes.fiscal.documents.replace(encodeURIComponent(id)), {
    method: 'POST',
    schema: documentEnvelopeSchema,
    storeId
  })
  return answer.data
}

// The link is put in an anchor by hand: only http(s) is a link (a `javascript:` or `data:` url is refused whoever sent it)
const evidenceEnvelopeSchema = z.object({
  data: mediaUrlsSchema.extend({ url: z.url({ protocol: /^https?$/ }) })
})

// The signed link of one file of evidence of a document: the api makes it short-lived (15 minutes) for a clean file of the organization of
// the document, so it is asked when the person clicks and never kept. The api answers 404 while the file does not exist.
export async function fetchFiscalEvidenceUrls(
  client: ApiClient,
  storeId: string,
  id: string,
  kind: FiscalEvidenceKind
): Promise<MediaUrlsView> {
  const answer = await client.request(
    ApiRoutes.fiscal.documents.evidence(encodeURIComponent(id), encodeURIComponent(kind)),
    { schema: evidenceEnvelopeSchema, storeId }
  )
  return answer.data
}

// A person who checked with the authority of the first issuer that the document is not there says so, with the reason: it is made again with
// the issuer as it is now and queued. HIGH tier: the interface asks before it sends this.
export async function confirmFiscalIssuerChange(
  client: ApiClient,
  storeId: string,
  id: string,
  reason: string
): Promise<void> {
  await client.request(ApiRoutes.fiscal.documents.confirmIssuerChange(encodeURIComponent(id)), {
    method: 'POST',
    body: { reason },
    schema: queuedEnvelopeSchema,
    storeId
  })
}
