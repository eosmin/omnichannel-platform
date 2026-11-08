'use client'

import { useQuery } from '@tanstack/react-query'
import { NextIntlClientProvider, useLocale, useMessages, useTimeZone } from 'next-intl'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'

import { type AccountProfile, fetchAccountProfile, QueryKeys } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { apiClient } from '../../lib/api'
import { useInboxBehavior } from '../../lib/inbox/use-inbox-data'
import { displayTimeZone } from '../../lib/time-zone'

import { useStore } from './store-context'

// The hours of the app (the time of a bubble, the table of exports) follow the person: the zone of their
// account, else the one of their browser. Without this, next-intl formats with the zone of the web server,
// that nobody chose. The profile is only read from the cache here (`enabled: false`, with the same function as
// `useProfile` so that nothing can run without one): the login and the invitation pages must not ask for it.
// The browser zone is read after the first render, which keeps the zone of the server until then, so what the
// server drew and the first render of the browser are the same.
// The store the person is working in says its zone through this (see `StoreTimeZone`); outside a store
// there is nobody to say it
const ReportStoreZone = createContext<(zone: string | undefined) => void>(() => undefined)

export function TimeZoneProvider({ children }: { children: ReactNode }): ReactElement {
  const locale = useLocale()
  const messages = useMessages()
  const serverZone = useTimeZone()
  const { data: profile } = useQuery<AccountProfile>({
    queryKey: QueryKeys.session,
    queryFn: ({ signal }) => fetchAccountProfile(apiClient, signal),
    enabled: false
  })
  const [browserZone, setBrowserZone] = useState<string | undefined>(undefined)
  useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  }, [])
  const [storeZone, setStoreZone] = useState<string | undefined>(undefined)
  const accountZone = profile?.timezone
  const timeZone = useMemo(
    () => displayTimeZone(accountZone, browserZone, storeZone) ?? serverZone,
    [accountZone, browserZone, storeZone, serverZone]
  )
  return (
    <ReportStoreZone.Provider value={setStoreZone}>
      <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
        {children}
      </NextIntlClientProvider>
    </ReportStoreZone.Provider>
  )
}

// Inside a store: its zone is the one the hours follow when the person chose none in their account, the same
// zone the snooze counts in, so that one setting moves every hour on the screen. Renders nothing.
export function StoreTimeZone(): null {
  const report = useContext(ReportStoreZone)
  const { storeId, can } = useStore()
  // Read with the permission of the inbox, as the snooze does; without it the zone of the browser stays
  const zone = useInboxBehavior(storeId, can(ClientPermissions.CONVERSATIONS_VIEW)).data?.timezone
  // Said when known, and taken back only when the store is left: a zone that is being read again (another
  // store, a save) keeps the last one instead of falling to the browser zone for a moment
  useEffect(() => {
    if (zone !== undefined) report(zone)
  }, [report, zone])
  useEffect(() => () => report(undefined), [report])
  return null
}
