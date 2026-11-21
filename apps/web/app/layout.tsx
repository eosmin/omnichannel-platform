import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { PluginWidgetFrames } from '@platform/core/domain'

import { CookieConsentGate } from '../components/cookie-consent/cookie-consent-gate'
import { AppProviders } from '../components/providers/app-providers'
import { DestructiveActionProvider } from '../components/shared/destructive-action'
import { BusyAnnouncer } from '../components/shell/busy-announcer'
import { ToasterHost } from '../components/ui/toaster-host'
import { isSettled } from '../lib/cookie-consent/cookie-settled'
import { parseFrameOrigins } from '../lib/plugin-frames'

import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app')
  // A page names itself and the app follows it (`Canales · Ajustes · Plataforma omnicanal`); without a name of its own the title is the app's
  return { title: { default: t('title'), template: `%s · ${t('title')}` } }
}

export default async function RootLayout({
  children
}: {
  children: ReactNode
}): Promise<ReactNode> {
  const locale = await getLocale()
  // What the proxy let the policy frame for this store: the page reads it to know whether a widget can load here
  const requestHeaders = await headers()
  const frameOrigins = parseFrameOrigins(
    requestHeaders.get(PluginWidgetFrames.ORIGINS_HEADER) ?? undefined,
    []
  ).join(PluginWidgetFrames.COOKIE_SEPARATOR)
  return (
    <html lang={locale}>
      <head>
        <meta name={PluginWidgetFrames.ORIGINS_META_NAME} content={frameOrigins} />
      </head>
      <body>
        <NextIntlClientProvider>
          <AppProviders>
            <DestructiveActionProvider>{children}</DestructiveActionProvider>
          </AppProviders>
          {isSettled(requestHeaders.get('cookie') ?? '') ? null : <CookieConsentGate />}
          <ToasterHost />
          <BusyAnnouncer />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
