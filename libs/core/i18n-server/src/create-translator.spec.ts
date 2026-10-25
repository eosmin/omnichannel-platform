import { Locales } from '@platform/core/i18n'

import { createTranslator } from './create-translator'
import { messagesFor } from './messages'

describe('createTranslator', () => {
  it('reads a key of the namespace in the locale', () => {
    expect(createTranslator(Locales.EN, 'email.magicLink')('cta')).toBe('Sign in')
    expect(createTranslator(Locales.ES, 'email.magicLink')('cta')).toBe('Iniciar sesión')
  })

  it('fills the parameters', () => {
    expect(createTranslator(Locales.EN, 'email.magicLink')('expiry', { minutes: 15 })).toBe(
      'This link expires in 15 minutes.'
    )
  })

  it('throws on a missing key or parameter, instead of sending a broken email', () => {
    const t = createTranslator(Locales.EN, 'email.magicLink')
    expect(() => t('nope')).toThrow(/missing translation email.magicLink.nope/)
    expect(() => t('expiry')).toThrow(/missing parameter minutes/)
  })

  it('falls back to the source locale for a locale without messages', () => {
    expect(createTranslator(Locales.PT_BR, 'email.magicLink')('cta')).toBe('Sign in')
  })
})

describe('message files', () => {
  it('have the same keys in every supported locale', () => {
    const keys = (value: unknown, prefix = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
        : [prefix]
    expect(keys(messagesFor(Locales.ES)).sort()).toEqual(keys(messagesFor(Locales.EN)).sort())
  })
})
