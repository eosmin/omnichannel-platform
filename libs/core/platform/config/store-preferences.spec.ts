import { OrderCancellationReasons } from '@platform/core/domain'

import {
  cancellationReasonsSchema,
  readRemittancePreferences,
  updateRemittancePreferencesSchema,
  CancellationReasonLimits,
  defaultCancellationReasons,
  readOrderPreferences,
  readStorePreferences,
  storePreferencesSchema,
  updateStorePreferencesSchema
} from './store-preferences'

const factoryOrders = {
  confirmOnCreate: false,
  sendSummaryOnCreate: true,
  discountLimitPercent: 0,
  freeShippingRule: 'all_items',
  notifyOnPriceOverride: true,
  failedAttemptMessages: 'every_attempt',
  cancellationReasons: defaultCancellationReasons
}
const factoryReturns = { preselectCautionOnRefusal: false }
const factoryRemittances = { overdueAfterDays: 7 }
const factory = {
  sendReadReceipts: true,
  assignOnReply: true,
  orders: factoryOrders,
  returns: factoryReturns,
  remittances: factoryRemittances
}

describe('the returns block', () => {
  it('reads the reception toggle off by default and keeps what the store chose', () => {
    expect(readStorePreferences({}).returns).toEqual(factoryReturns)
    expect(readStorePreferences({ returns: { preselectCautionOnRefusal: true } }).returns).toEqual({
      preselectCautionOnRefusal: true
    })
  })

  it('reads the default for a value that does not fit, without touching the orders block', () => {
    const read = readStorePreferences({
      returns: { preselectCautionOnRefusal: 'yes' },
      orders: { confirmOnCreate: true }
    })
    expect(read.returns).toEqual(factoryReturns)
    expect(read.orders.confirmOnCreate).toBe(true)
    expect(readStorePreferences({ returns: 'text' }).returns).toEqual(factoryReturns)
  })
})

describe('readStorePreferences', () => {
  it('reads the factory defaults from an empty column', () => {
    expect(readStorePreferences({})).toEqual(factory)
  })

  it('keeps what the store chose', () => {
    expect(readStorePreferences({ sendReadReceipts: false, assignOnReply: false })).toEqual({
      ...factory,
      sendReadReceipts: false,
      assignOnReply: false
    })
  })

  it('keeps a switch the store turned off next to a key it does not know or that does not fit', () => {
    expect(readStorePreferences({ sendReadReceipts: false, other: { nested: 'x' } })).toEqual({
      ...factory,
      sendReadReceipts: false
    })
  })

  it('reads a store that never chose the new switch as on', () => {
    expect(readStorePreferences({ sendReadReceipts: false }).assignOnReply).toBe(true)
  })

  it.each([null, 'text', 42, { sendReadReceipts: 'no' }])(
    'reads the defaults from a value that does not fit: %j',
    raw => {
      expect(readStorePreferences(raw)).toEqual(factory)
    }
  )
})

describe('updateStorePreferencesSchema', () => {
  it('takes the keys that change', () => {
    expect(updateStorePreferencesSchema.parse({ sendReadReceipts: false })).toEqual({
      sendReadReceipts: false
    })
    expect(updateStorePreferencesSchema.parse({ assignOnReply: false })).toEqual({
      assignOnReply: false
    })
  })

  it.each([
    ['nothing', {}],
    ['a key it does not know', { sendReadReceipts: true, other: 1 }],
    [
      'a value of another type, which reading would turn into the default',
      { sendReadReceipts: 'no' }
    ],
    ['null', { sendReadReceipts: null }],
    ['a switch that is not a boolean', { assignOnReply: 'off' }]
  ])('refuses %s', (_name, body) => {
    expect(updateStorePreferencesSchema.safeParse(body).success).toBe(false)
  })
})

