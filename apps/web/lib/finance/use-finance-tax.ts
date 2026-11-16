'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  fetchFinanceChainStatus,
  fetchFinanceMargin,
  fetchFinanceMarginCsv,
  fetchFinanceVat,
  fetchFinanceVatCsv,
  type FinanceChainStatusView,
  type FinanceMarginView,
  type FinanceRangeQuery,
  type FinanceVatView,
  QueryKeys
} from '@platform/api-client'

import { apiClient } from '../api'

// The VAT report, the margin and the state of the weekly check of the chain (Step 4B.9b-4a). A report is read when its form holds a valid
// question and never in the background, like the statements: it is the books as they are when it is asked. The files are mutations.
const NO_REFETCH = { refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 } as const

export function useFinanceVat(
  storeId: string,
  query: FinanceRangeQuery | null
): UseQueryResult<FinanceVatView> {
  return useQuery({
    queryKey: QueryKeys.finance.vatReport(storeId, query?.from ?? '', query?.to ?? ''),
    queryFn: ({ signal }) =>
      fetchFinanceVat(apiClient, storeId, query as FinanceRangeQuery, signal),
    enabled: query !== null,
    ...NO_REFETCH
  })
}

export function useFinanceMargin(
  storeId: string,
  query: FinanceRangeQuery | null
): UseQueryResult<FinanceMarginView> {
  return useQuery({
    queryKey: QueryKeys.finance.marginReport(storeId, query?.from ?? '', query?.to ?? ''),
    queryFn: ({ signal }) =>
      fetchFinanceMargin(apiClient, storeId, query as FinanceRangeQuery, signal),
    enabled: query !== null,
    ...NO_REFETCH
  })
}

export const useDownloadVatCsv = (
  storeId: string
): UseMutationResult<string, Error, FinanceRangeQuery> =>
  useMutation({ mutationFn: query => fetchFinanceVatCsv(apiClient, storeId, query) })

export const useDownloadMarginCsv = (
  storeId: string
): UseMutationResult<string, Error, FinanceRangeQuery> =>
  useMutation({ mutationFn: query => fetchFinanceMarginCsv(apiClient, storeId, query) })

// The incident the weekly check left open: it is read when the page opens (it reads one row, not the journal). A close or a new check
// makes the whole `finance` root stale, so this one reads again with the rest.
export function useFinanceChainStatus(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceChainStatusView> {
  return useQuery({
    queryKey: QueryKeys.finance.chainStatus(storeId),
    queryFn: ({ signal }) => fetchFinanceChainStatus(apiClient, storeId, signal),
    enabled
  })
}
