'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import {
  attachFinanceTransactionDocument,
  confirmUpload,
  type CreateFinanceAccountInput,
  type CreateFinanceTaxRateInput,
  createFinanceAccount,
  createFinanceTaxRate,
  fetchAllFinanceAccounts,
  fetchFinanceEntry,
  fetchFinanceEntryPage,
  fetchFinanceTransaction,
  fetchFinanceTransactionDocumentUrls,
  fetchFinanceTransactionPage,
  fetchMediaUrls,
  fetchAllFinancePeriods,
  fetchFinanceAccountRoles,
  fetchFinanceBalances,
  fetchFinancePaymentAccounts,
  fetchFinancePostingPage,
  fetchFinanceSettings,
  fetchFinanceSetup,
  fetchFinanceStoreTaxSettings,
  fetchFinanceTaxRates,
  type FinanceAccountView,
  type FinanceBalanceView,
  type FinanceEntryDetailView,
  type FinanceEntryFilters,
  type FinanceEntryPageView,
  type FinancePaymentAccountView,
  type FinancePeriodView,
  type FinancePostingPageView,
  type FinanceRoleMappingView,
  type FinanceSettingsView,
  type FinanceSetupView,
  type FinanceStoreTaxSettingsView,
  type FinanceTaxRateView,
  type FinanceTransactionFilters,
  type FinanceTransactionPageView,
  type FinanceTransactionView,
  type ManualFinanceEntryInput,
  type MediaUrlsView,
  mapFinanceAccountRole,
  openFinancePeriod,
  postManualFinanceEntry,
  QueryKeys,
  recordFinanceTransaction,
  type RecordFinanceTransactionInput,
  replaceFinanceTransaction,
  requestUploadUrl,
  reverseFinanceEntry,
  removeFinancePaymentAccount,
  retryFinancePosting,
  setFinanceAccountActive,
  setFinancePaymentAccount,
  setFinanceTaxRateActive,
  setUpFinance,
  type UpdateFinanceAccountInput,
  type UpdateFinanceSettingsInput,
  type UpdateFinanceTaxRateInput,
  updateFinanceAccount,
  updateFinanceSettings,
  updateFinanceStoreTaxSettings,
  updateFinanceTaxRate,
  voidFinanceTransaction
} from '@platform/api-client'
import { MediaPurpose } from '@platform/core/storage'

import { apiClient } from '../api'
import { uploadToUrl } from '../media/upload-to-url'
import { waitUntilClean } from '../media/wait-until-clean'

// The hooks of the finance screens (Step 4B.9a-1). Reading is for finance:view and `enabled` keeps a page from asking for what its
// person may not read; every write makes the whole `finance` root stale, because the books belong to the organization and any store
// of it may be showing them.

export function useFinanceSetup(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceSetupView> {
  return useQuery({
    queryKey: QueryKeys.finance.setup(storeId),
    queryFn: ({ signal }) => fetchFinanceSetup(apiClient, storeId, signal),
    enabled
  })
}

// The rest of the books exist only once the setup is done: a page that reads them waits for `enabled`
export function useFinanceSettings(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceSettingsView> {
  return useQuery({
    queryKey: QueryKeys.finance.settings(storeId),
    queryFn: ({ signal }) => fetchFinanceSettings(apiClient, storeId, signal),
    enabled
  })
}

export function useFinanceAccounts(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceAccountView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.accounts(storeId),
    queryFn: ({ signal }) => fetchAllFinanceAccounts(apiClient, storeId, signal),
    enabled
  })
}

export function useFinanceRoles(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceRoleMappingView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.accountRoles(storeId),
    queryFn: ({ signal }) => fetchFinanceAccountRoles(apiClient, storeId, signal),
    enabled
  })
}

export function useFinancePaymentAccounts(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinancePaymentAccountView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.paymentAccounts(storeId),
    queryFn: ({ signal }) => fetchFinancePaymentAccounts(apiClient, storeId, signal),
    enabled
  })
}

export function useFinanceTaxRates(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceTaxRateView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.taxRates(storeId),
    queryFn: ({ signal }) => fetchFinanceTaxRates(apiClient, storeId, signal),
    enabled
  })
}

export function useFinanceStoreTax(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceStoreTaxSettingsView> {
  return useQuery({
    queryKey: QueryKeys.finance.storeTaxSettings(storeId),
    queryFn: ({ signal }) => fetchFinanceStoreTaxSettings(apiClient, storeId, signal),
    enabled
  })
}

export function useFinancePeriods(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinancePeriodView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.periods(storeId),
    queryFn: ({ signal }) => fetchAllFinancePeriods(apiClient, storeId, signal),
    enabled
  })
}

