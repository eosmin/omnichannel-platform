import { InventoryLimits, WarehouseLimits } from '@platform/core/domain'

import {
  createWarehouseSchema,
  listWarehousesQuerySchema,
  putWarehouseStoresSchema,
  updateWarehouseSchema
} from './warehouses.schemas'

const STORE = '3f0a1c9e-52b4-4b43-9d3c-8f1d2a7e6b10'
const OTHER_STORE = '8a6f5d2c-1e3b-4f7a-9c0d-2b4e6a8c0e12'

describe('createWarehouseSchema', () => {
  it('trims the name, keeps the code as typed and upper-cases the country', () => {
    const parsed = createWarehouseSchema.parse({
      name: '  North  ',
      code: 'North-1',
      address: { line1: 'a', city: 'b', country: 'sv' }
    })

    expect(parsed).toEqual({
      name: 'North',
      code: 'North-1',
      address: { line1: 'a', city: 'b', country: 'SV' }
    })
  })

  it.each([
    ['an accent', 'Bodega-É'],
    ['a space', 'A B'],
    ['a leading dot', '.A'],
    ['no characters', ''],
    ['more than the limit', 'A'.repeat(InventoryLimits.WAREHOUSE_CODE_MAX_LENGTH + 1)],
    ['a line break', 'A\nB']
  ])('refuses a code with %s', (_label, code) => {
    expect(createWarehouseSchema.safeParse({ name: 'x', code }).success).toBe(false)
  })

  it('accepts a code at the limit and the punctuation the pattern names', () => {
    const code = `A${'b'.repeat(InventoryLimits.WAREHOUSE_CODE_MAX_LENGTH - 1)}`
    expect(createWarehouseSchema.safeParse({ name: 'x', code }).success).toBe(true)
    expect(createWarehouseSchema.safeParse({ name: 'x', code: 'a.b_c-1' }).success).toBe(true)
    expect(WarehouseLimits.CODE_PATTERN.test('a.b_c-1')).toBe(true)
  })

  it('refuses a name that is blank, has a control character or is too long, and any unknown key', () => {
    for (const bad of [
      { name: '   ', code: 'A' },
      { name: 'a\u0000b', code: 'A' },
      { name: 'x'.repeat(InventoryLimits.WAREHOUSE_NAME_MAX_LENGTH + 1), code: 'A' },
      { name: 'x', code: 'A', organizationId: STORE },
      { name: 'x', code: 'A', address: { line1: 'a', city: 'b', extra: 'c' } },
      { name: 'x', code: 'A', address: { line1: 'a', city: 'b', country: 'SLV' } }
    ]) {
      expect(createWarehouseSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('updateWarehouseSchema', () => {
  it('needs something to change, and takes a null address to clear it', () => {
    expect(updateWarehouseSchema.safeParse({}).success).toBe(false)
    expect(updateWarehouseSchema.safeParse({ address: undefined }).success).toBe(false)
    expect(updateWarehouseSchema.parse({ address: null })).toEqual({ address: null })
    expect(updateWarehouseSchema.safeParse({ active: 'false' }).success).toBe(false)
  })
})

describe('putWarehouseStoresSchema', () => {
  it('takes an empty list (unlink everything) and a priority of one or more', () => {
    expect(putWarehouseStoresSchema.parse({ stores: [] })).toEqual({ stores: [] })
    expect(
      putWarehouseStoresSchema.parse({
        stores: [{ storeId: STORE, priority: 2 }, { storeId: OTHER_STORE }]
      }).stores
    ).toHaveLength(2)
  })

  it('refuses a store named twice, a priority below one, a fraction, and extra keys', () => {
    for (const bad of [
      { stores: [{ storeId: STORE }, { storeId: STORE }] },
      { stores: [{ storeId: STORE, priority: 0 }] },
      { stores: [{ storeId: STORE, priority: 1.5 }] },
      { stores: [{ storeId: 'nope' }] },
      { stores: [{ storeId: STORE, organizationId: OTHER_STORE }] },
      { stores: [], organizationId: OTHER_STORE },
      {}
    ]) {
      expect(putWarehouseStoresSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('refuses more links than a request may carry', () => {
    const stores = Array.from({ length: WarehouseLimits.MAX_STORES_PER_REQUEST + 1 }, (_, i) => ({
      storeId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    }))
    expect(putWarehouseStoresSchema.safeParse({ stores }).success).toBe(false)
  })
})

describe('listWarehousesQuerySchema', () => {
  it('reads the flag from the text of the query string and refuses a limit of zero', () => {
    expect(listWarehousesQuerySchema.parse({ active: 'false' }).active).toBe(false)
    expect(listWarehousesQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(listWarehousesQuerySchema.safeParse({ active: 'yes' }).success).toBe(false)
    expect(listWarehousesQuerySchema.safeParse({ organizationId: STORE }).success).toBe(false)
  })
})
