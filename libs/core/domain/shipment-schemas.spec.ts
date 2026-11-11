import { createShipmentSchema, setShipmentStatusSchema } from './shipment-schemas'
import {
  ManualShipmentStatuses,
  ShipmentInactiveStatuses,
  ShipmentPastPickupStatuses,
  ShipmentUnknownOutcomeStatuses,
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
