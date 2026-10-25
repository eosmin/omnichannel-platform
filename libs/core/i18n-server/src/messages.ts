import { type Locale, Locales, SOURCE_LOCALE } from '@platform/core/i18n'

import en from '../messages/en.json'
import es from '../messages/es.json'

export type Messages = typeof en

// A locale without a file (pt-BR is declared but not supported yet) reads the source locale
const catalogs: Partial<Record<Locale, Messages>> = {
  [Locales.EN]: en,
  [Locales.ES]: es
}

export function messagesFor(locale: Locale): Messages {
  return catalogs[locale] ?? catalogs[SOURCE_LOCALE] ?? en
}
