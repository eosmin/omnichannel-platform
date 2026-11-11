import { ApiError, type WarehouseDetailView } from '@platform/api-client'

import {
  addableStores,
  addLink,
  fitLinks,
  createInputOf,
  emptyWarehouseDraft,
  isCodeInUse,
  linkInputsOf,
  linksChanged,
  linksOf,
  moveLink,
  placesIn,
  placesOf,
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

describe('the priority of the warehouse in each store', () => {
  const other: WarehouseDetailView = {
    ...warehouse,
    id: 'w2',
    stores: [
      { storeId: 's1', storeName: 'Shop', priority: 1 },
      { storeId: 's4', storeName: 'Depot', priority: 1 }
    ]
  }
  const places = placesOf([warehouse, other], warehouse)
  const links = linksOf({
    ...warehouse,
    stores: [
      { storeId: 's1', storeName: 'Shop', priority: 2 },
      { storeId: 's2', storeName: 'Outlet', priority: 1 }
    ]
  })

  it('lists the stores by name, whatever their priorities', () => {
    expect(links.map(link => link.storeName)).toEqual(['Outlet', 'Shop'])
  })

  it('counts the places of each store: the other warehouses it reserves from, plus this one', () => {
    expect(places.get('s1')).toBe(2)
    expect(places.get('s4')).toBe(2)
    expect(placesIn(places, 's2')).toBe(1)
  })

  it('moves the priority of one store one place, never outside its list', () => {
    const up = moveLink(links, 's1', -1, places)
    expect(up.find(link => link.storeId === 's1')?.priority).toBe(1)
    expect(up.find(link => link.storeId === 's2')?.priority).toBe(1)
    expect(moveLink(up, 's1', -1, places).find(link => link.storeId === 's1')?.priority).toBe(1)
    expect(moveLink(links, 's1', 1, places).find(link => link.storeId === 's1')?.priority).toBe(2)
    expect(moveLink(links, 's2', 1, places).find(link => link.storeId === 's2')?.priority).toBe(1)
  })

  it('sends every priority as it stands on the screen', () => {
    expect(linkInputsOf(moveLink(links, 's1', -1, places))).toEqual([
      { storeId: 's2', priority: 1 },
      { storeId: 's1', priority: 1 }
    ])
  })

  it('puts a priority above the last place of its store at the last place', () => {
    const tooHigh = [{ storeId: 's1', storeName: 'Shop', priority: 5 }]
    expect(fitLinks(tooHigh, places)[0]?.priority).toBe(2)
    expect(fitLinks(links, places)).toEqual(links)
  })

  it('treats a store with no other warehouse as a list of one place', () => {
    const empty = new Map<string, number>()
    expect(placesIn(empty, 's9')).toBe(1)
    const added = addLink([], { storeId: 's9', storeName: 'Kiosk' }, empty)
    expect(added).toEqual([{ storeId: 's9', storeName: 'Kiosk', priority: 1 }])
    expect(moveLink(added, 's9', 1, empty)[0]?.priority).toBe(1)
    expect(moveLink(added, 's9', -1, empty)[0]?.priority).toBe(1)
  })

  it('removes a store without touching the others', () => {
    expect(removeLink(links, 's2')).toEqual([links[1]])
  })

  it('adds a store at the end of its list, once, keeping the list by name', () => {
    const added = addLink(links, { storeId: 's4', storeName: 'Depot' }, places)
    expect(added.map(link => [link.storeId, link.priority])).toEqual([
      ['s4', 2],
      ['s2', 1],
      ['s1', 2]
    ])
    expect(addLink(added, { storeId: 's4', storeName: 'Depot' }, places)).toHaveLength(3)
  })

  it('knows when the list differs from the saved one, by store and by priority', () => {
    expect(linksChanged(links, [...links].reverse())).toBe(false)
    expect(linksChanged(links, moveLink(links, 's1', -1, places))).toBe(true)
    expect(linksChanged(links, removeLink(links, 's2'))).toBe(true)
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
