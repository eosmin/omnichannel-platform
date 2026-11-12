import { OrderMessageKind } from '@platform/core/domain'

import {
  encodeOrderMessageCursor,
  listOrderMessagesQuerySchema,
  sendOrderMessageQuerySchema,
  sendOrderMessageSchema
} from './order-messages.schemas'

describe('sendOrderMessageSchema', () => {
  const valid = { kind: OrderMessageKind.ORDER_SUMMARY, idempotencyKey: 'press-one-of-the-day' }

  it('takes a kind and the key of the press', () => {
    expect(sendOrderMessageSchema.parse(valid)).toEqual(valid)
  })

  it('leaves the key out for a preview, which claims nothing', () => {
    expect(sendOrderMessageSchema.parse({ kind: OrderMessageKind.ORDER_SUMMARY })).toEqual({
      kind: OrderMessageKind.ORDER_SUMMARY
    })
  })

  it('takes the kinds that are about the way back and the replacement, with the package they refer to', () => {
    const shipmentId = '2b7f1c1e-5f0d-4c3e-9d3a-0f6f1d2a3b4c'
    for (const kind of [OrderMessageKind.RETURN_APPROVED, OrderMessageKind.EXCHANGE_SHIPPED]) {
      expect(sendOrderMessageSchema.parse({ ...valid, kind, shipmentId })).toEqual({
        ...valid,
        kind,
        shipmentId
      })
    }
    expect(sendOrderMessageSchema.safeParse({ ...valid, shipmentId: 'not-a-uuid' }).success).toBe(
      false
    )
  })

  it('refuses a kind that does not exist', () => {
    expect(sendOrderMessageSchema.safeParse({ ...valid, kind: 'order_nothing' }).success).toBe(
      false
    )
  })

  it('refuses a key that is short, long or has characters outside the ones a client makes', () => {
    for (const idempotencyKey of ['short', 'x'.repeat(65), 'has space1', 'semi;colon1', '']) {
      expect(sendOrderMessageSchema.safeParse({ ...valid, idempotencyKey }).success).toBe(false)
    }
  })

  it('refuses a field it does not know, so the store or the customer can never come from the body', () => {
    expect(sendOrderMessageSchema.safeParse({ ...valid, storeId: 'x' }).success).toBe(false)
    expect(sendOrderMessageSchema.safeParse({ ...valid, to: 'a@b.c' }).success).toBe(false)
  })
})

describe('sendOrderMessageQuerySchema', () => {
  it('sends unless the preview is asked for', () => {
    expect(sendOrderMessageQuerySchema.parse({})).toEqual({ preview: false })
    expect(sendOrderMessageQuerySchema.parse({ preview: 'false' })).toEqual({ preview: false })
    expect(sendOrderMessageQuerySchema.parse({ preview: 'true' })).toEqual({ preview: true })
  })

  it('refuses any other value and any other parameter', () => {
    expect(sendOrderMessageQuerySchema.safeParse({ preview: 'yes' }).success).toBe(false)
    expect(sendOrderMessageQuerySchema.safeParse({ storeId: 'x' }).success).toBe(false)
  })
})

describe('listOrderMessagesQuerySchema', () => {
  const row = {
    createdAt: new Date('2026-11-12T10:00:00.000Z'),
    id: '2b7f1c1e-5f0d-4c3e-9d3a-0f6f1d2a3b4c'
  }

  it('takes the default page size and no cursor', () => {
    expect(listOrderMessagesQuerySchema.parse({})).toEqual({ limit: 25 })
  })

  it('reads back the cursor it made', () => {
    expect(
      listOrderMessagesQuerySchema.parse({ cursor: encodeOrderMessageCursor(row), limit: '10' })
    ).toEqual({ cursor: row, limit: 10 })
  })

  it('refuses a cursor that is not ours, a limit out of range and any other parameter', () => {
    const bad = [
      { cursor: 'nope' },
      { cursor: Buffer.from('[1,2]').toString('base64url') },
      { limit: '0' },
      { limit: '101' },
      { storeId: 'x' }
    ]
    for (const query of bad) {
      expect(listOrderMessagesQuerySchema.safeParse(query).success).toBe(false)
    }
  })
})