describe('readOrderPreferences', () => {
  const factory = factoryOrders

  it('reads the factory defaults from an empty column or one with no orders block', () => {
    expect(readOrderPreferences({})).toEqual(factory)
    expect(readOrderPreferences({ sendReadReceipts: false })).toEqual(factory)
  })

  it('keeps what the store chose', () => {
    expect(
      readOrderPreferences({ orders: { discountLimitPercent: 15, freeShippingRule: 'any_item' } })
    ).toEqual({ ...factoryOrders, discountLimitPercent: 15, freeShippingRule: 'any_item' })
    expect(
      readOrderPreferences({ orders: { notifyOnPriceOverride: false } }).notifyOnPriceOverride
    ).toBe(false)
    expect(
      readOrderPreferences({ orders: { notifyOnPriceOverride: 'no' } }).notifyOnPriceOverride
    ).toBe(true)
  })

  it('gives each key its own default, so one bad value never resets the other', () => {
    expect(
      readOrderPreferences({
        orders: { discountLimitPercent: 'a lot', freeShippingRule: 'any_item' }
      })
    ).toEqual({ ...factoryOrders, freeShippingRule: 'any_item' })
    expect(
      readOrderPreferences({ orders: { discountLimitPercent: 20, freeShippingRule: 'never' } })
    ).toEqual({ ...factoryOrders, discountLimitPercent: 20 })
  })

  it('reads how often the customer hears of a failed attempt, every one by default', () => {
    for (const value of ['every_attempt', 'first_only', 'none']) {
      expect(
        readOrderPreferences({ orders: { failedAttemptMessages: value } }).failedAttemptMessages
      ).toBe(value)
    }
    expect(
      readOrderPreferences({ orders: { failedAttemptMessages: 'sometimes' } }).failedAttemptMessages
    ).toBe('every_attempt')
  })

  it.each([101, -1, 2.5])('reads a limit of %s as the strictest one, none', limit => {
    expect(readOrderPreferences({ orders: { discountLimitPercent: limit } })).toEqual(factory)
  })

  it.each([null, 'text', 42, [], { orders: null }, { orders: 'x' }, { orders: [] }])(
    'reads the defaults from a value that does not fit: %j',
    raw => {
      expect(readOrderPreferences(raw)).toEqual(factory)
    }
  )
})

describe('the orders keys of the create-order checkboxes', () => {
  it('starts the summary checkbox on and the confirm checkbox off, in every store that never chose', () => {
    expect(readOrderPreferences({}).sendSummaryOnCreate).toBe(true)
    expect(readOrderPreferences({}).confirmOnCreate).toBe(false)
  })

  it('keeps what the store chose and reads a value of another type as the default, one key at a time', () => {
    expect(
      readOrderPreferences({ orders: { sendSummaryOnCreate: false, confirmOnCreate: true } })
    ).toEqual({ ...factoryOrders, sendSummaryOnCreate: false, confirmOnCreate: true })
    expect(
      readOrderPreferences({ orders: { sendSummaryOnCreate: 'no', confirmOnCreate: true } })
    ).toEqual({ ...factoryOrders, confirmOnCreate: true })
  })
})

describe('orders.cancellationReasons', () => {
  it('is seeded from OrderCancellationReasons, one entry per factory reason, in order', () => {
    expect(defaultCancellationReasons.map(reason => reason.labelKey)).toEqual(
      Object.values(OrderCancellationReasons)
    )
    expect(defaultCancellationReasons.map(reason => reason.id)).toEqual(
      Object.keys(OrderCancellationReasons)
    )
    expect(readOrderPreferences({}).cancellationReasons).toEqual(defaultCancellationReasons)
  })

  it('keeps the list the store saved, factory and own entries together', () => {
    const list = [
      { id: 'CUSTOMER_REQUEST', labelKey: OrderCancellationReasons.CUSTOMER_REQUEST },
      { id: 'c1', label: 'Fraud suspected' }
    ]
    expect(
      readOrderPreferences({ orders: { cancellationReasons: list } }).cancellationReasons
    ).toEqual(list)
  })

  it.each([
    ['an empty list', []],
    ['a list that is not a list', 'x'],
    [
      'an entry with both labelKey and label',
      [{ id: 'a', labelKey: OrderCancellationReasons.OTHER, label: 'x' }]
    ],
    ['an entry with neither', [{ id: 'a' }]],
    [
      'a labelKey the product does not ship',
      [{ id: 'a', labelKey: 'orders.cancellationReason.invented' }]
    ],
    [
      'a repeated id',
      [
        { id: 'a', label: 'x' },
        { id: 'a', label: 'y' }
      ]
    ],
    [
      'two entries with the same labelKey',
      [
        { id: 'a', labelKey: OrderCancellationReasons.OTHER },
        { id: 'b', labelKey: OrderCancellationReasons.OTHER }
      ]
    ],
    [
      'two entries with the same label, whatever the case',
      [
        { id: 'a', label: 'Fraud' },
        { id: 'b', label: 'fraud' }
      ]
    ],
    ['a blank label', [{ id: 'a', label: '   ' }]]
  ])('reads %s as the factory list, leaving the other keys alone', (_name, list) => {
    expect(
      readOrderPreferences({ orders: { cancellationReasons: list, confirmOnCreate: true } })
    ).toEqual({ ...factoryOrders, confirmOnCreate: true })
  })

  it('holds a list to its limits', () => {
    const entry = (id: string) => ({ id, label: `reason ${id}` })
    const full = Array.from({ length: CancellationReasonLimits.MAX_ENTRIES }, (_, i) =>
      entry(`r${i}`)
    )
    expect(cancellationReasonsSchema.safeParse(full).success).toBe(true)
    expect(cancellationReasonsSchema.safeParse([...full, entry('extra')]).success).toBe(false)
    expect(
      cancellationReasonsSchema.safeParse([
        { id: 'a'.repeat(CancellationReasonLimits.MAX_ID_LENGTH), label: 'x' }
      ]).success
    ).toBe(true)
    expect(
      cancellationReasonsSchema.safeParse([
        { id: 'a'.repeat(CancellationReasonLimits.MAX_ID_LENGTH + 1), label: 'x' }
      ]).success
    ).toBe(false)
    expect(
      cancellationReasonsSchema.safeParse([
        { id: 'a', label: 'y'.repeat(CancellationReasonLimits.MAX_LABEL_LENGTH + 1) }
      ]).success
    ).toBe(false)
  })
})

