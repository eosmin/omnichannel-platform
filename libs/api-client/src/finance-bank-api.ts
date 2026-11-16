import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The bank reconciliation by CSV (TDD_18 §4.4, Step 4B.9a-3): the profiles that read the file of a bank, the import of a statement, the
// suggestions a person decides on and the state of an account in a month. Every route asks for finance:reconcile and every amount is
// whole cents of US dollars (a statement line or a difference fits 32 bits, so they arrive as numbers and the screen writes them with
// `moneyText`, never through a float of its own). Nothing here posts an entry: a decision only pairs a line of the statement with a line
// of the books.

const columnRef = z.union([z.string(), z.number()])

const mappingSchema = z.object({
  date: columnRef,
  description: columnRef.optional(),
  reference: columnRef.optional(),
  amount: columnRef.optional(),
  debit: columnRef.optional(),
  credit: columnRef.optional()
})
export type BankMappingView = z.output<typeof mappingSchema>

const profileSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  delimiter: z.string(),
  hasHeader: z.boolean(),
  decimalSeparator: z.string(),
  thousandsSeparator: z.string(),
  dateFormat: z.string(),
  encoding: z.string(),
  dateWindowDays: z.number().int(),
  columns: mappingSchema,
  createdAt: z.string(),
  updatedAt: z.string()
})
export type BankProfileView = z.output<typeof profileSchema>

// What a profile is read with: the same keys the api takes to make one (`accountId` and `name` come apart, a preview needs neither)
export interface BankReadingInput {
  delimiter: string
  hasHeader: boolean
  decimalSeparator: string
  thousandsSeparator: string
  dateFormat: string
  encoding: string
  dateWindowDays: number
  columns: BankMappingView
}
export type CreateBankProfileInput = BankReadingInput & { accountId: string; name: string }
export type UpdateBankProfileInput = Partial<BankReadingInput & { name: string }>
// The mapper's preview takes the reading without the encoding and the window (the browser already decoded the text)
export type BankPreviewReading = Omit<BankReadingInput, 'encoding' | 'dateWindowDays'> &
  Partial<Pick<BankReadingInput, 'encoding' | 'dateWindowDays'>>

const rowErrorSchema = z.object({
  row: z.number().int(),
  field: z.string().nullable(),
  code: z.string(),
  value: z.string().nullable()
})
export type BankRowErrorView = z.output<typeof rowErrorSchema>

const parsedLineSchema = z.object({
  postedOn: z.string(),
  amountCents: z.number().int(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  row: z.number().int(),
  occurrence: z.number().int()
})

const previewSchema = z.object({
  headers: z.array(z.string()),
  rowCount: z.number().int(),
  lines: z.array(parsedLineSchema),
  errors: z.array(rowErrorSchema),
  errorCount: z.number().int()
})
export type BankPreviewView = z.output<typeof previewSchema>

const importSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  profileId: z.string().nullable(),
  mediaId: z.string(),
  lineCount: z.number().int(),
  newLineCount: z.number().int(),
  firstDay: z.string(),
  lastDay: z.string(),
  closingBalanceCents: z.number().int().nullable(),
  closingOn: z.string().nullable(),
  createdAt: z.string()
})
export type BankImportView = z.output<typeof importSchema>

const suggestionSchema = z.object({
  // The line of the journal the suggestion points at: the id a confirmation or a rejection sends
  bookLineId: z.string(),
  dayDifference: z.number().int(),
  referenceMatch: z.boolean(),
  exact: z.boolean(),
  entryId: z.string(),
  entryNumber: z.string(),
  entryDate: z.string(),
  memo: z.string().nullable(),
  signedCents: z.number().int()
})
export type BankSuggestionView = z.output<typeof suggestionSchema>

const matchSchema = z.object({
  id: z.string(),
  journalLineId: z.string(),
  entryId: z.string(),
  entryNumber: z.string(),
  entryDate: z.string(),
  decidedBy: z.string(),
  decidedAt: z.string()
})
export type BankMatchView = z.output<typeof matchSchema>

