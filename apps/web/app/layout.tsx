import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { AppProviders } from '../components/providers/app-providers'
import { DestructiveActionProvider } from '../components/shared/destructive-action'
import { Toaster } from '../components/ui/sonner'

import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app')
  return { title: t('title') }
}

export default async function RootLayout({
  children
}: {
  children: ReactNode
}): Promise<ReactNode> {
  const locale = await getLocale()
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <AppProviders>
            <DestructiveActionProvider>{children}</DestructiveActionProvider>
          </AppProviders>
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
