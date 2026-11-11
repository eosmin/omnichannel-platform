import {
  checkRequestedAllocation,
  planLineAllocation,
  type WarehouseAvailability
} from './order-allocation'

const A = 'warehouse-a'
const B = 'warehouse-b'
const C = 'warehouse-c'

const stock = (...pairs: [string, number][]): WarehouseAvailability[] =>
  pairs.map(([warehouseId, available]) => ({ warehouseId, available }))

describe('planLineAllocation', () => {
  it('gives the whole line to the first warehouse that covers it, in both modes', () => {
    for (const allowSplitFulfillment of [false, true]) {
      expect(
        planLineAllocation({
          quantity: 5,
          warehouses: stock([A, 2], [B, 5], [C, 50]),
          allowSplitFulfillment,
          allowNegativeStock: false
        })
      ).toEqual({ ok: true, allocations: [{ warehouseId: B, quantity: 5 }] })
    }
  })

  it('serves the example of the TDD: 10 units from A (6) and B (8) split 6 and 4, and refused without split', () => {
    const warehouses = stock([A, 6], [B, 8])
    expect(
      planLineAllocation({
        quantity: 10,
        warehouses,
        allowSplitFulfillment: true,
        allowNegativeStock: false
      })
    ).toEqual({
      ok: true,
      allocations: [
        { warehouseId: A, quantity: 6 },
        { warehouseId: B, quantity: 4 }
      ]
    })
    expect(
      planLineAllocation({
        quantity: 10,
        warehouses,
        allowSplitFulfillment: false,
        allowNegativeStock: false
      })
    ).toEqual({ ok: false, availableByWarehouse: warehouses })
  })

  it('prefers one warehouse over a split when a later one covers the line alone', () => {
    expect(
      planLineAllocation({
        quantity: 10,
        warehouses: stock([A, 6], [B, 12]),
        allowSplitFulfillment: true,
        allowNegativeStock: false
      })
    ).toEqual({ ok: true, allocations: [{ warehouseId: B, quantity: 10 }] })
  })

  it('refuses when all the warehouses together are short, with the stock of each (never below zero)', () => {
    expect(
      planLineAllocation({
        quantity: 20,
        warehouses: stock([A, 6], [B, -3], [C, 8]),
        allowSplitFulfillment: true,
        allowNegativeStock: false
      })
    ).toEqual({ ok: false, availableByWarehouse: stock([A, 6], [B, 0], [C, 8]) })
  })

  it('skips a warehouse with nothing available when it splits', () => {
    expect(
      planLineAllocation({
        quantity: 7,
        warehouses: stock([A, 0], [B, -2], [C, 7]),
        allowSplitFulfillment: true,
        allowNegativeStock: false
      })
    ).toEqual({ ok: true, allocations: [{ warehouseId: C, quantity: 7 }] })
    expect(
      planLineAllocation({
        quantity: 9,
        warehouses: stock([A, 0], [B, 4], [C, 5]),
        allowSplitFulfillment: true,
        allowNegativeStock: false
      })
    ).toEqual({
      ok: true,
      allocations: [
        { warehouseId: B, quantity: 4 },
        { warehouseId: C, quantity: 5 }
      ]
    })
  })

  it('sends what is missing to the highest-priority warehouse when the store allows negative stock', () => {
    // Split off: the line goes whole to the first warehouse, whose available stock goes negative
    expect(
      planLineAllocation({
        quantity: 10,
        warehouses: stock([A, 6], [B, 8]),
        allowSplitFulfillment: false,
        allowNegativeStock: true
      })
    ).toEqual({ ok: true, allocations: [{ warehouseId: A, quantity: 10 }] })
    // Split on: the others give what they have first, and the shortfall goes to the first one
    expect(
      planLineAllocation({
        quantity: 20,
        warehouses: stock([A, 6], [B, 8]),
        allowSplitFulfillment: true,
        allowNegativeStock: true
      })
    ).toEqual({
      ok: true,
      allocations: [
        { warehouseId: A, quantity: 12 },
        { warehouseId: B, quantity: 8 }
      ]
    })
    // The first warehouse has nothing at all: it still takes the shortfall
    expect(
      planLineAllocation({
        quantity: 5,
        warehouses: stock([A, -1], [B, 0]),
        allowSplitFulfillment: true,
        allowNegativeStock: true
      })
    ).toEqual({ ok: true, allocations: [{ warehouseId: A, quantity: 5 }] })
  })

  it('refuses a store that sells from no warehouse, even when it allows negative stock', () => {
    expect(
      planLineAllocation({
        quantity: 1,
        warehouses: [],
        allowSplitFulfillment: true,
        allowNegativeStock: true
      })
    ).toEqual({ ok: false, availableByWarehouse: [] })
  })

  it('refuses a quantity that is not a whole number above zero', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(
        planLineAllocation({
          quantity,
          warehouses: stock([A, 10]),
          allowSplitFulfillment: true,
          allowNegativeStock: true
        }).ok
      ).toBe(false)
    }
  })
})

