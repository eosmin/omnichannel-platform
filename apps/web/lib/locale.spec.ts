import { DEFAULT_LOCALE, Locales } from '@platform/core/i18n'

import { resolveLocale } from './locale'

describe('resolveLocale', () => {
  it('keeps a supported locale', () => {
    expect(resolveLocale(Locales.EN)).toBe(Locales.EN)
    expect(resolveLocale(Locales.ES)).toBe(Locales.ES)
  })

  it('falls back to the default for a missing, unknown or unsupported value', () => {
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE)
    expect(resolveLocale('fr')).toBe(DEFAULT_LOCALE)
    expect(resolveLocale(Locales.PT_BR)).toBe(DEFAULT_LOCALE)
  })
})
