import { type Locale, Locales, SOURCE_LOCALE } from '@platform/core/i18n'

// The emails use the message files of the web app (TDD_07 §5.2). A JSON file is not a project to
// import through an alias, so these two lines reach into apps/web/messages on purpose; the rules
// stay on for everything else in the file.
// eslint-disable-next-line no-restricted-imports, @nx/enforce-module-boundaries
import en from '../../../../apps/web/messages/en.json'
// eslint-disable-next-line no-restricted-imports, @nx/enforce-module-boundaries
import es from '../../../../apps/web/messages/es.json'

export type Messages = typeof en

// A locale without a file (pt-BR is declared but not supported yet) reads the source locale
const catalogs: Partial<Record<Locale, Messages>> = {
  [Locales.EN]: en,
  [Locales.ES]: es
}

export function messagesFor(locale: Locale): Messages {
  return catalogs[locale] ?? catalogs[SOURCE_LOCALE] ?? en
}