const lineSchema = z.object({
  id: z.string(),
  importId: z.string(),
  lineNo: z.number().int(),
  postedOn: z.string(),
  amountCents: z.number().int(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  match: matchSchema.nullable(),
  suggestions: z.array(suggestionSchema)
})
export type BankLineView = z.output<typeof lineSchema>

const linePageSchema = z.object({
  items: z.array(lineSchema),
  next: z.number().int().nullable(),
  counts: z.object({
    total: z.number().int(),
    matched: z.number().int(),
    unmatched: z.number().int(),
    suggested: z.number().int()
  })
})
export type BankLinePageView = z.output<typeof linePageSchema>

const sideSchema = z.object({
  lines: z.number().int(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  unmatchedCents: z.number().int()
})
const statusSchema = z.object({
  accountId: z.string(),
  year: z.number().int(),
  month: z.number().int(),
  book: sideSchema,
  statement: sideSchema,
  reconciled: z.boolean()
})
export type BankStatusView = z.output<typeof statusSchema>

const unmatchedSchema = z.object({ lines: z.number().int(), cents: z.number().int() })
const differenceSchema = z.object({
  importId: z.string(),
  accountId: z.string(),
  closingOn: z.string(),
  statementBalanceCents: z.number().int(),
  bookBalanceCents: z.number().int(),
  differenceCents: z.number().int(),
  unmatchedStatement: unmatchedSchema,
  unmatchedBook: unmatchedSchema,
  unexplainedCents: z.number().int()
})
export type BankDifferenceView = z.output<typeof differenceSchema>

// The transaction an unmatched line would be, prefilled: nothing is posted by reading it
const draftSchema = z.object({
  kind: z.string(),
  occurredOn: z.string(),
  amountCents: z.number().int(),
  fromAccountId: z.string().optional(),
  toAccountId: z.string().optional(),
  documentNumber: z.string().optional(),
  memo: z.string().optional()
})
export type BankRegisterDraftView = z.output<typeof draftSchema>

const confirmExactSchema = z.object({ confirmed: z.number().int(), left: z.number().int() })
export type BankConfirmExactView = z.output<typeof confirmExactSchema>

const encode = encodeURIComponent

export function fetchBankProfiles(
  client: ApiClient,
  storeId: string,
  accountId: string,
  signal?: AbortSignal
): Promise<BankProfileView[]> {
  const search = new URLSearchParams({ accountId })
  return client.request(`${ApiRoutes.finance.bank.profiles}?${search.toString()}`, {
    schema: z.array(profileSchema),
    storeId,
    signal
  })
}

export function createBankProfile(
  client: ApiClient,
  storeId: string,
  input: CreateBankProfileInput
): Promise<BankProfileView> {
  return client.request(ApiRoutes.finance.bank.profiles, {
    method: 'POST',
    body: input,
    schema: profileSchema,
    storeId
  })
}

export function updateBankProfile(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateBankProfileInput
): Promise<BankProfileView> {
  return client.request(ApiRoutes.finance.bank.profileById(encode(id)), {
    method: 'PATCH',
    body: input,
    schema: profileSchema,
    storeId
  })
}

export async function deleteBankProfile(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<void> {
  await client.request(ApiRoutes.finance.bank.profileById(encode(id)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// The mapper: a sample of the file (already text) read with the mapping being tried. Nothing is written
export function previewBankProfile(
  client: ApiClient,
  storeId: string,
  input: { text: string; profile: BankPreviewReading },
  signal?: AbortSignal
): Promise<BankPreviewView> {
  return client.request(ApiRoutes.finance.bank.profilePreview, {
    method: 'POST',
    body: input,
    schema: previewSchema,
    storeId,
    signal
  })
}

export interface ImportBankFileInput {
  profileId: string
  // The file as the bank wrote it: the api decodes the bytes with the encoding of the profile, so they are never sent as text
  bytes: ArrayBuffer
  contentType: string
  // The balance the statement ends with and the day it is of: both or neither (the api refuses one alone)
  closing?: { cents: number; on: string }
}

// The file itself is the body. A file with a row that cannot be read answers 400 BANK_STATEMENT_INVALID with every error and
// makes nothing; one with no new line answers 409
export function importBankStatement(
  client: ApiClient,
  storeId: string,
  input: ImportBankFileInput
): Promise<BankImportView> {
  const search = new URLSearchParams({ profileId: input.profileId })
  if (input.closing !== undefined) {
    search.set('closingBalanceCents', String(input.closing.cents))
    search.set('closingOn', input.closing.on)
  }
  return client.request(`${ApiRoutes.finance.bank.imports}?${search.toString()}`, {
    method: 'POST',
    fileBody: { bytes: input.bytes, contentType: input.contentType },
    schema: importSchema,
    storeId
  })
}

export function fetchBankImports(
  client: ApiClient,
  storeId: string,
  accountId: string,
  signal?: AbortSignal
): Promise<BankImportView[]> {
  const search = new URLSearchParams({ accountId, limit: String(PaginationLimits.MAX) })
  return client.request(`${ApiRoutes.finance.bank.imports}?${search.toString()}`, {
    schema: z.array(importSchema),
    storeId,
    signal
  })
}

export function fetchBankImport(
  client: ApiClient,
  storeId: string,
  importId: string,
  signal?: AbortSignal
): Promise<BankImportView> {
  return client.request(ApiRoutes.finance.bank.importById(encode(importId)), {
    schema: importSchema,
    storeId,
    signal
  })
}

export function fetchBankLines(
  client: ApiClient,
  storeId: string,
  importId: string,
  query: { filter: string; after?: number | null },
  signal?: AbortSignal
): Promise<BankLinePageView> {
  const search = new URLSearchParams({ filter: query.filter })
  if (query.after !== undefined && query.after !== null) search.set('after', String(query.after))
  return client.request(
    `${ApiRoutes.finance.bank.importLines(encode(importId))}?${search.toString()}`,
    {
      schema: linePageSchema,
      storeId,
      signal
    }
  )
}

// Confirms, in one go, every line whose suggestion is the only one and an exact one. The screen asks first
export function confirmExactBankLines(
  client: ApiClient,
  storeId: string,
  importId: string
): Promise<BankConfirmExactView> {
  return client.request(ApiRoutes.finance.bank.confirmExact(encode(importId)), {
    method: 'POST',
    schema: confirmExactSchema,
    storeId
  })
}

export function fetchBankDifference(
  client: ApiClient,
  storeId: string,
  importId: string,
  signal?: AbortSignal
): Promise<BankDifferenceView> {
  return client.request(ApiRoutes.finance.bank.difference(encode(importId)), {
    schema: differenceSchema,
    storeId,
    signal
  })
}

// A person says this line of the journal is the same movement as this line of the statement
export function confirmBankMatch(
  client: ApiClient,
  storeId: string,
  lineId: string,
  journalLineId: string
): Promise<BankLineView> {
  return client.request(ApiRoutes.finance.bank.lineMatches(encode(lineId)), {
    method: 'POST',
    body: { journalLineId },
    schema: lineSchema,
    storeId
  })
}

// ... and this one is not: the suggestion does not come back
export function rejectBankMatch(
  client: ApiClient,
  storeId: string,
  lineId: string,
  journalLineId: string
): Promise<BankLineView> {
  return client.request(ApiRoutes.finance.bank.lineRejections(encode(lineId)), {
    method: 'POST',
    body: { journalLineId },
    schema: lineSchema,
    storeId
  })
}

// Takes a decision back (a confirmed pair or a rejection): the line is as it was before it
export function undoBankMatch(
  client: ApiClient,
  storeId: string,
  matchId: string
): Promise<BankLineView> {
  return client.request(ApiRoutes.finance.bank.matchUndo(encode(matchId)), {
    method: 'POST',
    schema: lineSchema,
    storeId
  })
}

export function fetchBankRegisterDraft(
  client: ApiClient,
  storeId: string,
  lineId: string,
  signal?: AbortSignal
): Promise<BankRegisterDraftView> {
  return client.request(ApiRoutes.finance.bank.lineRegisterDraft(encode(lineId)), {
    schema: draftSchema,
    storeId,
    signal
  })
}

export function fetchBankStatus(
  client: ApiClient,
  storeId: string,
  query: { accountId: string; year: number; month: number },
  signal?: AbortSignal
): Promise<BankStatusView> {
  const search = new URLSearchParams({
    accountId: query.accountId,
    year: String(query.year),
    month: String(query.month)
  })
  return client.request(`${ApiRoutes.finance.bank.status}?${search.toString()}`, {
    schema: statusSchema,
    storeId,
    signal
  })
}
