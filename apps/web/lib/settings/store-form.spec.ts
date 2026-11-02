import {
  hasChanges,
  storeFormProblems,
  StoreFormErrors,
  storePatchOf,
  withCurrent
} from './store-form'

const BASE = {
  name: 'Main Store',
  timezone: 'America/El_Salvador',
  currency: 'USD',
  defaultLocale: 'es'
}

describe('store form', () => {
  it('accepts the values of a store', () => {
    expect(storeFormProblems(BASE)).toEqual({})
  })

  it('refuses an empty name, a name over 100 characters, a bad currency and an unknown locale', () => {
    expect(storeFormProblems({ ...BASE, name: '   ' }).name).toBe(StoreFormErrors.NAME_REQUIRED)
    expect(storeFormProblems({ ...BASE, name: 'x'.repeat(101) }).name).toBe(
      StoreFormErrors.NAME_TOO_LONG
    )
    expect(storeFormProblems({ ...BASE, currency: 'usd' }).currency).toBe(
      StoreFormErrors.CURRENCY_INVALID
    )
    expect(storeFormProblems({ ...BASE, defaultLocale: 'fr' }).defaultLocale).toBe(
      StoreFormErrors.LOCALE_INVALID
    )
  })

  it('sends only what changed, with the name trimmed', () => {
    expect(storePatchOf(BASE, { ...BASE, name: '  Shop  ', currency: 'EUR' })).toEqual({
      name: 'Shop',
      currency: 'EUR'
    })
  })

  it('sends nothing when nothing changed, even if the name only gained spaces', () => {
    const patch = storePatchOf(BASE, { ...BASE, name: 'Main Store  ' })
    expect(patch).toEqual({})
    expect(hasChanges(patch)).toBe(false)
  })

  it('keeps a value the list does not hold so that the select can show it', () => {
    expect(withCurrent(['A', 'B'], 'C')).toEqual(['C', 'A', 'B'])
    expect(withCurrent(['A', 'B'], 'A')).toEqual(['A', 'B'])
    expect(withCurrent(['A'], '')).toEqual(['A'])
  })
})
