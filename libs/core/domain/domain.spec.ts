import { CountStatusTransitions, TransferStatusTransitions } from './inventory-constants'
import {
  CodStatusTransitions,
  OrderReturnStatusTransitions,
  PickupStatusTransitions,
  PriceApprovalTransitions,
  RemittanceStatusTransitions,
  ShipmentStatusTransitions
} from './shipping-constants'
import {
  ConversationStatus,
  ConversationStatusColors,
  ConversationStatusI18nKeys,
  ConversationStatusTransitions,
  CodStatus,
  CountStatus,
  OrderEditableFields,
  OrderStatus,
  OrderStatusColors,
  OrderStatusI18nKeys,
  OrderStatusTransitions,
  OrderReturnStatus,
  PickupStatus,
  PriceApprovalStatus,
  RemittanceStatus,
  ShipmentStatus,
  TransferStatus,
  VerificationTokenType,
  AuthorType
} from './status-enums'

type Table = Record<string, readonly string[]>

const tables: Array<[string, Table, readonly string[]]> = [
  ['order', OrderStatusTransitions, Object.values(OrderStatus)],
  ['conversation', ConversationStatusTransitions, Object.values(ConversationStatus)],
  ['shipment', ShipmentStatusTransitions, Object.values(ShipmentStatus)],
  ['return', OrderReturnStatusTransitions, Object.values(OrderReturnStatus)],
  ['price approval', PriceApprovalTransitions, Object.values(PriceApprovalStatus)],
  ['cod', CodStatusTransitions, Object.values(CodStatus)],
  ['remittance', RemittanceStatusTransitions, Object.values(RemittanceStatus)],
  ['pickup', PickupStatusTransitions, Object.values(PickupStatus)],
  ['transfer', TransferStatusTransitions, Object.values(TransferStatus)],
  ['count', CountStatusTransitions, Object.values(CountStatus)]
]

describe.each(tables)('%s transitions', (_name, table, statuses) => {
  it('has exactly one entry per status', () => {
    expect(Object.keys(table).sort()).toEqual([...statuses].sort())
  })

  it('only leads to known statuses and never to itself', () => {
    for (const [from, targets] of Object.entries(table)) {
      for (const to of targets) {
        expect(statuses).toContain(to)
        expect(to).not.toBe(from)
      }
    }
  })
})

describe('terminal states', () => {
  it('cannot be left', () => {
    expect(OrderStatusTransitions[OrderStatus.CANCELLED]).toEqual([])
    expect(OrderStatusTransitions[OrderStatus.RETURNED]).toEqual([])
    expect(ShipmentStatusTransitions[ShipmentStatus.DELIVERED]).toEqual([])
    expect(TransferStatusTransitions[TransferStatus.RECEIVED]).toEqual([])
    expect(CountStatusTransitions[CountStatus.APPLIED]).toEqual([])
    expect(RemittanceStatusTransitions[RemittanceStatus.VOIDED]).toEqual([])
  })
})

describe('order lifecycle', () => {
  it('starts at PENDING_CONFIRMATION and allows shipping straight from CONFIRMED', () => {
    expect(OrderStatusTransitions[OrderStatus.PENDING_CONFIRMATION]).toEqual([
      OrderStatus.CONFIRMED,
      OrderStatus.CANCELLED
    ])
    expect(OrderStatusTransitions[OrderStatus.CONFIRMED]).toContain(OrderStatus.SHIPPED)
  })

  it('lets an unconfirmed order be edited like a confirmed one', () => {
    expect(OrderEditableFields[OrderStatus.PENDING_CONFIRMATION]).toEqual(
      OrderEditableFields[OrderStatus.CONFIRMED]
    )
  })

  it('has a display entry for every status', () => {
    const statuses = Object.values(OrderStatus).sort()
    expect(Object.keys(OrderStatusI18nKeys).sort()).toEqual(statuses)
    expect(Object.keys(OrderStatusColors).sort()).toEqual(statuses)
    expect(Object.keys(OrderEditableFields).sort()).toEqual(statuses)
  })

  it('derives i18n keys from the status, never from a label', () => {
    expect(OrderStatusI18nKeys[OrderStatus.SHIPPED]).toBe('orders.status.SHIPPED')
    expect(Object.keys(ConversationStatusI18nKeys).sort()).toEqual(
      Object.values(ConversationStatus).sort()
    )
    expect(Object.keys(ConversationStatusColors).sort()).toEqual(
      Object.values(ConversationStatus).sort()
    )
  })
})

describe('single-owner MVP trims', () => {
  it('has no AI author and logs in by magic link only', () => {
    expect(Object.values(AuthorType)).not.toContain('ai_agent')
    expect(Object.values(VerificationTokenType)).toEqual(['magic_link', 'dsr_verification'])
  })
})
