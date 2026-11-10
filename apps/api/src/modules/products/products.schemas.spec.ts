import { ProductLimits, ProductSearchConfig } from '@platform/core/domain'

import {
  createProductSchema,
  createVariantSchema,
  listProductsQuerySchema,
  searchProductsQuerySchema,
  updateProductSchema,
  updateVariantSchema
} from './products.schemas'

describe('the schemas of the catalog', () => {
  it('turns the active filter of a query string into a boolean', () => {
    expect(listProductsQuerySchema.parse({ active: 'true' }).active).toBe(true)
    expect(listProductsQuerySchema.parse({ active: 'false' }).active).toBe(false)
    expect(listProductsQuerySchema.parse({}).active).toBeUndefined()
    expect(listProductsQuerySchema.safeParse({ active: '1' }).success).toBe(false)
  })

  it('accepts a price of zero and of exactly the ceiling, and nothing past them', () => {
    const parse = (priceCents: number) => createProductSchema.safeParse({ name: 'x', priceCents })
    expect(parse(0).success).toBe(true)
    expect(parse(ProductLimits.MAX_AMOUNT_CENTS).success).toBe(true)
    expect(parse(ProductLimits.MAX_AMOUNT_CENTS + 1).success).toBe(false)
    expect(parse(-1).success).toBe(false)
    expect(parse(0.5).success).toBe(false)
    expect(parse(Number.NaN).success).toBe(false)
  })

  it('trims names and skus, and refuses a name of only spaces', () => {
    const parsed = createProductSchema.parse({ name: '  Shoe  ', priceCents: 1, sku: ' A-1 ' })
    expect(parsed).toMatchObject({ name: 'Shoe', sku: 'A-1' })
    expect(createProductSchema.safeParse({ name: '   ', priceCents: 1 }).success).toBe(false)
  })

  it('tells "not sent" from "null" in a change, so that null can clear a field', () => {
    expect(updateProductSchema.parse({ lowStockThreshold: null })).toEqual({
      lowStockThreshold: null
    })
    expect(updateProductSchema.safeParse({}).success).toBe(false)
    expect(updateProductSchema.safeParse({ name: undefined }).success).toBe(false)
    expect(updateVariantSchema.parse({ priceCents: null })).toEqual({ priceCents: null })
    expect(updateVariantSchema.safeParse({}).success).toBe(false)
  })

  it('never accepts the store or the product in a body', () => {
    expect(createProductSchema.safeParse({ name: 'x', priceCents: 1, storeId: 'a' }).success).toBe(
      false
    )
    expect(updateProductSchema.safeParse({ storeId: 'a' }).success).toBe(false)
    expect(createVariantSchema.safeParse({ name: 'x', productId: 'a' }).success).toBe(false)
  })

  it('limits the attributes of a variant in number and in length', () => {
    const attributes = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, 'v']))
    expect(
      createVariantSchema.safeParse({
        name: 'x',
        attributes: attributes(ProductLimits.MAX_ATTRIBUTES)
      }).success
    ).toBe(true)
    expect(
      createVariantSchema.safeParse({
        name: 'x',
        attributes: attributes(ProductLimits.MAX_ATTRIBUTES + 1)
      }).success
    ).toBe(false)
    expect(createVariantSchema.safeParse({ name: 'x', attributes: { size: '' } }).success).toBe(
      false
    )
  })

  it('reads a search: the text trimmed, the limit and the archived flag with their defaults', () => {
    expect(searchProductsQuerySchema.parse({ q: '  shoe ' })).toEqual({
      q: 'shoe',
      limit: ProductSearchConfig.DEFAULT_LIMIT,
      includeArchived: false
    })
    expect(
      searchProductsQuerySchema.parse({ q: 'a', limit: '3', includeArchived: 'true' })
    ).toEqual({ q: 'a', limit: 3, includeArchived: true })
    expect(searchProductsQuerySchema.parse({ q: 'a\u00a0\u00a0b  c' }).q).toBe('a b c')
    // A short or empty text is a valid request (it answers an empty list), a missing one is not
    expect(searchProductsQuerySchema.safeParse({ q: '' }).success).toBe(true)
    expect(searchProductsQuerySchema.safeParse({}).success).toBe(false)
  })

  it('refuses a search that is too long, with a NUL, a limit out of range or a parameter it does not know', () => {
    const parse = (query: object) => searchProductsQuerySchema.safeParse(query).success
    expect(parse({ q: 'x'.repeat(ProductSearchConfig.MAX_QUERY_LENGTH) })).toBe(true)
    expect(parse({ q: 'x'.repeat(ProductSearchConfig.MAX_QUERY_LENGTH + 1) })).toBe(false)
    expect(parse({ q: 'a\0b' })).toBe(false)
    expect(parse({ q: 'x'.repeat(ProductSearchConfig.MAX_QUERY_LENGTH * 2 + 1) })).toBe(false)
    expect(parse({ q: 'ab', limit: '0' })).toBe(false)
    expect(parse({ q: 'ab', limit: String(ProductSearchConfig.MAX_LIMIT + 1) })).toBe(false)
    expect(parse({ q: 'ab', storeId: 'x' })).toBe(false)
  })
})
