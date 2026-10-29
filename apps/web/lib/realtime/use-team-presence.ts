'use client'

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { fetchTeamPresence, QueryKeys, type UserPresenceView } from '@platform/api-client'

import { apiClient } from '../api'

// Who of the team is online or away. It is read once and kept current by the user.online and
// user.offline events, which make the query stale (see invalidation.ts). Needs CONVERSATIONS_VIEW.
export function useTeamPresence(storeId: string): UseQueryResult<UserPresenceView[]> {
  return useQuery({
    queryKey: QueryKeys.presence.team(storeId),
    queryFn: ({ signal }) => fetchTeamPresence(apiClient, storeId, signal)
  })
}
