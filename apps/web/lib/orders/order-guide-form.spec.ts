import {
  CarrierCapability,
  PaymentMethod,
  PaymentStatus,
  ShippingPayer
} from '@platform/core/domain'

import {
  codPreview,
  defaultConnection,
  type GuideConnection,
  guideBody,
  guideConnections,
  initialDraft,
  initialPayer,
  initialService,
  needsLocations,
  needsPickup,
  pickupOf,
  returnGuideBody,
  returnGuideConnections
} from './order-guide-form'

function connection(over: Partial<GuideConnection> = {}): GuideConnection {
  return {
    id: 'c1',
    displayName: 'Courier',
    status: 'active',
    isDefault: false,
    capabilities: [CarrierCapability.CREATE_SHIPMENT],
    defaultServiceCode: 'std',
    defaultShippingPayer: 'recipient',
    services: [
      { code: 'exp', label: 'Express', active: true },
      { code: 'std', label: 'Standard', active: true },
      { code: 'old', label: 'Old', active: false }
    ],
    ...over
  }
}

describe('which connections make a guide', () => {
  it('keeps live connections that can create a guide and leaves the others', () => {
    const list = [
      connection({ id: 'a' }),
      connection({ id: 'b', status: 'disabled' }),
      connection({ id: 'c', capabilities: [CarrierCapability.FETCH_STATUS] }),
      connection({ id: 'd', capabilities: [CarrierCapability.PICKUP_BOUND_GUIDES] }),
      connection({ id: 'e', capabilities: [CarrierCapability.INTERNAL_GUIDE] })
    ]
    expect(guideConnections(list).map(c => c.id)).toEqual(['a', 'd', 'e'])
  })

  it('offers the ones that ask for the ids of the places, and says which they are', () => {
    const needs = connection({
      id: 'n',
      capabilities: [CarrierCapability.CREATE_SHIPMENT, CarrierCapability.REQUIRES_LOCATION_IDS]
    })
    expect(guideConnections([needs, connection()]).map(c => c.id)).toEqual(['n', 'c1'])
    expect(needsLocations(needs)).toBe(true)
    expect(needsLocations(connection())).toBe(false)
  })

  it('offers the way back only to a connection that declares it', () => {
    const back = connection({ id: 'r', capabilities: [CarrierCapability.RETURN_SHIPMENT] })
    expect(returnGuideConnections([connection(), back]).map(c => c.id)).toEqual(['r'])
  })

  it('starts on the default one, else the first', () => {
    const a = connection({ id: 'a' })
    const b = connection({ id: 'b', isDefault: true })
    expect(defaultConnection([a, b])?.id).toBe('b')
    expect(defaultConnection([a])?.id).toBe('a')
    expect(defaultConnection([])).toBeUndefined()
  })
})

describe('the starting values', () => {
  it('takes the default service when it is live, else the first live one', () => {
    expect(initialService(connection())).toBe('std')
    expect(initialService(connection({ defaultServiceCode: 'old' }))).toBe('exp')
    expect(initialService(connection({ defaultServiceCode: null }))).toBe('exp')
    expect(initialService(connection({ services: [] }))).toBe('')
  })

  it('pays the sender for a free-shipping order and the way of the connection otherwise', () => {
    expect(initialPayer(connection(), true)).toBe(ShippingPayer.SENDER)
    expect(initialPayer(connection(), false)).toBe(ShippingPayer.RECIPIENT)
    expect(initialPayer(connection({ defaultShippingPayer: 'sender' }), false)).toBe(
      ShippingPayer.SENDER
    )
  })

  it('builds the first draft from the connection', () => {
    expect(initialDraft(connection(), false)).toMatchObject({
      connectionId: 'c1',
      serviceCode: 'std',
      payer: ShippingPayer.RECIPIENT
    })
    expect(initialDraft(undefined, true)).toMatchObject({
      connectionId: '',
      payer: ShippingPayer.SENDER
    })
  })
})

describe('codPreview', () => {
  const order = {
    paymentMethod: PaymentMethod.CASH_ON_DELIVERY as string,
    paymentStatus: PaymentStatus.PENDING as string,
    totalCents: 2500
  }
  it('collects the total of an unpaid cash-on-delivery order', () => {
    expect(codPreview(order)).toEqual({ collects: true, amountCents: 2500 })
  })
  it('collects nothing when there is nothing to pay, whatever the method and the payment', () => {
    expect(codPreview({ ...order, totalCents: 0 })).toEqual({ collects: false, amountCents: 0 })
  })
  it('collects nothing once paid or when prepaid', () => {
    expect(codPreview({ ...order, paymentStatus: PaymentStatus.COMPLETED }).collects).toBe(false)
    expect(codPreview({ ...order, paymentMethod: PaymentMethod.CARD }).amountCents).toBe(0)
  })
})

