import { getLocale } from 'next-intl/server'
import type { ReactElement, ReactNode } from 'react'

import { RouteMessages } from '../../components/providers/route-messages'
import { resolveLocale } from '../../lib/locale'

type Messages = Record<string, unknown>

async function routeMessages(name: string, locale: string): Promise<Messages> {
  const loaded = (await import(`../../messages/routes/${name}.${locale}.json`)) as {
    default: Messages
  }
  return loaded.default
}

// The words of the returns screens (`messages/routes/returns.<locale>.json`) and the ones of the order's Returns panel and guide
// dialogs, which the detail of a return reuses (`order-detail.<locale>.json`): loaded with these routes and not with every page
export async function ReturnsLayout({ children }: { children: ReactNode }): Promise<ReactElement> {
  const locale = resolveLocale(await getLocale())
  const [orderDetail, returns] = await Promise.all([
    routeMessages('order-detail', locale),
    routeMessages('returns', locale)
  ])
  return (
    <RouteMessages messages={orderDetail}>
      <RouteMessages messages={returns}>{children}</RouteMessages>
    </RouteMessages>
  )
}