// Every period when none is named
export function useFinanceBalances(
  storeId: string,
  periodId: string | null,
  enabled: boolean
): UseQueryResult<FinanceBalanceView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.balances(storeId, periodId),
    queryFn: ({ signal }) => fetchFinanceBalances(apiClient, storeId, periodId, signal),
    enabled
  })
}

// The newest page of the entries the books could not post: what is behind it is read by the retry, one at a time
export function useFinancePostings(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinancePostingPageView> {
  return useQuery({
    queryKey: QueryKeys.finance.postings(storeId),
    queryFn: ({ signal }) => fetchFinancePostingPage(apiClient, storeId, null, signal),
    enabled
  })
}

function useFinanceWrite<TInput, TResult>(
  write: (input: TInput) => Promise<TResult>
): UseMutationResult<TResult, Error, TInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: write,
    // Returned, so the mutation settles after the lists have been read again: a dialog closes on fresh data, not on the old
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QueryKeys.finance.root })
  })
}

type Write<TInput, TResult> = UseMutationResult<TResult, Error, TInput>

export const useSetUpFinance = (
  storeId: string
): Write<{ countryCode: string; accountingStartDate?: string }, FinanceSetupView> =>
  useFinanceWrite(input => setUpFinance(apiClient, storeId, input))

export const useUpdateFinanceSettings = (
  storeId: string
): Write<UpdateFinanceSettingsInput, FinanceSettingsView> =>
  useFinanceWrite(input => updateFinanceSettings(apiClient, storeId, input))

export const useCreateFinanceAccount = (
  storeId: string
): Write<CreateFinanceAccountInput, FinanceAccountView> =>
  useFinanceWrite(input => createFinanceAccount(apiClient, storeId, input))

export const useUpdateFinanceAccount = (
  storeId: string
): Write<{ id: string; changes: UpdateFinanceAccountInput }, FinanceAccountView> =>
  useFinanceWrite(input => updateFinanceAccount(apiClient, storeId, input.id, input.changes))

export const useSetFinanceAccountActive = (
  storeId: string
): Write<{ id: string; active: boolean }, FinanceAccountView> =>
  useFinanceWrite(input => setFinanceAccountActive(apiClient, storeId, input.id, input.active))

export const useMapFinanceRole = (
  storeId: string
): Write<{ role: string; accountId: string }, FinanceRoleMappingView> =>
  useFinanceWrite(input => mapFinanceAccountRole(apiClient, storeId, input.role, input.accountId))

export const useSetFinancePaymentAccount = (
  storeId: string
): Write<
  { paymentMethod: string; accountId: string; forStoreId: string | null },
  FinancePaymentAccountView
> => useFinanceWrite(input => setFinancePaymentAccount(apiClient, storeId, input))

export const useRemoveFinancePaymentAccount = (storeId: string): Write<string, void> =>
  useFinanceWrite(id => removeFinancePaymentAccount(apiClient, storeId, id))

export const useCreateFinanceTaxRate = (
  storeId: string
): Write<CreateFinanceTaxRateInput, FinanceTaxRateView> =>
  useFinanceWrite(input => createFinanceTaxRate(apiClient, storeId, input))

export const useUpdateFinanceTaxRate = (
  storeId: string
): Write<{ id: string; changes: UpdateFinanceTaxRateInput }, FinanceTaxRateView> =>
  useFinanceWrite(input => updateFinanceTaxRate(apiClient, storeId, input.id, input.changes))

export const useSetFinanceTaxRateActive = (
  storeId: string
): Write<{ id: string; active: boolean }, FinanceTaxRateView> =>
  useFinanceWrite(input => setFinanceTaxRateActive(apiClient, storeId, input.id, input.active))

export const useUpdateFinanceStoreTax = (
  storeId: string
): Write<{ pricesIncludeTax: boolean }, FinanceStoreTaxSettingsView> =>
  useFinanceWrite(input => updateFinanceStoreTaxSettings(apiClient, storeId, input))

export const useOpenFinancePeriod = (
  storeId: string
): Write<{ year: number; month: number }, FinancePeriodView> =>
  useFinanceWrite(input => openFinancePeriod(apiClient, storeId, input))

export const useRetryFinancePosting = (storeId: string): Write<string, void> =>
  useFinanceWrite(id => retryFinancePosting(apiClient, storeId, id))

// The journal and the transactions (Step 4B.9a-2). Read by `finance:view_journal`; a page is the newest first, and the next one is
// asked with the cursor of the last. The filters are part of the key, so another filter is another list.
const keyOfFilters = (
  filters: Record<string, string | boolean | undefined>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== '' && value !== false)
      .map(([key, value]) => [key, String(value)])
  )

export function useFinanceEntries(
  storeId: string,
  filters: FinanceEntryFilters,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<FinanceEntryPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.finance.entries(storeId, keyOfFilters({ ...filters })),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchFinanceEntryPage(apiClient, storeId, filters, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === storeId ? previous : undefined,
    enabled
  })
}

