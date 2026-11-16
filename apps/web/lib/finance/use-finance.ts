'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type CreateFinanceAccountInput,
  type CreateFinanceTaxRateInput,
  createFinanceAccount,
  createFinanceTaxRate,
  fetchAllFinanceAccounts,
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
  type FinancePaymentAccountView,
  type FinancePeriodView,
  type FinancePostingPageView,
  type FinanceRoleMappingView,
  type FinanceSettingsView,
  type FinanceSetupView,
  type FinanceStoreTaxSettingsView,
  type FinanceTaxRateView,
  mapFinanceAccountRole,
  openFinancePeriod,
  QueryKeys,
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
  updateFinanceTaxRate
} from '@platform/api-client'

import { apiClient } from '../api'

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
