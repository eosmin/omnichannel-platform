'use client'

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { type AccountProfile, fetchAccountProfile, QueryKeys } from '@platform/api-client'

import { apiClient } from './api'

// Who is signed in and what they may do in each store. One query for the whole app: the first use
// also trades the cookie for an access token.
export function useProfile(): UseQueryResult<AccountProfile> {
  return useQuery({
    queryKey: QueryKeys.session,
    queryFn: ({ signal }) => fetchAccountProfile(apiClient, signal)
  })
}