export function useFinanceEntry(
  storeId: string,
  id: string | null
): UseQueryResult<FinanceEntryDetailView> {
  return useQuery({
    queryKey: QueryKeys.finance.entry(storeId, id ?? ''),
    queryFn: ({ signal }) => fetchFinanceEntry(apiClient, storeId, id ?? '', signal),
    enabled: id !== null
  })
}

export function useFinanceTransactions(
  storeId: string,
  filters: FinanceTransactionFilters,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<FinanceTransactionPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.finance.transactions(storeId, keyOfFilters({ ...filters })),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchFinanceTransactionPage(apiClient, storeId, filters, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === storeId ? previous : undefined,
    enabled
  })
}

export function useFinanceTransaction(
  storeId: string,
  id: string | null
): UseQueryResult<FinanceTransactionView> {
  return useQuery({
    queryKey: QueryKeys.finance.transaction(storeId, id ?? ''),
    queryFn: ({ signal }) => fetchFinanceTransaction(apiClient, storeId, id ?? '', signal),
    enabled: id !== null
  })
}

// The signed links of a receipt expire in 15 minutes: they are asked when the transaction is open and read again after 5
export function useFinanceReceiptUrls(
  storeId: string,
  transactionId: string,
  enabled: boolean
): UseQueryResult<MediaUrlsView> {
  return useQuery({
    queryKey: QueryKeys.finance.transactionDocument(storeId, transactionId),
    queryFn: ({ signal }) =>
      fetchFinanceTransactionDocumentUrls(apiClient, storeId, transactionId, signal),
    staleTime: 5 * 60_000,
    // An open detail keeps working links: they die at 15 minutes
    refetchInterval: 10 * 60_000,
    enabled
  })
}

export const usePostManualFinanceEntry = (
  storeId: string
): Write<ManualFinanceEntryInput, FinanceEntryDetailView> =>
  useFinanceWrite(input => postManualFinanceEntry(apiClient, storeId, input))

export const useReverseFinanceEntry = (
  storeId: string
): Write<{ id: string; memo: string; entryDate?: string }, FinanceEntryDetailView> =>
  useFinanceWrite(input =>
    reverseFinanceEntry(apiClient, storeId, input.id, {
      memo: input.memo,
      ...(input.entryDate === undefined ? {} : { entryDate: input.entryDate })
    })
  )

export const useRecordFinanceTransaction = (
  storeId: string
): Write<RecordFinanceTransactionInput, FinanceTransactionView> =>
  useFinanceWrite(input => recordFinanceTransaction(apiClient, storeId, input))

export const useVoidFinanceTransaction = (
  storeId: string
): Write<{ id: string; reason: string }, FinanceTransactionView> =>
  useFinanceWrite(input => voidFinanceTransaction(apiClient, storeId, input.id, input.reason))

export const useReplaceFinanceTransaction = (
  storeId: string
): Write<
  { id: string; reason: string; replacement: RecordFinanceTransactionInput },
  FinanceTransactionView
> =>
  useFinanceWrite(input =>
    replaceFinanceTransaction(apiClient, storeId, input.id, {
      reason: input.reason,
      replacement: input.replacement
    })
  )

// A receipt for a transaction by the flow of every upload: a signed url, the bytes straight to the bucket, a confirmation with the
// purpose `finance_document` naming the transaction, the wait for the scan (the api only takes a file that was found clean), and then
// the receipt is attached. Leaving the page stops the wait; the transaction is already registered, so a failure here leaves it with no
// receipt and the person tries again from its detail.
export function useFinanceReceiptUpload(
  storeId: string
): Write<{ transactionId: string; file: File }, FinanceTransactionView> {
  const queryClient = useQueryClient()
  const controller = useRef<AbortController>(new AbortController())
  // One signal per mount of the effect: StrictMode mounts, cleans up and mounts again
  useEffect(() => {
    const current = new AbortController()
    controller.current = current
    return () => current.abort()
  }, [])
  return useMutation({
    mutationFn: async ({ transactionId, file }) => {
      const info = { filename: file.name, contentType: file.type, fileSizeBytes: file.size }
      const target = { purpose: MediaPurpose.FINANCE_DOCUMENT, parentId: transactionId } as const
      const { signal } = controller.current
      const signed = await requestUploadUrl(apiClient, storeId, info, target)
      await uploadToUrl(signed.uploadUrl, file, file.type, () => undefined, signal)
      await confirmUpload(
        apiClient,
        storeId,
        { ...info, mediaId: signed.mediaId, key: signed.key },
        target
      )
      await waitUntilClean(() => fetchMediaUrls(apiClient, storeId, signed.mediaId, signal), {
        signal
      })
      return attachFinanceTransactionDocument(apiClient, storeId, transactionId, signed.mediaId)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QueryKeys.finance.root })
  })
}