describe('the pickup of a pickup-bound carrier', () => {
  it('is none when nothing is written, whole when everything is, and refused when half or backwards', () => {
    expect(pickupOf({ pickupDate: '', pickupFrom: '', pickupTo: '' })).toBeUndefined()
    expect(pickupOf({ pickupDate: '2026-11-20', pickupFrom: '09:00', pickupTo: '12:00' })).toEqual({
      date: '2026-11-20',
      from: '09:00',
      to: '12:00'
    })
    expect(pickupOf({ pickupDate: '2026-11-20', pickupFrom: '09:00', pickupTo: '' })).toBeNull()
    expect(
      pickupOf({ pickupDate: '2026-11-20', pickupFrom: '12:00', pickupTo: '09:00' })
    ).toBeNull()
    expect(
      pickupOf({ pickupDate: '20/11/2026', pickupFrom: '09:00', pickupTo: '12:00' })
    ).toBeNull()
  })

  it('is asked of a carrier whose guides live in a pickup', () => {
    expect(needsPickup(connection({ capabilities: [CarrierCapability.PICKUP_BOUND_GUIDES] }))).toBe(
      true
    )
    expect(needsPickup(connection())).toBe(false)
  })
})

describe('guideBody', () => {
  const draft = initialDraft(connection(), false)

  it('sends the connection, the service and the payer that were shown', () => {
    expect(guideBody(draft, connection(), false)).toEqual({
      connectionId: 'c1',
      serviceCode: 'std',
      shippingPayer: ShippingPayer.RECIPIENT
    })
  })

  it('sends the notes trimmed and nothing for empty ones', () => {
    expect(guideBody({ ...draft, notes: ' call first ' }, connection(), false)).toMatchObject({
      notes: 'call first'
    })
    expect(guideBody({ ...draft, notes: '  ' }, connection(), false)).not.toHaveProperty('notes')
  })

  it('sends the pickup only to a carrier that takes one, and waits for a whole window', () => {
    const bound = connection({ capabilities: [CarrierCapability.PICKUP_BOUND_GUIDES] })
    const window = { pickupDate: '2026-11-20', pickupFrom: '09:00', pickupTo: '12:00' }
    expect(guideBody({ ...draft, ...window }, bound, false)).toMatchObject({
      pickup: { date: '2026-11-20' }
    })
    expect(guideBody({ ...draft, ...window }, connection(), false)).not.toHaveProperty('pickup')
    expect(guideBody({ ...draft, pickupDate: '2026-11-20' }, bound, false)).toBeNull()
  })

  it('sends the sender as payer for a free-shipping order whatever the draft holds', () => {
    expect(
      guideBody({ ...draft, payer: ShippingPayer.RECIPIENT }, connection(), true)
    ).toMatchObject({
      shippingPayer: ShippingPayer.SENDER
    })
  })

  it('is not ready without a connection', () => {
    expect(guideBody(draft, undefined, false)).toBeNull()
  })

  describe('a carrier that asks for the ids of the places', () => {
    const places = connection({
      capabilities: [CarrierCapability.CREATE_SHIPMENT, CarrierCapability.REQUIRES_LOCATION_IDS]
    })
    const started = initialDraft(places, false)

    it('starts with none chosen and waits for both', () => {
      expect(started).toMatchObject({ departmentId: '', municipalityId: '' })
      expect(guideBody(started, places, false)).toBeNull()
      expect(guideBody({ ...started, departmentId: '5' }, places, false)).toBeNull()
      expect(guideBody({ ...started, municipalityId: '9' }, places, false)).toBeNull()
    })

    it('sends both ids once chosen', () => {
      expect(
        guideBody({ ...started, departmentId: '5', municipalityId: '9' }, places, false)
      ).toMatchObject({ locationIds: { departmentId: '5', municipalityId: '9' } })
    })

    it('sends no ids to a carrier that does not ask for them, whatever the draft holds', () => {
      expect(
        guideBody({ ...draft, departmentId: '5', municipalityId: '9' }, connection(), false)
      ).not.toHaveProperty('locationIds')
    })
  })
})

describe('returnGuideBody', () => {
  it('needs the connection, and leaves the service to the api when none was chosen', () => {
    expect(
      returnGuideBody({ connectionId: '', serviceCode: 's', warehouseId: '', notes: '' })
    ).toBeNull()
    expect(
      returnGuideBody({ connectionId: 'c', serviceCode: '', warehouseId: '', notes: '' })
    ).toEqual({
      connectionId: 'c'
    })
  })
  it('names the warehouse and the notes only when given', () => {
    expect(
      returnGuideBody({ connectionId: 'c', serviceCode: 's', warehouseId: 'w', notes: ' x ' })
    ).toEqual({
      connectionId: 'c',
      serviceCode: 's',
      warehouseId: 'w',
      notes: 'x'
    })
    expect(
      returnGuideBody({ connectionId: 'c', serviceCode: 's', warehouseId: '', notes: '' })
    ).toEqual({
      connectionId: 'c',
      serviceCode: 's'
    })
  })
})
