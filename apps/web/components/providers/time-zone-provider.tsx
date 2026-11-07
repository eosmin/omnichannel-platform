'use client'

import { useQuery } from '@tanstack/react-query'
import { NextIntlClientProvider, useLocale, useMessages, useTimeZone } from 'next-intl'
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react'

import { type AccountProfile, fetchAccountProfile, QueryKeys } from '@platform/api-client'

import { apiClient } from '../../lib/api'
import { displayTimeZone } from '../../lib/time-zone'

// The hours of the app (the time of a bubble, the table of exports) follow the person: the zone of their
// account, else the one of their browser. Without this, next-intl formats with the zone of the web server,
// that nobody chose. The profile is only read from the cache here (`enabled: false`, with the same function as
// `useProfile` so that nothing can run without one): the login and the invitation pages must not ask for it.
// The browser zone is read after the first render, which keeps the zone of the server until then, so what the
// server drew and the first render of the browser are the same.
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
  const accountZone = profile?.timezone
  const timeZone = useMemo(
    () => displayTimeZone(accountZone, browserZone) ?? serverZone,
    [accountZone, browserZone, serverZone]
  )
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  )
}
