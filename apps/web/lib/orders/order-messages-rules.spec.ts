import { OrderMessageKind, OrderStatus } from '@platform/core/domain'

import {
  knownKind,
  knownReason,
  knownRoute,
  MANUAL_MESSAGE_KINDS,
  messageKindOfStatus,
  notifyStartsOn
} from './order-messages-rules'

describe('MANUAL_MESSAGE_KINDS', () => {
  it('leaves out the kinds that need the package of a return or a replacement', () => {
    expect(MANUAL_MESSAGE_KINDS).toContain(OrderMessageKind.ORDER_SUMMARY)
    expect(MANUAL_MESSAGE_KINDS).toContain(OrderMessageKind.ORDER_SHIPPED)
    expect(MANUAL_MESSAGE_KINDS).not.toContain(OrderMessageKind.RETURN_APPROVED)
    expect(MANUAL_MESSAGE_KINDS).not.toContain(OrderMessageKind.EXCHANGE_SHIPPED)
  })
})

describe('known values', () => {
  it('answers null for a kind, reason or route of a newer server', () => {
    expect(knownKind('order_shipped')).toBe(OrderMessageKind.ORDER_SHIPPED)
    expect(knownKind('order_teleported')).toBeNull()
    expect(knownReason('missing_variable')).toBe('missing_variable')
    expect(knownReason('mystery')).toBeNull()
    expect(knownRoute('email')).toBe('email')
    expect(knownRoute('carrier_pigeon')).toBeNull()
  })
})

describe('the notify box of a status change', () => {
  it('exists for shipped, delivered and cancelled only', () => {
    expect(messageKindOfStatus(OrderStatus.SHIPPED)).toBe(OrderMessageKind.ORDER_SHIPPED)
    expect(messageKindOfStatus(OrderStatus.DELIVERED)).toBe(OrderMessageKind.ORDER_DELIVERED)
    expect(messageKindOfStatus(OrderStatus.CANCELLED)).toBe(OrderMessageKind.ORDER_CANCELLED)
    expect(messageKindOfStatus(OrderStatus.PREPARING)).toBeUndefined()
    expect(messageKindOfStatus(undefined)).toBeUndefined()
  })

  it('starts on only when a template of the kind goes by itself', () => {
    const templates = [
      { kind: OrderMessageKind.ORDER_SHIPPED, autoSend: true },
      { kind: OrderMessageKind.ORDER_DELIVERED, autoSend: false }
    ]
    expect(notifyStartsOn(templates, OrderMessageKind.ORDER_SHIPPED)).toBe(true)
    expect(notifyStartsOn(templates, OrderMessageKind.ORDER_DELIVERED)).toBe(false)
    expect(notifyStartsOn(templates, OrderMessageKind.ORDER_CANCELLED)).toBe(false)
    expect(notifyStartsOn(undefined, OrderMessageKind.ORDER_SHIPPED)).toBe(false)
  })
})
