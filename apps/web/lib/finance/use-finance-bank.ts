'use client'

import {
  keepPreviousData,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type BankBookCandidatesView,
  type BankConfirmExactView,
  type BankDifferenceView,
  type BankImportView,
  type BankLinePageView,
  type BankLineView,
  type BankPreviewReading,
  type BankPreviewView,
  type BankProfileView,
  type BankRegisterDraftView,
  type BankStatusView,
  confirmBankGroup,
  confirmBankMatch,
  confirmExactBankLines,
  createBankProfile,
  type CreateBankProfileInput,
  deleteBankProfile,
  fetchBankBookCandidates,
  fetchBankDifference,
  fetchBankImport,
  fetchBankImports,
  fetchBankLines,
  fetchBankProfiles,
  fetchBankRegisterDraft,
  fetchBankStatus,
  isFinanceBankKey,
  type ImportBankFileInput,
  importBankStatement,
  previewBankProfile,
  QueryKeys,
  rejectBankMatch,
  undoBankMatch,
  type UpdateBankProfileInput,
  updateBankProfile
} from '@platform/api-client'

import { apiClient } from '../api'

// The hooks of the bank reconciliation screen (Step 4B.9a-3). Reading is for finance:reconcile and `enabled` keeps a page from asking
// for what its person may not read. Every write makes the whole `bank` family of the keys stale, in every store: the books belong to
// the organization, a decision changes the lines, the counts, the status of the month and the difference of the statement at once.

export function useBankProfiles(
  storeId: string,
  accountId: string,
  enabled: boolean
): UseQueryResult<BankProfileView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.profiles(storeId, accountId),
    queryFn: ({ signal }) => fetchBankProfiles(apiClient, storeId, accountId, signal),
    enabled: enabled && accountId !== ''
  })
}

export function useBankImports(
  storeId: string,
  accountId: string,
  enabled: boolean
): UseQueryResult<BankImportView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.imports(storeId, accountId),
    queryFn: ({ signal }) => fetchBankImports(apiClient, storeId, accountId, signal),
    enabled: enabled && accountId !== ''
  })
}

// One statement by its id: the screen reads the one it opened from the api and not from the list, so it is right even when the list
// has not been read again yet (just after an import)
export function useBankImport(
  storeId: string,
  importId: string | null
): UseQueryResult<BankImportView> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.import(storeId, importId ?? ''),
    queryFn: ({ signal }) => fetchBankImport(apiClient, storeId, importId as string, signal),
    enabled: importId !== null
  })
}

// One page of the lines of a statement, in the order of the file. The page the person is on stays while the next one loads.
export function useBankLines(
  storeId: string,
  importId: string,
  filter: string,
  after: number | null
): UseQueryResult<BankLinePageView> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.lines(storeId, importId, filter, after),
    queryFn: ({ signal }) =>
      fetchBankLines(apiClient, storeId, importId, { filter, after }, signal),
    placeholderData: keepPreviousData
  })
}

// 409 BANK_NO_CLOSING_BALANCE when the statement said none: the caller asks only for a statement that has one
export function useBankDifference(
  storeId: string,
  importId: string,
  enabled: boolean
): UseQueryResult<BankDifferenceView> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.difference(storeId, importId),
    queryFn: ({ signal }) => fetchBankDifference(apiClient, storeId, importId, signal),
    enabled,
    retry: false
  })
}

export function useBankStatus(
  storeId: string,
  query: { accountId: string; year: number; month: number } | null
): UseQueryResult<BankStatusView> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.status(
      storeId,
      query?.accountId ?? '',
      query?.year ?? 0,
      query?.month ?? 0
    ),
    queryFn: ({ signal }) =>
      fetchBankStatus(apiClient, storeId, query as NonNullable<typeof query>, signal),
    enabled: query !== null
  })
}

// What an unmatched line would be as a transaction, prefilled. Only asked when the person opens it (reading it posts nothing)
export function useBankRegisterDraft(
  storeId: string,
  lineId: string | null
): UseQueryResult<BankRegisterDraftView> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.draft(storeId, lineId ?? ''),
    queryFn: ({ signal }) => fetchBankRegisterDraft(apiClient, storeId, lineId as string, signal),
    enabled: lineId !== null,
    retry: false
  })
}

