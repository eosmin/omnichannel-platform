import { matchesProduct } from './product-search'

const shoe = { name: 'Zapato Café', sku: 'ZAP-42' }

describe('matchesProduct', () => {
  it('matches everything when the search is empty', () => {
    expect(matchesProduct(shoe, '')).toBe(true)
    expect(matchesProduct(shoe, '   ')).toBe(true)
  })

  it('matches part of the name or of the sku, with no regard for case or accents', () => {
    expect(matchesProduct(shoe, 'cafe')).toBe(true)
    expect(matchesProduct(shoe, 'ZAPATO')).toBe(true)
    expect(matchesProduct(shoe, 'zap-4')).toBe(true)
  })

  it('does not match what is in neither, and reads % as text', () => {
    expect(matchesProduct(shoe, 'sandalia')).toBe(false)
    expect(matchesProduct(shoe, '%')).toBe(false)
    expect(matchesProduct({ name: 'Sin SKU', sku: null }, 'zap')).toBe(false)
  })
})
