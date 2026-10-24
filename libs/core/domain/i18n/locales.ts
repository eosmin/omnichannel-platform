export const Locales = {
  ES: 'es',
  EN: 'en',
  PT_BR: 'pt-BR'
} as const

export type Locale = (typeof Locales)[keyof typeof Locales]

export const DEFAULT_LOCALE: Locale = Locales.ES
export const SUPPORTED_LOCALES: readonly Locale[] = [Locales.ES, Locales.EN]
export const SOURCE_LOCALE: Locale = Locales.EN // Message files are authored in English

export const LocaleLabels: Record<Locale, string> = {
  [Locales.ES]: 'Español',
  [Locales.EN]: 'English',
  [Locales.PT_BR]: 'Português (Brasil)'
}