// The lines of the books a group can be chosen from (HC-121). Only asked while the dialog of the group is open; read again each time it
// opens, because a line of the books may have been matched or reversed since.
export function useBankBookCandidates(
  storeId: string,
  lineId: string | null
): UseQueryResult<BankBookCandidatesView> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.candidates(storeId, lineId ?? ''),
    queryFn: ({ signal }) => fetchBankBookCandidates(apiClient, storeId, lineId as string, signal),
    enabled: lineId !== null,
    gcTime: 0,
    retry: false
  })
}

// The key of a sample: its size and a hash of it, so the key stays short (a sample can be 32 KB) and every other sample has its own
function keyOfSample(request: { text: string; profile: BankPreviewReading }): unknown {
  let hash = 5381
  for (let index = 0; index < request.text.length; index += 1) {
    hash = ((hash << 5) + hash + request.text.charCodeAt(index)) | 0
  }
  return { size: request.text.length, hash, profile: request.profile }
}

// The mapper's preview: nothing is written. The rows of the earlier mapping stay on the screen until the answer for the new one arrives.
export function useBankPreview(
  storeId: string,
  request: { text: string; profile: BankPreviewReading } | null
): UseQueryResult<BankPreviewView> {
  return useQuery({
    queryKey: QueryKeys.finance.bank.preview(
      storeId,
      request === null ? null : keyOfSample(request)
    ),
    queryFn: ({ signal }) =>
      previewBankProfile(apiClient, storeId, request as NonNullable<typeof request>, signal),
    enabled: request !== null,
    placeholderData: keepPreviousData,
    retry: false
  })
}

function useBankWrite<TInput, TResult>(
  write: (input: TInput) => Promise<TResult>
): UseMutationResult<TResult, Error, TInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: write,
    // Returned, so the mutation settles after the lists have been read again: a dialog closes on fresh data, not on the old
    // Not returned: a dialog is free as soon as the write is answered, and the lists read again behind it
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.finance.root,
        predicate: query => isFinanceBankKey(query.queryKey)
      })
  })
}

type Write<TInput, TResult> = UseMutationResult<TResult, Error, TInput>

export const useCreateBankProfile = (
  storeId: string
): Write<CreateBankProfileInput, BankProfileView> =>
  useBankWrite(input => createBankProfile(apiClient, storeId, input))

export const useUpdateBankProfile = (
  storeId: string
): Write<{ id: string; changes: UpdateBankProfileInput }, BankProfileView> =>
  useBankWrite(input => updateBankProfile(apiClient, storeId, input.id, input.changes))

export const useDeleteBankProfile = (storeId: string): Write<string, void> =>
  useBankWrite(id => deleteBankProfile(apiClient, storeId, id))

export const useImportBankStatement = (
  storeId: string
): Write<ImportBankFileInput, BankImportView> =>
  useBankWrite(input => importBankStatement(apiClient, storeId, input))

export const useConfirmBankMatch = (
  storeId: string
): Write<{ lineId: string; journalLineId: string }, BankLineView> =>
  useBankWrite(input => confirmBankMatch(apiClient, storeId, input.lineId, input.journalLineId))

export const useConfirmBankGroup = (
  storeId: string
): Write<{ lineId: string; journalLineIds: readonly string[] }, BankLineView> =>
  useBankWrite(input => confirmBankGroup(apiClient, storeId, input.lineId, input.journalLineIds))

export const useRejectBankMatch = (
  storeId: string
): Write<{ lineId: string; journalLineId: string }, BankLineView> =>
  useBankWrite(input => rejectBankMatch(apiClient, storeId, input.lineId, input.journalLineId))

export const useUndoBankMatch = (storeId: string): Write<string, BankLineView> =>
  useBankWrite(matchId => undoBankMatch(apiClient, storeId, matchId))

export const useConfirmExactBankLines = (storeId: string): Write<string, BankConfirmExactView> =>
  useBankWrite(importId => confirmExactBankLines(apiClient, storeId, importId))
