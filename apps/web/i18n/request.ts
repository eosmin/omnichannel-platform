import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

import { LOCALE_COOKIE } from '@platform/api-client'

import { resolveLocale } from '../lib/locale'

export default getRequestConfig(async () => {
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value)
  const messages = (await import(`../messages/${locale}.json`)) as {
    default: Record<string, unknown>
  }
  return { locale, messages: messages.default }
})
