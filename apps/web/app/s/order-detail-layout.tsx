import { getLocale } from 'next-intl/server'
import type { ReactElement, ReactNode } from 'react'

import { RouteMessages } from '../../components/providers/route-messages'
import { resolveLocale } from '../../lib/locale'

// The words of the Shipping and Returns panels and of the guide dialogs are read by the order detail alone, so they are loaded with
// it (`messages/routes/order-detail.<locale>.json`) and not sent with every page of the app
export async function OrderDetailLayout({
  children
}: {
  children: ReactNode
}): Promise<ReactElement> {
  const locale = resolveLocale(await getLocale())
  const messages = (await import(`../../messages/routes/order-detail.${locale}.json`)) as {
    default: Record<string, unknown>
  }
  return <RouteMessages messages={messages.default}>{children}</RouteMessages>
}
