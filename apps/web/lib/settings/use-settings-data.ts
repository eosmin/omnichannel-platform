'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'
import { useRef } from 'react'

import {
  type AccountPreferences,
  type AccountPreferencesPatch,
  type ActiveSession,
  confirmAvatarUpload,
  type CreateStoreInput,
  createOrganizationStore,
  deleteOrganizationStore,
  fetchAccountPreferences,
  fetchActiveSessions,
  fetchOrganization,
  fetchOrganizationStore,
  fetchOrganizationStores,
  fetchOwnProfile,
  type OrganizationView,
  type OwnProfile,
  type ProfilePatch,
  QueryKeys,
  removeAvatar,
  renameOrganization,
  requestAvatarUploadUrl,
  revokeSession,
  type StorePatch,
  type StoreView,
  updateAccountPreferences,
  updateOrganizationStore,
  updateOwnProfile
} from '@platform/api-client'

import { apiClient } from '../api'
import { uploadToUrl } from '../media/upload-to-url'

// The person's own account ------------------------------------------------------------------

// A picture that has an id and no link is still being scanned and re-encoded: the profile is asked
// again until it has one (or the scan refuses it and the id goes), for a minute or two at most
export const AVATAR_POLL_INTERVAL_MS = 2000
const AVATAR_POLL_MAX_MS = 120_000

export function useOwnProfile(): UseQueryResult<OwnProfile> {
  // When the picture was first seen unfinished: the cap is time, not a count of updates (a save or a
  // refocus also updates the query)
  const since = useRef<number | null>(null)
  return useQuery({
    queryKey: QueryKeys.account.profile,
    queryFn: ({ signal }) => fetchOwnProfile(apiClient, signal),
    refetchInterval: query => {
      const profile = query.state.data
      const processing =
        profile !== undefined && profile.avatarMediaId !== null && profile.avatarUrl === null
      if (!processing) {
        since.current = null
        return false
      }
      since.current ??= Date.now()
      return Date.now() - since.current < AVATAR_POLL_MAX_MS ? AVATAR_POLL_INTERVAL_MS : false
    }
  })
}

// The name is also in the profile of the session (the top bar), so both are refreshed
export function useSaveOwnProfile(): UseMutationResult<OwnProfile, Error, ProfilePatch> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: ProfilePatch) => updateOwnProfile(apiClient, patch),
    onSuccess: saved => {
      queryClient.setQueryData(QueryKeys.account.profile, saved)
      void queryClient.invalidateQueries({ queryKey: QueryKeys.session })
    }
  })
}

export function useAccountPreferences(): UseQueryResult<AccountPreferences> {
  return useQuery({
    queryKey: QueryKeys.account.preferences,
    queryFn: ({ signal }) => fetchAccountPreferences(apiClient, signal)
  })
}

export function useSaveAccountPreferences(): UseMutationResult<
  AccountPreferences,
  Error,
  AccountPreferencesPatch
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: AccountPreferencesPatch) => updateAccountPreferences(apiClient, patch),
    onSuccess: saved => {
      queryClient.setQueryData(QueryKeys.account.preferences, saved)
      void queryClient.invalidateQueries({ queryKey: QueryKeys.session })
    }
  })
}

export function useActiveSessions(): UseQueryResult<ActiveSession[]> {
  return useQuery({
    queryKey: QueryKeys.account.sessions,
    queryFn: ({ signal }) => fetchActiveSessions(apiClient, signal)
  })
}

export function useRevokeSession(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => revokeSession(apiClient, sessionId),
    // Also on failure: a session another tab already closed is a 404 and must leave the list
    onSettled: () => queryClient.invalidateQueries({ queryKey: QueryKeys.account.sessions })
  })
}

// The organization and its stores ------------------------------------------------------------
// `storeId` is the store the request goes through (the api reads the organization from it)

