import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'

// The value of the locale cookie, or the default locale when it is missing or not supported
// (a user can edit a cookie, and pt-BR is declared but has no messages yet)
export function resolveLocale(value: string | undefined): Locale {
  return SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE
}