describe('checkRequestedAllocation', () => {
  const base = {
    warehouses: stock([A, 6], [B, 8]),
    allowSplitFulfillment: true,
    allowNegativeStock: false
  }

  it('takes a choice that adds up, is in stock and lists it in priority order', () => {
    expect(
      checkRequestedAllocation({
        ...base,
        quantity: 10,
        requested: [
          { warehouseId: B, quantity: 7 },
          { warehouseId: A, quantity: 3 }
        ]
      })
    ).toEqual({
      ok: true,
      allocations: [
        { warehouseId: A, quantity: 3 },
        { warehouseId: B, quantity: 7 }
      ]
    })
  })

  it('refuses a warehouse the store does not sell from, whatever the rest says', () => {
    expect(
      checkRequestedAllocation({
        ...base,
        quantity: 2,
        requested: [{ warehouseId: C, quantity: 2 }]
      })
    ).toEqual({ ok: false, reason: 'not_linked', warehouseId: C })
  })

  it('refuses units that do not add up, a repeated warehouse and an empty choice', () => {
    for (const requested of [
      [{ warehouseId: A, quantity: 2 }],
      [
        { warehouseId: A, quantity: 2 },
        { warehouseId: A, quantity: 2 }
      ],
      [
        { warehouseId: A, quantity: 0 },
        { warehouseId: B, quantity: 4 }
      ],
      []
    ]) {
      expect(checkRequestedAllocation({ ...base, quantity: 4, requested })).toEqual({
        ok: false,
        reason: 'quantity_mismatch'
      })
    }
  })

  it('refuses a split in a store that ships each line from one warehouse', () => {
    expect(
      checkRequestedAllocation({
        ...base,
        allowSplitFulfillment: false,
        quantity: 4,
        requested: [
          { warehouseId: A, quantity: 2 },
          { warehouseId: B, quantity: 2 }
        ]
      })
    ).toEqual({ ok: false, reason: 'split_not_allowed' })
  })

  it('refuses a warehouse with less than it is asked for, naming the stock of each one, unless negative stock is on', () => {
    const input = { ...base, quantity: 7, requested: [{ warehouseId: A, quantity: 7 }] }
    expect(checkRequestedAllocation(input)).toEqual({
      ok: false,
      reason: 'insufficient',
      availableByWarehouse: stock([A, 6], [B, 8])
    })
    expect(checkRequestedAllocation({ ...input, allowNegativeStock: true })).toEqual({
      ok: true,
      allocations: [{ warehouseId: A, quantity: 7 }]
    })
  })

  it('never reports a negative stock in a refusal', () => {
    expect(
      checkRequestedAllocation({
        ...base,
        warehouses: stock([A, -3], [B, 8]),
        quantity: 1,
        requested: [{ warehouseId: A, quantity: 1 }]
      })
    ).toMatchObject({ availableByWarehouse: stock([A, 0], [B, 8]) })
  })
})
