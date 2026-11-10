import type { PrismaTransaction } from '@platform/core/database'
import { AuthorType, MessageType, OrderStatus, OrderSummaryEvents } from '@platform/core/domain'

import { orderSummaryLineSchema, writeOrderSummaryLine } from './order-summary-line'

const ORDER_ID = '8f0f2c4e-6a54-4a3c-9d1c-0d9f5f3a1b11'
const USER_ID = '2b6f1a9e-3c0d-4e8a-8f5b-7a1d9c4e2f10'
const line = {
  event: OrderSummaryEvents.CREATED,
  orderId: ORDER_ID,
  orderNumber: 'ORD-1001',
  status: OrderStatus.PENDING_CONFIRMATION,
  totalCents: 4800,
  currency: 'USD',
  itemCount: 2,
  actor: { type: 'user' as const, id: USER_ID }
}

function fakeTx(conversationExists: boolean) {
  const create = jest.fn<Promise<unknown>, [{ data: unknown }]>().mockResolvedValue({})
  const findFirst = jest.fn().mockResolvedValue(conversationExists ? { id: 'c' } : null)
  return {
    create,
    findFirst,
    tx: { conversation: { findFirst }, message: { create } } as unknown as PrismaTransaction
  }
}

describe('orderSummaryLineSchema', () => {
  it('takes a creation line and a status change line', () => {
    expect(orderSummaryLineSchema.safeParse({ ...line, previousStatus: null }).success).toBe(true)
    expect(
      orderSummaryLineSchema.safeParse({
        ...line,
        event: OrderSummaryEvents.STATUS_CHANGED,
        status: OrderStatus.CONFIRMED,
        previousStatus: OrderStatus.PENDING_CONFIRMATION
      }).success
    ).toBe(true)
  })

  it.each([
    ['an unknown event', { event: 'exploded' }],
    ['a status that does not exist', { status: 'LOST' }],
    ['a fractional total', { totalCents: 10.5 }],
    ['a negative total', { totalCents: -1 }],
    ['a currency that is not three letters', { currency: 'DOLLARS' }],
    ['an id that is not a UUID', { orderId: 'ORD-1' }],
    ['a note beside the figures', { packingNotes: 'wrap it twice' }],
    ['an internal note beside the figures', { internalNotes: 'owes us' }],
    ['an empty order number', { orderNumber: '' }],
    ['a negative item count', { itemCount: -1 }],
    ['a name inside the actor', { actor: { type: 'user', id: USER_ID, name: 'Ana' } }],
    ['a phone inside the actor', { actor: { type: 'user', id: USER_ID, phone: '7123' } }]
  ])('refuses %s', (_name, patch) => {
    expect(
      orderSummaryLineSchema.safeParse({ ...line, previousStatus: null, ...patch }).success
    ).toBe(false)
  })
})

describe('writeOrderSummaryLine', () => {
  it('writes an ORDER_SUMMARY message by the system, with no text, in the store of the call', async () => {
    const { tx, create, findFirst } = fakeTx(true)
    await writeOrderSummaryLine(tx, 'store-1', 'conv-1', line)
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'conv-1', storeId: 'store-1' },
      select: { id: true }
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0].data).toEqual({
      storeId: 'store-1',
      conversationId: 'conv-1',
      type: MessageType.ORDER_SUMMARY,
      authorType: AuthorType.SYSTEM,
      content: null,
      metadata: { ...line, previousStatus: null }
    })
  })

  it('writes a status change by the system, and takes an undefined previous status as none', async () => {
    const { tx, create } = fakeTx(true)
    const changed = {
      ...line,
      event: OrderSummaryEvents.STATUS_CHANGED,
      status: OrderStatus.CONFIRMED,
      previousStatus: OrderStatus.PENDING_CONFIRMATION,
      actor: { type: 'system' as const, id: null }
    }
    expect(await writeOrderSummaryLine(tx, 's', 'c', changed)).toBe(true)
    expect(create.mock.calls[0]?.[0].data).toMatchObject({ metadata: changed })
    // A creation whose caller passes `previousStatus: undefined` still writes
    expect(await writeOrderSummaryLine(tx, 's', 'c', { ...line, previousStatus: undefined })).toBe(
      true
    )
    expect(create.mock.calls[1]?.[0].data).toMatchObject({ metadata: { previousStatus: null } })
  })

  it('writes nothing for a conversation that is not of the store, and says so', async () => {
    const { tx, create } = fakeTx(false)
    expect(await writeOrderSummaryLine(tx, 'store-1', 'conv-of-another-store', line)).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a shape the thread could not read before it touches the database', async () => {
    const { tx, create, findFirst } = fakeTx(true)
    await expect(
      writeOrderSummaryLine(tx, 's', 'c', { ...line, totalCents: 1.5 })
    ).rejects.toThrow()
    expect(findFirst).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
