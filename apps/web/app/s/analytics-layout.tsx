import { getLocale } from 'next-intl/server'
import type { ReactElement, ReactNode } from 'react'

import { RouteMessages } from '../../components/providers/route-messages'
import { resolveLocale } from '../../lib/locale'

type Messages = Record<string, unknown>

// The words of the dashboard (`messages/routes/analytics.<locale>.json`) travel with this route and not with every page
export async function AnalyticsLayout({
  children
}: {
  children: ReactNode
}): Promise<ReactElement> {
  const locale = resolveLocale(await getLocale())
  const loaded = (await import(`../../messages/routes/analytics.${locale}.json`)) as {
    default: Messages
  }
  return <RouteMessages messages={loaded.default}>{children}</RouteMessages>
}
