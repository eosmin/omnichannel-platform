import { slugify } from './bootstrap-owner'

describe('slugify', () => {
  it('lowercases, drops accents and joins words with dashes', () => {
    expect(slugify('Tienda Escalón')).toBe('tienda-escalon')
    expect(slugify('  Mi   Comercio, S.A. ')).toBe('mi-comercio-s-a')
  })

  it('refuses a name with nothing to build a slug from', () => {
    expect(() => slugify('¡¿?!')).toThrow('no letters or digits')
  })
})
