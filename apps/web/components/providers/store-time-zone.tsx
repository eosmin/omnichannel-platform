'use client'

import { useQuery } from '@tanstack/react-query'
import { useContext, useEffect } from 'react'

import { fetchInboxBehavior, type InboxBehaviorView, QueryKeys } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { apiClient } from '../../lib/api'

import { useStore } from './store-context'
import { ReportStoreZone } from './time-zone-provider'

// Its own file, not part of the provider: the provider is in the root layout of every page (the login included), and this reads the inbox
// behavior of a store, which only the pages of a store need. The read is the one `useInboxBehavior` makes (same key, same function), written
// here so that the root chunk does not carry the module of the inbox hooks.
// Inside a store: its zone is the one the hours follow when the person chose none in their account, the same
// zone the snooze counts in, so that one setting moves every hour on the screen. Renders nothing.
export function StoreTimeZone(): null {
  const report = useContext(ReportStoreZone)
  const { storeId, can } = useStore()
  // Read with the permission of the inbox, as the snooze does; without it the zone of the browser stays
  const zone = useQuery<InboxBehaviorView>({
    queryKey: QueryKeys.inboxBehavior.store(storeId),
    queryFn: ({ signal }) => fetchInboxBehavior(apiClient, storeId, signal),
    enabled: can(ClientPermissions.CONVERSATIONS_VIEW)
  }).data?.timezone
  // Said when known, and taken back only when the store is left: a zone that is being read again (another
  // store, a save) keeps the last one instead of falling to the browser zone for a moment
  useEffect(() => {
    if (zone !== undefined) report(zone)
  }, [report, zone])
  useEffect(() => () => report(undefined), [report])
  return null
}
