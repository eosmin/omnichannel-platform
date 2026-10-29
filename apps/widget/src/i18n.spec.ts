import { resolveLocale, textFor } from './i18n'

describe('resolveLocale', () => {
  it('prefers the language of the snippet, then the store, then the browser', () => {
    expect(resolveLocale('en', 'es', 'es-MX')).toBe('en')
    expect(resolveLocale(null, 'en', 'es-MX')).toBe('en')
    expect(resolveLocale(null, 'pt-BR', 'en-US')).toBe('en')
  })

  it('reads a region as its language, in any case', () => {
    expect(resolveLocale('EN-gb')).toBe('en')
    expect(resolveLocale('es-MX')).toBe('es')
  })

  it('skips what the widget does not speak and falls back to Spanish', () => {
    expect(resolveLocale('fr', 'pt-BR', undefined)).toBe('es')
    expect(resolveLocale()).toBe('es')
  })

  it('has the same words in both languages', () => {
    expect(Object.keys(textFor('en')).sort()).toEqual(Object.keys(textFor('es')).sort())
  })
})
