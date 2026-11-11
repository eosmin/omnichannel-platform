import { Permissions } from './auth/permissions'
import {
  formatOrderNumber,
  formatPhoneList,
  orderMovementKey,
  OrderStockEffects,
  OrderLimits,
  OrderNumber,
  PackingNoteNotice,
  RecipientPhones
} from './order-constants'
import { OrderStatus } from './status-enums'

describe('formatPhoneList', () => {
  it('joins the phones with the separator of the list, in order', () => {
    expect(formatPhoneList(['71234567', '22123456', '60001111'])).toBe(
      '71234567 / 22123456 / 60001111'
    )
  })

  it('writes one phone as it is and an empty list as nothing', () => {
    expect(formatPhoneList(['71234567'])).toBe('71234567')
    expect(formatPhoneList([])).toBe('')
  })
})

describe('order limits', () => {
  it('allows up to three recipient phones of at most 15 digits', () => {
    expect(RecipientPhones.MAX_COUNT).toBe(3)
    expect(RecipientPhones.MAX_DIGITS).toBe(15)
    expect(RecipientPhones.MIN_DIGITS).toBe(6)
    expect(RecipientPhones.LIST_SEPARATOR).toBe(' / ')
  })

  it("gives the packing note a ceiling of its own and the internal one the customer note's", () => {
    expect(OrderLimits.INTERNAL_NOTES_MAX_LENGTH).toBe(OrderLimits.CUSTOMER_NOTES_MAX_LENGTH)
    expect(OrderLimits.PACKING_NOTES_MAX_LENGTH).toBe(1000)
    expect(OrderLimits.INTERNAL_NOTES_MAX_LENGTH).toBe(1000)
  })

  it('warns the warehouse only about orders waiting to be packed', () => {
    expect([...PackingNoteNotice.STATUSES]).toEqual([OrderStatus.CONFIRMED, OrderStatus.PREPARING])
  })
})

describe('formatOrderNumber', () => {
  it('pads to the minimum digits so every number of a store has the same length for a prefix search', () => {
    expect(formatOrderNumber(1)).toBe('00001')
    expect(formatOrderNumber(42)).toBe('00042')
    expect(formatOrderNumber(99_999)).toBe('99999')
  })

  it('never cuts a number that has more digits', () => {
    expect(formatOrderNumber(100_000)).toBe('100000')
    expect(formatOrderNumber(OrderNumber.MAX)).toBe(String(OrderNumber.MAX))
  })
})

describe('the packing note notice', () => {
  it('goes to who may prepare or ship an order', () => {
    expect([...PackingNoteNotice.PERMISSIONS]).toEqual([
      Permissions.ORDERS_CHANGE_STATUS,
      Permissions.SHIPPING_MANAGE
    ])
  })
})

describe('orderMovementKey', () => {
  it('names the order, the line, the warehouse and the effect, so the same effect never applies twice', () => {
    expect(orderMovementKey('o1', 'i1', 'w1', OrderStockEffects.RESERVE)).toBe(
      'order:o1:i1:w1:reserve'
    )
    expect(orderMovementKey('o1', 'i1', 'w2', OrderStockEffects.RESERVE)).not.toBe(
      orderMovementKey('o1', 'i1', 'w1', OrderStockEffects.RESERVE)
    )
    expect(orderMovementKey('o1', 'i1', 'w1', OrderStockEffects.ISSUE)).not.toBe(
      orderMovementKey('o1', 'i1', 'w1', OrderStockEffects.RESERVE)
    )
  })

  it('stays inside the length the ledger accepts for a key, with real ids', () => {
    const id = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
    expect(orderMovementKey(id, id, id, OrderStockEffects.RETURN).length).toBeLessThanOrEqual(200)
  })
})