describe('updateStorePreferencesSchema, the orders block', () => {
  it('takes the keys of the block that change, alone or next to a flat key', () => {
    expect(updateStorePreferencesSchema.parse({ orders: { confirmOnCreate: true } })).toEqual({
      orders: { confirmOnCreate: true }
    })
    expect(
      updateStorePreferencesSchema.parse({
        assignOnReply: false,
        orders: { sendSummaryOnCreate: false }
      })
    ).toEqual({ assignOnReply: false, orders: { sendSummaryOnCreate: false } })
    expect(
      updateStorePreferencesSchema.parse({
        orders: { cancellationReasons: [{ id: 'a', label: 'Other' }] }
      }).orders?.cancellationReasons
    ).toEqual([{ id: 'a', label: 'Other' }])
  })

  it.each([
    ['an empty block', { orders: {} }],
    ['a key of the block that has no write path yet', { orders: { discountLimitPercent: 10 } }],
    ['a key the block does not know', { orders: { confirmOnCreate: true, other: 1 } }],
    ['a switch that is not a boolean', { orders: { sendSummaryOnCreate: 'off' } }],
    ['null for a key', { orders: { confirmOnCreate: null } }],
    ['an empty reason list', { orders: { cancellationReasons: [] } }],
    ['a block that is not an object', { orders: true }]
  ])('refuses %s', (_name, body) => {
    expect(updateStorePreferencesSchema.safeParse(body).success).toBe(false)
  })
})

describe('storePreferencesSchema', () => {
  it('keeps the factory defaults in this one place', () => {
    expect(storePreferencesSchema.parse({})).toEqual(factory)
  })
})

describe('the remittances block (TDD_17 §4.15)', () => {
  it('reads seven days when the column has none, or a value that does not fit', () => {
    expect(readRemittancePreferences({})).toEqual(factoryRemittances)
    for (const value of [0, 91, 2.5, '7', null, -1]) {
      expect(readRemittancePreferences({ remittances: { overdueAfterDays: value } })).toEqual(
        factoryRemittances
      )
    }
    expect(readRemittancePreferences({ remittances: 'x' })).toEqual(factoryRemittances)
  })

  it('keeps a number of days inside the range', () => {
    for (const days of [1, 14, 90]) {
      expect(
        readRemittancePreferences({ remittances: { overdueAfterDays: days } }).overdueAfterDays
      ).toBe(days)
    }
  })

  it('takes a change that is inside the range and refuses the rest', () => {
    expect(updateStorePreferencesSchema.parse({ remittances: { overdueAfterDays: 3 } })).toEqual({
      remittances: { overdueAfterDays: 3 }
    })
    for (const body of [{}, { overdueAfterDays: 0 }, { overdueAfterDays: 91 }, { other: 1 }]) {
      expect(updateRemittancePreferencesSchema.safeParse(body).success).toBe(false)
    }
  })
})