export function useOrganization(storeId: string): UseQueryResult<OrganizationView> {
  return useQuery({
    queryKey: QueryKeys.organizations.current(storeId),
    queryFn: ({ signal }) => fetchOrganization(apiClient, storeId, signal)
  })
}

export function useRenameOrganization(
  storeId: string
): UseMutationResult<OrganizationView, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => renameOrganization(apiClient, storeId, name),
    onSuccess: saved => {
      queryClient.setQueryData(QueryKeys.organizations.current(storeId), saved)
    }
  })
}

export function useOrganizationStores(
  storeId: string,
  enabled = true
): UseQueryResult<StoreView[]> {
  return useQuery({
    queryKey: QueryKeys.organizations.stores(storeId),
    queryFn: ({ signal }) => fetchOrganizationStores(apiClient, storeId, signal),
    enabled
  })
}

export function useOrganizationStore(storeId: string, id: string): UseQueryResult<StoreView> {
  return useQuery({
    queryKey: QueryKeys.organizations.store(storeId, id),
    queryFn: ({ signal }) => fetchOrganizationStore(apiClient, storeId, id, signal)
  })
}

// A store that is created, renamed or deleted changes the list, the page of that store and the
// memberships of the session (the switcher and the name in the top bar)
function useRefreshStores(storeId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: QueryKeys.organizations.all(storeId) })
    void queryClient.invalidateQueries({ queryKey: QueryKeys.session })
  }
}

export function useCreateStore(
  storeId: string
): UseMutationResult<StoreView, Error, CreateStoreInput> {
  const refresh = useRefreshStores(storeId)
  return useMutation({
    mutationFn: (input: CreateStoreInput) => createOrganizationStore(apiClient, storeId, input),
    onSuccess: refresh
  })
}

export function useUpdateStore(
  storeId: string,
  id: string
): UseMutationResult<StoreView, Error, StorePatch> {
  const refresh = useRefreshStores(storeId)
  return useMutation({
    mutationFn: (patch: StorePatch) => updateOrganizationStore(apiClient, storeId, id, patch),
    onSuccess: refresh
  })
}

export function useDeleteStore(storeId: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  const refresh = useRefreshStores(storeId)
  return useMutation({
    mutationFn: (id: string) => deleteOrganizationStore(apiClient, storeId, id),
    onSuccess: async (_, id) => {
      if (id !== storeId) {
        refresh()
        return
      }
      // The request goes through this very store: once it is gone every read of it is refused. The
      // memberships of the session are read first, so that the area moves to another store before
      // anything is read through the dead one, and only then are its cached reads dropped.
      await queryClient.invalidateQueries({ queryKey: QueryKeys.session })
      queryClient.removeQueries({ queryKey: QueryKeys.organizations.all(storeId) })
    }
  })
}

// The picture: the three steps of an upload on the routes of the account, then the change of the
// profile that makes it the person's picture. Nothing here knows a store.
export function useUploadAvatar(): UseMutationResult<OwnProfile, Error, File> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      const info = { filename: file.name, contentType: file.type, fileSizeBytes: file.size }
      const target = await requestAvatarUploadUrl(apiClient, info)
      await uploadToUrl(
        target.uploadUrl,
        file,
        file.type,
        () => undefined,
        new AbortController().signal
      )
      const confirmed = await confirmAvatarUpload(apiClient, {
        ...info,
        mediaId: target.mediaId,
        key: target.key
      })
      return updateOwnProfile(apiClient, { avatarMediaId: confirmed.mediaId })
    },
    onSuccess: saved => {
      queryClient.setQueryData(QueryKeys.account.profile, saved)
      void queryClient.invalidateQueries({ queryKey: QueryKeys.session })
    }
  })
}

export function useRemoveAvatar(): UseMutationResult<OwnProfile, Error, void> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => removeAvatar(apiClient),
    onSuccess: saved => {
      queryClient.setQueryData(QueryKeys.account.profile, saved)
      void queryClient.invalidateQueries({ queryKey: QueryKeys.session })
    }
  })
}
