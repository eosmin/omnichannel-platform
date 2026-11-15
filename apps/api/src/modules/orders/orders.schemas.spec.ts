import { randomUUID } from 'node:crypto'

import { OrderStatus, PaymentMethod, PaymentStatus } from '@platform/core/domain'

import {
  pluginCancelOrderSchema,
  pluginChangeOrderStatusSchema,
  pluginCreateOrderSchema,
  pluginRecordOrderPaymentSchema,
  pluginUpdateOrderSchema
} from './orders.schemas'

const customerId = randomUUID()
const productId = randomUUID()
const create = {
  customerId,
  items: [{ productId, quantity: 1 }],
  paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
  recipientPhones: ['71234567']
}

const refusedFields = (result: {
  success: boolean
  error?: { issues: { path: PropertyKey[] }[] }
}) => [...new Set((result.error?.issues ?? []).map(issue => String(issue.path[0])))].sort()

describe('what a plugin may write of an order', () => {
  it('accepts the body of a person where it holds nothing a plugin must not write', () => {
    expect(pluginCreateOrderSchema.safeParse(create).success).toBe(true)
    expect(pluginUpdateOrderSchema.safeParse({ shippingCents: 5 }).success).toBe(true)
    expect(pluginChangeOrderStatusSchema.safeParse({ status: OrderStatus.PREPARING }).success).toBe(
      true
    )
    expect(
      pluginRecordOrderPaymentSchema.safeParse({
        method: PaymentMethod.TRANSFER,
        status: PaymentStatus.COMPLETED
      }).success
    ).toBe(true)
  })

  it('refuses, at creation, the notes of the team, a conversation and the summary flag', () => {
    const result = pluginCreateOrderSchema.safeParse({
      ...create,
      internalNotes: 'x',
      packingNotes: 'x',
      conversationId: randomUUID(),
      sendConfirmationMessage: true,
      copiedFromOrderId: randomUUID()
    })

    expect(result.success).toBe(false)
    expect(refusedFields(result)).toEqual([
      'conversationId',
      'copiedFromOrderId',
      'internalNotes',
      'packingNotes',
      'sendConfirmationMessage'
    ])
  })

  it('refuses, at an edit, the notes of the team and the tracking number, and still refuses an unknown field', () => {
    const refused = pluginUpdateOrderSchema.safeParse({
      internalNotes: 'x',
      packingNotes: null,
      trackingNumber: 'ABC',
      customerNotes: null
    })
    const unknown = pluginUpdateOrderSchema.safeParse({ shippingCents: 1, createdBy: 'user-1' })

    expect(refusedFields(refused)).toEqual([
      'customerNotes',
      'internalNotes',
      'packingNotes',
      'trackingNumber'
    ])
    expect(unknown.success).toBe(false)
  })

  it('keeps the rules of the schemas of the people: nothing to change, and the reason of a cancellation', () => {
    expect(pluginUpdateOrderSchema.safeParse({}).success).toBe(false)
    expect(pluginChangeOrderStatusSchema.safeParse({ status: OrderStatus.CANCELLED }).success).toBe(
      false
    )
  })

  it('refuses a file a person uploaded: the proof of a delivery and the receipt of a payment', () => {
    const proof = pluginChangeOrderStatusSchema.safeParse({
      status: OrderStatus.DELIVERED,
      proofOfDeliveryMediaId: randomUUID()
    })
    const receipt = pluginRecordOrderPaymentSchema.safeParse({
      method: PaymentMethod.TRANSFER,
      status: PaymentStatus.COMPLETED,
      proofMediaId: randomUUID()
    })

    expect(refusedFields(proof)).toEqual(['proofOfDeliveryMediaId'])
    expect(refusedFields(receipt)).toEqual(['proofMediaId'])
  })

  it('refuses the flag that tells the customer, in a status and in a cancellation: only a person triggers that message', () => {
    const status = pluginChangeOrderStatusSchema.safeParse({
      status: OrderStatus.PREPARING,
      notifyCustomer: true
    })
    const cancel = pluginCancelOrderSchema.safeParse({
      cancellationReason: 'no',
      notifyCustomer: false
    })

    expect(refusedFields(status)).toEqual(['notifyCustomer'])
    expect(refusedFields(cancel)).toEqual(['notifyCustomer'])
    expect(pluginCancelOrderSchema.safeParse({ cancellationReason: 'no' }).success).toBe(true)
  })
})
