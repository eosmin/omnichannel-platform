import { LOCALE_COOKIE } from '@platform/api-client'
import { SUPPORTED_LOCALES } from '@platform/core/i18n'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

// The cookie the server reads to render in a language (i18n/request.ts). Not httpOnly on purpose:
// it is a preference, not a credential, and the page writes it when the person picks a language.
export function localeCookieValue(locale: string): string {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`
}

export function writeLocaleCookie(locale: string): void {
  if (!SUPPORTED_LOCALES.some(item => item === locale)) return
  document.cookie = localeCookieValue(locale)
}

export function hasLocaleCookie(cookieHeader: string): boolean {
  return cookieHeader.split(';').some(part => part.trim().startsWith(`${LOCALE_COOKIE}=`))
}

// A browser with no choice of its own takes the language the person saved in their account; one
// that already has a cookie keeps it, because the person may use another language on this device
export function localeToAdopt(
  cookieHeader: string,
  savedLocale: string,
  shownLocale: string
): string | null {
  if (hasLocaleCookie(cookieHeader)) return null
  if (!SUPPORTED_LOCALES.some(item => item === savedLocale)) return null
  return savedLocale === shownLocale ? null : savedLocale
}
