'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

import { type DsrFormView, fetchDsrForm, makeDsrFormKey, revokeDsrFormKey } from './dsr-form'

export function useDsrForm(storeId: string, enabled: boolean): UseQueryResult<DsrFormView> {
  return useQuery({
    queryKey: QueryKeys.dsrForm.one(storeId),
    queryFn: ({ signal }) => fetchDsrForm(apiClient, storeId, signal),
    enabled
  })
}

export type DsrFormChange = 'make' | 'revoke'

const CHANGERS = { make: makeDsrFormKey, revoke: revokeDsrFormKey } as const

// A change of the key. Whatever the answer (a refusal because someone changed it first too) the key is read again: the screen never keeps
// a key the api has left behind.
export function useDsrFormChange(
  storeId: string,
  change: DsrFormChange
): UseMutationResult<DsrFormView, Error, { current: string | null }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ current }: { current: string | null }) =>
      CHANGERS[change](apiClient, storeId, current),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QueryKeys.dsrForm.one(storeId) })
  })
}
