import {
  readOrderPreferences,
  readStorePreferences,
  updateStorePreferencesSchema
} from './store-preferences'

describe('readStorePreferences', () => {
  it('reads the factory defaults from an empty column', () => {
    expect(readStorePreferences({})).toEqual({ sendReadReceipts: true, assignOnReply: true })
  })

  it('keeps what the store chose', () => {
    expect(readStorePreferences({ sendReadReceipts: false, assignOnReply: false })).toEqual({
      sendReadReceipts: false,
      assignOnReply: false
    })
  })

  it('keeps a switch the store turned off next to a key it does not know or that does not fit', () => {
    expect(readStorePreferences({ sendReadReceipts: false, other: { nested: 'x' } })).toEqual({
      sendReadReceipts: false,
      assignOnReply: true
    })
  })

  it('reads a store that never chose the new switch as on', () => {
    expect(readStorePreferences({ sendReadReceipts: false }).assignOnReply).toBe(true)
  })

  it.each([null, 'text', 42, { sendReadReceipts: 'no' }])(
    'reads the defaults from a value that does not fit: %j',
    raw => {
      expect(readStorePreferences(raw)).toEqual({ sendReadReceipts: true, assignOnReply: true })
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
  const factory = {
    discountLimitPercent: 0,
    freeShippingRule: 'all_items',
    notifyOnPriceOverride: true,
    failedAttemptMessages: 'every_attempt'
  }

  it('reads the factory defaults from an empty column or one with no orders block', () => {
    expect(readOrderPreferences({})).toEqual(factory)
    expect(readOrderPreferences({ sendReadReceipts: false })).toEqual(factory)
  })

  it('keeps what the store chose', () => {
    expect(
      readOrderPreferences({ orders: { discountLimitPercent: 15, freeShippingRule: 'any_item' } })
    ).toEqual({
      discountLimitPercent: 15,
      freeShippingRule: 'any_item',
      notifyOnPriceOverride: true,
      failedAttemptMessages: 'every_attempt'
    })
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
    ).toEqual({
      discountLimitPercent: 0,
      freeShippingRule: 'any_item',
      notifyOnPriceOverride: true,
      failedAttemptMessages: 'every_attempt'
    })
    expect(
      readOrderPreferences({ orders: { discountLimitPercent: 20, freeShippingRule: 'never' } })
    ).toEqual({
      discountLimitPercent: 20,
      freeShippingRule: 'all_items',
      notifyOnPriceOverride: true,
      failedAttemptMessages: 'every_attempt'
    })
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
