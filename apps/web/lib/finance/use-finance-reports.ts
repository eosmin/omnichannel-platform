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

import {
  closeFinancePeriod,
  fetchFinanceJournalCsv,
  fetchFinanceLedger,
  fetchFinanceLedgerCsv,
  fetchFinanceTrialBalance,
  fetchFinanceTrialBalanceCsv,
  type FinanceChainVerificationView,
  type FinanceLedgerView,
  type FinancePeriodView,
  type FinanceTrialBalanceView,
  QueryKeys,
  reopenFinancePeriod,
  verifyFinanceChain
} from '@platform/api-client'

import { apiClient } from '../api'

// The hooks of the close and the reports (Step 4B.9b-1). Closing and reopening change what every report says, so they make the whole
// `finance` root stale, like every write of the books; a file or a check changes nothing on screen and leaves the cache alone.

export function useFinanceTrialBalance(
  storeId: string,
  periodId: string | null,
  enabled: boolean
): UseQueryResult<FinanceTrialBalanceView> {
  return useQuery({
    queryKey: QueryKeys.finance.trialBalance(storeId, periodId ?? ''),
    queryFn: ({ signal }) => fetchFinanceTrialBalance(apiClient, storeId, periodId ?? '', signal),
    enabled: enabled && periodId !== null
  })
}

export interface LedgerRange {
  accountId: string
  from: string | null
  to: string | null
}

// The pages of the ledger of one account follow the position the api names; the first one carries the opening balance
export function useFinanceLedger(
  storeId: string,
  range: LedgerRange | null,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<FinanceLedgerView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.finance.ledger(
      storeId,
      range?.accountId ?? '',
      range?.from ?? '',
      range?.to ?? ''
    ),
    queryFn: ({ pageParam, signal }) =>
      fetchFinanceLedger(
        apiClient,
        storeId,
        {
          accountId: range?.accountId ?? '',
          from: range?.from ?? null,
          to: range?.to ?? null,
          cursor: pageParam
        },
        signal
      ),
    initialPageParam: null as string | null,
    getNextPageParam: page => (page.hasMore ? page.nextCursor : undefined),
    enabled: enabled && range !== null
  })
}

type Write<TInput, TResult> = UseMutationResult<TResult, Error, TInput>

function useFinanceWrite<TInput, TResult>(
  write: (input: TInput) => Promise<TResult>
): Write<TInput, TResult> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: write,
    // Returned, so the mutation settles after the reports have been read again: a dialog closes on fresh data, not on the old
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QueryKeys.finance.root })
  })
}

export const useCloseFinancePeriod = (storeId: string): Write<string, FinancePeriodView> =>
  useFinanceWrite(periodId => closeFinancePeriod(apiClient, storeId, periodId))

export const useReopenFinancePeriod = (
  storeId: string
): Write<{ periodId: string; reason: string }, FinancePeriodView> =>
  useFinanceWrite(input =>
    reopenFinancePeriod(apiClient, storeId, input.periodId, { reason: input.reason })
  )

// The check of the chain is a POST that reads: it leaves an audit row and no change the screen has to read again
export const useVerifyFinanceChain = (
  storeId: string
): UseMutationResult<FinanceChainVerificationView, Error, void> =>
  useMutation({ mutationFn: () => verifyFinanceChain(apiClient, storeId) })

export const useDownloadTrialBalanceCsv = (
  storeId: string
): UseMutationResult<string, Error, string> =>
  useMutation({ mutationFn: periodId => fetchFinanceTrialBalanceCsv(apiClient, storeId, periodId) })

export const useDownloadLedgerCsv = (
  storeId: string
): UseMutationResult<string, Error, { accountId: string; from: string; to: string }> =>
  useMutation({ mutationFn: input => fetchFinanceLedgerCsv(apiClient, storeId, input) })

export const useDownloadJournalCsv = (
  storeId: string
): UseMutationResult<string, Error, { from: string; to: string }> =>
  useMutation({ mutationFn: input => fetchFinanceJournalCsv(apiClient, storeId, input) })
