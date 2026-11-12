'use client'

import { NextIntlClientProvider, useLocale, useMessages, useTimeZone } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

type Messages = Record<string, unknown>

const isObject = (value: unknown): value is Messages =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The messages of the app plus those of one route, merged key by key (a nested provider replaces the messages instead of adding)
function merge(base: Messages, extra: Messages): Messages {
  const out: Messages = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key]
    out[key] = isObject(current) && isObject(value) ? merge(current, value) : value
  }
  return out
}

// The messages that only one route reads (`apps/web/messages/routes`) travel with that route and not with every page: the app sends
// its whole message file to the browser on each page, so a screen's own words are kept out of it (the script budget of the pages
// that do not draw the screen). The route's layout reads the file of the locale and hands it here.
export function RouteMessages({
  messages,
  children
}: {
  messages: Messages
  children: ReactNode
}): ReactElement {
  const locale = useLocale()
  const timeZone = useTimeZone()
  const parent = useMessages() as Messages
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone} messages={merge(parent, messages)}>
      {children}
    </NextIntlClientProvider>
  )
}
