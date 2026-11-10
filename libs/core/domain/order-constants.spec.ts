import { formatPhoneList, OrderLimits, PackingNoteNotice, RecipientPhones } from './order-constants'
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
