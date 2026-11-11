import { ApiError, type WarehouseDetailView } from '@platform/api-client'

import {
  addableStores,
  addLink,
  createInputOf,
  emptyWarehouseDraft,
  isCodeInUse,
  linkInputsOf,
  linksChanged,
  linksOf,
  moveLink,
  removeLink,
  stockBlockKeyOf,
  updateInputOf,
  warehouseDraftOf,
  warehouseProblem
} from './warehouse-form'

const warehouse: WarehouseDetailView = {
  id: 'w1',
  name: 'Main',
  code: 'MAIN',
  address: { line1: '1 Main St', city: 'Leon', country: 'MX' },
  active: true,
  stores: [
    { storeId: 's1', storeName: 'Shop', priority: 1 },
    { storeId: 's2', storeName: 'Outlet', priority: 2 },
    { storeId: 's3', storeName: 'Kiosk', priority: 3 }
  ],
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z'
}

const filled = (patch: Partial<ReturnType<typeof emptyWarehouseDraft>> = {}) => ({
  ...emptyWarehouseDraft(),
  name: 'Main',
  code: 'MAIN',
  ...patch
})

describe('warehouseProblem', () => {
  it('accepts a name and a code with no address', () => {
    expect(warehouseProblem(filled())).toBeNull()
  })

  it('names the first field that cannot be sent', () => {
    expect(warehouseProblem(filled({ name: '  ' }))).toBe('name')
    expect(warehouseProblem(filled({ code: 'has space' }))).toBe('code')
    expect(warehouseProblem(filled({ code: '' }))).toBe('code')
    expect(warehouseProblem(filled({ code: 'A'.repeat(21) }))).toBe('code')
  })

  it('asks for the first line and the city as soon as any part of the address is typed', () => {
    expect(warehouseProblem(filled({ postalCode: '37000' }))).toBe('line1')
    expect(warehouseProblem(filled({ line1: '1 Main St' }))).toBe('city')
    expect(warehouseProblem(filled({ line1: '1 Main St', city: 'Leon' }))).toBeNull()
  })

  it('wants two letters for the country, in any case', () => {
    const base = { line1: '1 Main St', city: 'Leon' }
    expect(warehouseProblem(filled({ ...base, country: 'mex' }))).toBe('country')
    expect(warehouseProblem(filled({ ...base, country: 'mx' }))).toBeNull()
  })
})

describe('createInputOf', () => {
  it('sends no address when none was typed, and trims what was', () => {
    expect(createInputOf(filled({ name: ' Main ' }))).toEqual({ name: 'Main', code: 'MAIN' })
  })

  it('sends only the address parts that were typed, with the country in capitals', () => {
    expect(
      createInputOf(filled({ line1: '1 Main St', city: 'Leon', country: 'mx', state: '' }))
    ).toEqual({
      name: 'Main',
      code: 'MAIN',
      address: { line1: '1 Main St', city: 'Leon', country: 'MX' }
    })
  })
})

describe('updateInputOf', () => {
  it('is empty when nothing changed, even if the text only differs by spaces', () => {
    const draft = { ...warehouseDraftOf(warehouse), name: ' Main ' }
    expect(updateInputOf(warehouse, draft)).toEqual({})
  })

  it('sends only the keys that changed', () => {
    const draft = { ...warehouseDraftOf(warehouse), name: 'Central' }
    expect(updateInputOf(warehouse, draft)).toEqual({ name: 'Central' })
  })

  it('sends the whole address when a part of it changed', () => {
    const draft = { ...warehouseDraftOf(warehouse), city: 'Queretaro' }
    expect(updateInputOf(warehouse, draft)).toEqual({
      address: { line1: '1 Main St', city: 'Queretaro', country: 'MX' }
    })
  })

  it('clears the address with null when every part is emptied', () => {
    const draft = {
      ...warehouseDraftOf(warehouse),
      line1: '',
      city: '',
      country: ''
    }
    expect(updateInputOf(warehouse, draft)).toEqual({ address: null })
  })
})

describe('the order of the stores', () => {
  const links = linksOf(warehouse)

  it('renumbers the priorities from the order on the list', () => {
    expect(moveLink(links, 2, -1).map(link => [link.storeId, link.priority])).toEqual([
      ['s1', 1],
      ['s3', 2],
      ['s2', 3]
    ])
    expect(linkInputsOf(moveLink(links, 0, 1))).toEqual([
      { storeId: 's2', priority: 1 },
      { storeId: 's1', priority: 2 },
      { storeId: 's3', priority: 3 }
    ])
  })

  it('does not move the first one up or the last one down', () => {
    expect(moveLink(links, 0, -1).map(link => link.storeId)).toEqual(['s1', 's2', 's3'])
    expect(moveLink(links, 2, 1).map(link => link.storeId)).toEqual(['s1', 's2', 's3'])
  })

  it('removes a store and closes the gap in the priorities', () => {
    expect(removeLink(links, 's2').map(link => [link.storeId, link.priority])).toEqual([
      ['s1', 1],
      ['s3', 2]
    ])
  })

  it('adds a store at the end, once', () => {
    const added = addLink(links, { storeId: 's4', storeName: 'Depot' })
    expect(added.at(-1)).toEqual({ storeId: 's4', storeName: 'Depot', priority: 4 })
    expect(addLink(added, { storeId: 's4', storeName: 'Depot' })).toHaveLength(4)
  })

  it('knows when the list differs from the saved one, by store and by position', () => {
    expect(linksChanged(links, linksOf(warehouse))).toBe(false)
    expect(linksChanged(links, moveLink(links, 0, 1))).toBe(true)
    expect(linksChanged(links, removeLink(links, 's3'))).toBe(true)
  })

  it('offers only the stores that are not linked yet', () => {
    const stores = [{ id: 's1' }, { id: 's4' }]
    expect(addableStores(stores, links)).toEqual([{ id: 's4' }])
  })
})

describe('what the api says about a refusal', () => {
  const refusal = (metadata: Record<string, unknown>) =>
    new ApiError(409, 'INVENTORY_WAREHOUSE_HAS_STOCK', 'x', null, metadata)

  it('maps the reason of a stock block to its key', () => {
    expect(stockBlockKeyOf(refusal({ reason: 'deactivate' }))).toBe('deactivate')
    expect(stockBlockKeyOf(refusal({ reason: 'unlink' }))).toBe('unlink')
    expect(stockBlockKeyOf(refusal({ reason: 'open_transfer' }))).toBe('openTransfer')
  })

  it('knows nothing of a reason it was not told, or an error that is not the api', () => {
    expect(stockBlockKeyOf(refusal({ reason: 'new_reason' }))).toBeNull()
    expect(stockBlockKeyOf(refusal({}))).toBeNull()
    expect(stockBlockKeyOf(new Error('x'))).toBeNull()
  })

  it('recognizes a code that is already in use', () => {
    expect(isCodeInUse(refusal({ conflict: 'code_in_use' }))).toBe(true)
    expect(isCodeInUse(refusal({ conflict: 'inactive' }))).toBe(false)
    expect(isCodeInUse(new Error('x'))).toBe(false)
  })
})
