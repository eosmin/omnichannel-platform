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
  createRemittanceImportProfile,
  deleteRemittanceImportProfile,
  fetchRemittanceImportProfiles,
  importRemittanceFile,
  type ImportPreviewView,
  previewRemittanceImport,
  QueryKeys,
  type RemittanceDetailView,
  type RemittanceImportProfileView,
  updateRemittanceImportProfile
} from '@platform/api-client'
import type {
  RemittanceImportPreviewBody,
  RemittanceImportProfileBody
} from '@platform/core/domain'

import { apiClient } from '../api'

// The hooks of the import mapper. Only that screen loads this file.

export function useImportProfiles(
  storeId: string,
  connectionId: string | null,
  enabled: boolean
): UseQueryResult<RemittanceImportProfileView[]> {
  return useQuery({
    queryKey: QueryKeys.remittances.profiles(storeId, connectionId),
    queryFn: ({ signal }) =>
      fetchRemittanceImportProfiles(apiClient, storeId, connectionId ?? undefined, signal),
    enabled: enabled && connectionId !== null
  })
}

// The mapper's preview: nothing is written. The rows of the earlier mapping stay on the screen (flagged as stale by the caller)
// until the answer for the new one arrives.
export function useImportPreview(
  storeId: string,
  request: RemittanceImportPreviewBody | null
): UseQueryResult<ImportPreviewView> {
  return useQuery({
    queryKey: QueryKeys.remittances.preview(storeId, request ?? {}),
    queryFn: ({ signal }) =>
      previewRemittanceImport(apiClient, storeId, request as RemittanceImportPreviewBody, signal),
    enabled: request !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: Infinity
  })
}

export interface SaveProfileInput {
  // Set to change the profile that exists; unset makes a new one for the connection
  profileId: string | null
  connectionId: string
  name: string
  profile: RemittanceImportProfileBody
}

export function useSaveImportProfile(
  storeId: string
): UseMutationResult<RemittanceImportProfileView, Error, SaveProfileInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: input =>
      input.profileId === null
        ? createRemittanceImportProfile(apiClient, storeId, {
            connectionId: input.connectionId,
            name: input.name,
            ...input.profile
          })
        : updateRemittanceImportProfile(apiClient, storeId, input.profileId, {
            name: input.name,
            ...input.profile
          }),
    onSuccess: (saved, input) => {
      // The saved profile is in the list before the screen selects it (the refetch that follows would arrive after it), so a
      // second press of Save changes this profile and does not make another
      queryClient.setQueryData<RemittanceImportProfileView[]>(
        QueryKeys.remittances.profiles(storeId, input.connectionId),
        current => [...(current ?? []).filter(entry => entry.id !== saved.id), saved]
      )
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.remittances.all(storeId),
        predicate: query => query.queryKey[2] === 'profiles'
      })
    }
  })
}

export function useDeleteImportProfile(storeId: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: id => deleteRemittanceImportProfile(apiClient, storeId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.remittances.all(storeId),
        predicate: query => query.queryKey[2] === 'profiles'
      })
    }
  })
}

export interface ImportFileInput {
  connectionId: string
  profileId: string
  text: string
  contentType: string
}

// The file becomes a draft: it is in the lists now, and what is pending is unchanged until it is confirmed
export function useImportRemittanceFile(
  storeId: string
): UseMutationResult<RemittanceDetailView, Error, ImportFileInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: input => importRemittanceFile(apiClient, storeId, input),
    onSuccess: remittance => {
      queryClient.setQueryData(QueryKeys.remittances.detail(storeId, remittance.id), remittance)
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.remittances.all(storeId),
        predicate: query => query.queryKey[2] === 'list'
      })
    }
  })
}
