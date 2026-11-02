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
  confirmAvatarUpload,
  fetchOwnProfile,
  type OwnProfile,
  QueryKeys,
  removeAvatar,
  requestAvatarUploadUrl,
  updateOwnProfile
} from '@platform/api-client'

import { apiClient } from '../api'
import { uploadToUrl } from '../media/upload-to-url'

// The picture of the person. Kept apart from `use-settings-data`, which the app frame loads on every
// screen: only Account → Profile needs these.

// A picture that has an id and no link is still being scanned and re-encoded: the profile is asked
// again until it has one (or the scan refuses it and the id goes), for two minutes at most
export const AVATAR_POLL_INTERVAL_MS = 2000
const AVATAR_POLL_MAX_MS = 120_000

// The profile of `use-settings-data`, same key, that keeps asking while the picture is not ready
export function useOwnProfileWithPicture(): UseQueryResult<OwnProfile> {
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

// The three steps of an upload on the routes of the account, then the change of the profile that makes
// it the person's picture. Nothing here knows a store.
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
