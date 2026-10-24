import { CountStatusTransitions, TransferStatusTransitions } from './inventory-constants'
import { FailedAttemptMessagePolicy, OrderMessageVariables } from './order-constants'
import {
  CarrierReportableStatuses,
  CodStatusTransitions,
  normalizeProviderStatusCode,
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

// Table keys are plain strings, so the one status that may repeat is compared as a string too
const repeatableStatus: string = ShipmentStatus.FAILED_ATTEMPT

describe.each(tables)('%s transitions', (_name, table, statuses) => {
  it('has exactly one entry per status', () => {
    expect(Object.keys(table).sort()).toEqual([...statuses].sort())
  })

  it('only leads to known statuses and never to itself, except a repeated delivery attempt', () => {
    for (const [from, targets] of Object.entries(table)) {
      for (const to of targets) {
        expect(statuses).toContain(to)
        const isRepeatedAttempt = from === repeatableStatus && to === repeatableStatus
        if (!isRepeatedAttempt) expect(to).not.toBe(from)
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

describe('shipment status flow', () => {
  const inFlight = [
    ShipmentStatus.LABEL_CREATED,
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.FAILED_ATTEMPT
  ]

  it('can reach DELIVERED from every in-flight status, even if the carrier skips events', () => {
    for (const status of inFlight) {
      expect(ShipmentStatusTransitions[status]).toContain(ShipmentStatus.DELIVERED)
    }
  })

  it('can reach RETURNED once the package has left, even if the carrier skips RETURNING', () => {
    for (const status of inFlight.filter(s => s !== ShipmentStatus.LABEL_CREATED)) {
      expect(ShipmentStatusTransitions[status]).toContain(ShipmentStatus.RETURNED)
    }
  })

  it('never moves backwards', () => {
    expect(ShipmentStatusTransitions[ShipmentStatus.DELIVERED]).toEqual([])
    expect(ShipmentStatusTransitions[ShipmentStatus.IN_TRANSIT]).not.toContain(
      ShipmentStatus.LABEL_CREATED
    )
    expect(ShipmentStatusTransitions[ShipmentStatus.OUT_FOR_DELIVERY]).not.toContain(
      ShipmentStatus.PICKED_UP
    )
  })
})

describe('repeated delivery attempts', () => {
  it('lets a failed attempt repeat, then deliver, retry or return', () => {
    expect(ShipmentStatusTransitions[ShipmentStatus.FAILED_ATTEMPT]).toEqual([
      ShipmentStatus.FAILED_ATTEMPT,
      ShipmentStatus.OUT_FOR_DELIVERY,
      ShipmentStatus.DELIVERED,
      ShipmentStatus.RETURNING,
      ShipmentStatus.RETURNED
    ])
  })
})

describe('carrier status mapping', () => {
  it('only targets statuses a carrier can report', () => {
    for (const internal of [
      ShipmentStatus.CREATING,
      ShipmentStatus.CANCEL_PENDING,
      ShipmentStatus.CANCEL_FAILED,
      ShipmentStatus.REQUIRES_REVIEW,
      ShipmentStatus.FAILED
    ]) {
      expect(CarrierReportableStatuses).not.toContain(internal)
    }
    expect(CarrierReportableStatuses).toContain(ShipmentStatus.DELIVERED)
  })

  it('normalizes case, accents, spaces and padding to one code', () => {
    const variants = ['Entregado', 'ENTREGADO ', ' entregádo', 'entregado']
    expect(new Set(variants.map(normalizeProviderStatusCode))).toEqual(new Set(['entregado']))
    expect(normalizeProviderStatusCode('En   Ruta  de Entrega')).toBe('en ruta de entrega')
    expect(normalizeProviderStatusCode('ENT')).toBe('ent')
  })
})

describe('failed-attempt customer messages', () => {
  it('offers every attempt, the first only, or none', () => {
    expect(Object.values(FailedAttemptMessagePolicy)).toEqual([
      'every_attempt',
      'first_only',
      'none'
    ])
  })

  it('lets a template say which attempt it was and how many the carrier makes', () => {
    expect(OrderMessageVariables.ATTEMPT_NUMBER).toBe('attemptNumber')
    expect(OrderMessageVariables.MAX_ATTEMPTS).toBe('maxAttempts')
  })
})
