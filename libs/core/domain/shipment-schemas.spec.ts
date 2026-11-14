import {
  bulkLabelsSchema,
  createShipmentSchema,
  mergeLabelsSchema,
  setShipmentStatusSchema
} from './shipment-schemas'
import {
  BulkLabelLimits,
  ShipmentPrintableStatuses,
  ManualShipmentStatuses,
  ShipmentInactiveStatuses,
  ShipmentPastPickupStatuses,
  ShipmentUnknownOutcomeStatuses,
  returnShipmentIdempotencyKey,
  shipmentIdempotencyKey
} from './shipping-constants'
import { ShipmentStatus, ShippingPayer } from './status-enums'

const ID = '2b7f1c1e-5f0d-4c3e-9d3a-0f6f1d2a3b4c'

describe('the body that makes a guide', () => {
  it('takes nothing, or what the agent chooses', () => {
    expect(createShipmentSchema.safeParse({}).success).toBe(true)
    const parsed = createShipmentSchema.safeParse({
      connectionId: ID,
      serviceCode: 'standard',
      shippingPayer: ShippingPayer.RECIPIENT,
      originWarehouseId: ID,
      locationIds: { departmentId: '1', municipalityId: '2' },
      pickup: { date: '2026-12-01', from: '09:00', to: '12:00' },
      notes: '  ring twice '
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.notes).toBe('ring twice')
  })

  it.each([
    [{ storeId: ID }],
    [{ codAmountCents: 1 }],
    [{ status: 'delivered' }],
    [{ guideNumber: 'X-1' }],
    [{ connectionId: 'not-a-uuid' }],
    [{ shippingPayer: 'nobody' }],
    [{ pickup: { date: '1 December', from: '09:00', to: '12:00' } }],
    [{ pickup: { date: '2026-12-01', from: '12:00', to: '09:00' } }],
    [{ pickup: { date: '2026-12-01', from: '9am', to: '12:00' } }],
    [{ pickup: { date: '2026-13-45', from: '09:00', to: '12:00' } }],
    [{ pickup: { date: '2026-02-31', from: '09:00', to: '12:00' } }],
    [{ notes: 'a\u0000b' }],
    [{ notes: 'x'.repeat(501) }]
  ])('refuses %j', body => {
    expect(createShipmentSchema.safeParse(body).success).toBe(false)
  })
})

describe('the body that sets a status by hand', () => {
  it('takes the statuses an agent may set, with a guide number for label_created', () => {
    for (const status of ManualShipmentStatuses) {
      expect(setShipmentStatusSchema.safeParse({ status }).success).toBe(true)
    }
    expect(
      setShipmentStatusSchema.safeParse({
        status: ShipmentStatus.LABEL_CREATED,
        guideNumber: 'ABC-1',
        description: 'found',
        occurredAt: '2026-11-11T10:00:00Z'
      }).success
    ).toBe(true)
  })

  it.each([
    [{ status: ShipmentStatus.CREATING }],
    [{ status: ShipmentStatus.CANCELLED }],
    [{ status: ShipmentStatus.CANCEL_PENDING }],
    [{ status: ShipmentStatus.REQUIRES_REVIEW }],
    [{}],
    [{ status: ShipmentStatus.DELIVERED, storeId: ID }],
    [{ status: ShipmentStatus.DELIVERED, occurredAt: 'yesterday' }],
    [{ status: ShipmentStatus.DELIVERED, occurredAt: '2999-01-01T00:00:00Z' }],
    [{ status: ShipmentStatus.LABEL_CREATED, guideNumber: 'two\nlines' }]
  ])('refuses %j', body => {
    expect(setShipmentStatusSchema.safeParse(body).success).toBe(false)
  })
})

describe('the sets of statuses the engine reads', () => {
  it('never overlap where they would contradict', () => {
    for (const status of ShipmentUnknownOutcomeStatuses) {
      expect(ShipmentInactiveStatuses).not.toContain(status)
      expect(ShipmentPastPickupStatuses).not.toContain(status)
    }
    // A package that came back holds nothing, and a delivered one still holds its order
    expect(ShipmentInactiveStatuses).toContain(ShipmentStatus.RETURNED)
    expect(ShipmentInactiveStatuses).not.toContain(ShipmentStatus.DELIVERED)
    expect(ShipmentInactiveStatuses).not.toContain(ShipmentStatus.CANCEL_PENDING)
    expect(ShipmentInactiveStatuses).not.toContain(ShipmentStatus.CANCEL_FAILED)
  })
})

describe('the key a guide is asked for with', () => {
  it('is the same for the same order, origin and attempt, and differs by any of them', () => {
    expect(shipmentIdempotencyKey('o1', 'w1', 1)).toBe(shipmentIdempotencyKey('o1', 'w1', 1))
    const keys = new Set([
      shipmentIdempotencyKey('o1', 'w1', 1),
      shipmentIdempotencyKey('o2', 'w1', 1),
      shipmentIdempotencyKey('o1', 'w2', 1),
      shipmentIdempotencyKey('o1', 'w1', 2),
      shipmentIdempotencyKey('o1', null, 1)
    ])
    expect(keys.size).toBe(5)
  })
})

describe('the key a return guide is asked for with', () => {
  it('is the same for the same return and attempt, and differs by either, and never meets an outbound key', () => {
    expect(returnShipmentIdempotencyKey('r1', 1)).toBe(returnShipmentIdempotencyKey('r1', 1))
    expect(returnShipmentIdempotencyKey('r1', 1)).not.toBe(returnShipmentIdempotencyKey('r1', 2))
    expect(returnShipmentIdempotencyKey('r1', 1)).not.toBe(returnShipmentIdempotencyKey('r2', 1))
    expect(returnShipmentIdempotencyKey('r1', 1)).not.toBe(shipmentIdempotencyKey('r1', null, 1))
  })
})

const OTHER_ID = '3c8a2d2f-6a1e-4d4f-8e4b-1a7a2e3b4c5d'

describe('the body of a bulk run of labels', () => {
  it('takes the orders in the order selected, and nothing else it may use', () => {
    const parsed = bulkLabelsSchema.safeParse({
      orderIds: [OTHER_ID, ID],
      connectionId: ID,
      pickup: { date: '2026-12-01', from: '09:00', to: '12:00' }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.orderIds).toEqual([OTHER_ID, ID])
    expect(bulkLabelsSchema.safeParse({ orderIds: [ID] }).success).toBe(true)
  })

  it.each([
    ['no order', { orderIds: [] }],
    ['no list', {}],
    ['an id that is not one', { orderIds: ['nope'] }],
    ['an order twice', { orderIds: [ID, ID] }],
    ['the store', { orderIds: [ID], storeId: OTHER_ID }],
    ['a field of a guide', { orderIds: [ID], notes: 'x' }],
    [
      'a pickup that ends before it starts',
      { orderIds: [ID], pickup: { date: '2026-12-01', from: '12:00', to: '09:00' } }
    ],
    [
      'a day that does not exist',
      { orderIds: [ID], pickup: { date: '2026-02-31', from: '09:00', to: '12:00' } }
    ]
  ])('refuses %s', (_name, body) => {
    expect(bulkLabelsSchema.safeParse(body).success).toBe(false)
  })

  it('takes the two places of a carrier, but only together with that carrier', () => {
    const places = { departmentId: '2', municipalityId: '21' }
    expect(
      bulkLabelsSchema.safeParse({ orderIds: [ID], connectionId: ID, locationIds: places }).success
    ).toBe(true)
    // Each order would follow its own planned carrier: no pair of places could be right for all of them
    expect(bulkLabelsSchema.safeParse({ orderIds: [ID], locationIds: places }).success).toBe(false)
    for (const locationIds of [
      { departmentId: '2' },
      { municipalityId: '21' },
      { ...places, settlementId: '7' },
      { departmentId: '', municipalityId: '21' }
    ]) {
      expect(
        bulkLabelsSchema.safeParse({ orderIds: [ID], connectionId: ID, locationIds }).success
      ).toBe(false)
    }
  })

  it('takes a hundred orders and not a hundred and one', () => {
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      )
    expect(bulkLabelsSchema.safeParse({ orderIds: ids(BulkLabelLimits.MAX_ORDERS) }).success).toBe(
      true
    )
    expect(
      bulkLabelsSchema.safeParse({ orderIds: ids(BulkLabelLimits.MAX_ORDERS + 1) }).success
    ).toBe(false)
  })
})

describe('the body that prints labels', () => {
  it('takes shipments, once each, in the order of the pages', () => {
    expect(mergeLabelsSchema.safeParse({ shipmentIds: [OTHER_ID, ID] }).data?.shipmentIds).toEqual([
      OTHER_ID,
      ID
    ])
    expect(mergeLabelsSchema.safeParse({ shipmentIds: [] }).success).toBe(false)
    expect(mergeLabelsSchema.safeParse({ shipmentIds: [ID, ID] }).success).toBe(false)
    expect(mergeLabelsSchema.safeParse({ shipmentIds: [ID], storeId: OTHER_ID }).success).toBe(
      false
    )
  })
})

describe('the statuses whose label is printed', () => {
  it('leave out every status in which no guide is known to exist or it was voided', () => {
    for (const status of [
      ShipmentStatus.CREATING,
      ShipmentStatus.REQUIRES_REVIEW,
      ShipmentStatus.CANCEL_PENDING,
      ShipmentStatus.CANCEL_FAILED,
      ShipmentStatus.CANCELLED,
      ShipmentStatus.FAILED
    ]) {
      expect(ShipmentPrintableStatuses).not.toContain(status)
    }
    expect(ShipmentPrintableStatuses).toContain(ShipmentStatus.LABEL_CREATED)
  })
})
