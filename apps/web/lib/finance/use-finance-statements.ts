'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  fetchFinanceAging,
  fetchFinanceAgingCsv,
  fetchFinanceBalanceSheet,
  fetchFinanceBalanceSheetCsv,
  fetchFinanceBook,
  fetchFinanceBookCsv,
  fetchFinanceBookLayouts,
  fetchFinanceCashFlow,
  fetchFinanceCashFlowCsv,
  fetchFinanceFrozenBook,
  fetchFinanceFrozenBooks,
  fetchFinanceIncomeStatement,
  fetchFinanceIncomeStatementCsv,
  type FinanceAgingQuery,
  type FinanceAgingView,
  type FinanceBalanceSheetQuery,
  type FinanceBalanceSheetView,
  type FinanceBookLayoutView,
  type FinanceBookQuery,
  type FinanceBookView,
  type FinanceCashFlowView,
  type FinanceFlowQuery,
  type FinanceFrozenBookView,
  type FinanceIncomeStatementView,
  QueryKeys
} from '@platform/api-client'

import { apiClient } from '../api'

// The statements, the lists with age and the legal books (Step 4B.9b-3). A report is read when its form holds a valid question (`null`
// reads nothing) and never in the background: it is a statement of the books as they are when it is asked, and a person who wants it
// again asks again. A file is a mutation, because it is an action of the person and leaves an audit row at the api.
// staleTime 0 and no keeping: opening a report again asks the api again, and a person who presses Show again gets a new read (the panels
// call `refetch` when the question is the same one)
const NO_REFETCH = { refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 } as const

export function useFinanceIncomeStatement(
  storeId: string,
  query: FinanceFlowQuery | null
): UseQueryResult<FinanceIncomeStatementView> {
  return useQuery({
    queryKey: QueryKeys.finance.incomeStatement(storeId, query?.from ?? '', query?.to ?? ''),
    queryFn: ({ signal }) =>
      fetchFinanceIncomeStatement(apiClient, storeId, query as FinanceFlowQuery, signal),
    enabled: query !== null,
    ...NO_REFETCH
  })
}

export function useFinanceBalanceSheet(
  storeId: string,
  query: FinanceBalanceSheetQuery | null
): UseQueryResult<FinanceBalanceSheetView> {
  return useQuery({
    queryKey: QueryKeys.finance.balanceSheet(storeId, query?.asOf ?? ''),
    queryFn: ({ signal }) =>
      fetchFinanceBalanceSheet(apiClient, storeId, query as FinanceBalanceSheetQuery, signal),
    enabled: query !== null,
    ...NO_REFETCH
  })
}

export function useFinanceCashFlow(
  storeId: string,
  query: FinanceFlowQuery | null
): UseQueryResult<FinanceCashFlowView> {
  return useQuery({
    queryKey: QueryKeys.finance.cashFlow(storeId, query?.from ?? '', query?.to ?? ''),
    queryFn: ({ signal }) =>
      fetchFinanceCashFlow(apiClient, storeId, query as FinanceFlowQuery, signal),
    enabled: query !== null,
    ...NO_REFETCH
  })
}

export function useFinanceAging(
  storeId: string,
  query: FinanceAgingQuery | null
): UseQueryResult<FinanceAgingView> {
  return useQuery({
    queryKey: QueryKeys.finance.aging(storeId, query?.kind ?? '', query?.asOf ?? ''),
    queryFn: ({ signal }) =>
      fetchFinanceAging(apiClient, storeId, query as FinanceAgingQuery, signal),
    enabled: query !== null,
    ...NO_REFETCH
  })
}

export const useDownloadIncomeStatementCsv = (
  storeId: string
): UseMutationResult<string, Error, FinanceFlowQuery> =>
  useMutation({ mutationFn: query => fetchFinanceIncomeStatementCsv(apiClient, storeId, query) })

export const useDownloadBalanceSheetCsv = (
  storeId: string
): UseMutationResult<string, Error, FinanceBalanceSheetQuery> =>
  useMutation({ mutationFn: query => fetchFinanceBalanceSheetCsv(apiClient, storeId, query) })

export const useDownloadCashFlowCsv = (
  storeId: string
): UseMutationResult<string, Error, FinanceFlowQuery> =>
  useMutation({ mutationFn: query => fetchFinanceCashFlowCsv(apiClient, storeId, query) })

export const useDownloadAgingCsv = (
  storeId: string
): UseMutationResult<string, Error, FinanceAgingQuery> =>
  useMutation({ mutationFn: query => fetchFinanceAgingCsv(apiClient, storeId, query) })

export function useFinanceBookLayouts(
  storeId: string,
  enabled: boolean
): UseQueryResult<FinanceBookLayoutView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.bookLayouts(storeId),
    queryFn: ({ signal }) => fetchFinanceBookLayouts(apiClient, storeId, signal),
    // Never served from an older read: the layouts say which columns are money, and a book of a new version needs the new list
    staleTime: 0,
    enabled
  })
}

export function useFinanceBook(
  storeId: string,
  query: FinanceBookQuery | null
): UseQueryResult<FinanceBookView> {
  return useQuery({
    queryKey: QueryKeys.finance.book(storeId, query?.kind ?? '', query?.periodId ?? ''),
    queryFn: ({ signal }) =>
      fetchFinanceBook(apiClient, storeId, query as FinanceBookQuery, signal),
    enabled: query !== null,
    ...NO_REFETCH
  })
}

export const useDownloadBookCsv = (
  storeId: string
): UseMutationResult<string, Error, FinanceBookQuery> =>
  useMutation({ mutationFn: query => fetchFinanceBookCsv(apiClient, storeId, query) })

export function useFinanceFrozenBooks(
  storeId: string,
  periodId: string
): UseQueryResult<FinanceFrozenBookView[]> {
  return useQuery({
    queryKey: QueryKeys.finance.frozenBooks(storeId, periodId),
    queryFn: ({ signal }) => fetchFinanceFrozenBooks(apiClient, storeId, periodId, signal),
    ...NO_REFETCH
  })
}

export function useFinanceFrozenBook(
  storeId: string,
  id: string | null
): UseQueryResult<FinanceBookView> {
  return useQuery({
    queryKey: QueryKeys.finance.frozenBook(storeId, id ?? ''),
    queryFn: ({ signal }) => fetchFinanceFrozenBook(apiClient, storeId, id as string, signal),
    enabled: id !== null,
    ...NO_REFETCH
  })
}
