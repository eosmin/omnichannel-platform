import { CarrierCapability, LabelFormat, ShipmentStatus } from '@platform/core/domain'
import {
  CarrierRejectedError,
  CarrierUnavailableError,
  PickupBatchOutcomes,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import {
  buildCarrierContext,
  buildCreateShipmentParams,
  buildFakeCarrier,
  FAKE_CARRIER_API_KEY,
  FAKE_CARRIER_SECRET,
  FakeCarrierBehaviors,
  type FakeCarrierOptions
} from '../builders/carrier-plugin'

import { testCarrierPluginContract, type CarrierTestFixtures } from './carrier-plugin.contract'

function fixturesFor(options: FakeCarrierOptions): CarrierTestFixtures {
  const webhook = buildFakeCarrier(options).signedWebhook([
    {
      id: 'evt-1',
      status: 'Delivered',
      guide: 'FAKE-000001',
      at: '2026-12-01T10:00:00.000Z'
    }
  ])
  return {
    context: buildCarrierContext(),
    createParams: buildCreateShipmentParams(),
    webhook: {
      ...webhook,
      secret: FAKE_CARRIER_SECRET,
      invalidHeaders: { 'x-signature': 'not-the-signature' },
      emptyBody: { events: [] }
    },
    secrets: [FAKE_CARRIER_API_KEY, FAKE_CARRIER_SECRET]
  }
}

// The fake is the first carrier to pass its own contract, in each shape the integration suites use
describe.each<[string, FakeCarrierOptions]>([
  ['standalone', {}],
  ['standalone, idempotent', { idempotent: true }],
  [
    'standalone with no cancel, no webhook and no polling',
    {
      cancel: false,
      webhook: false,
      fetchStatus: false
    }
  ],
  ['standalone with pickups', { pickupRequest: true, pickupModify: true, pickupCancel: true }],
  ['pickup-bound', { mode: ShipmentCreationModes.PICKUP_BOUND }],
  ['pickup-bound, idempotent', { mode: ShipmentCreationModes.PICKUP_BOUND, idempotent: true }],
  [
    'pickup-bound with PICKUP_MODIFY',
    {
      mode: ShipmentCreationModes.PICKUP_BOUND,
      pickupModify: true,
      pickupCancel: true
    }
  ]
])('the fake carrier, %s', (_label, options) => {
  testCarrierPluginContract(() => buildFakeCarrier(options).plugin, fixturesFor(options))
})

describe('the switches of the fake carrier', () => {
  const ctx = buildCarrierContext()

  it('refuses when told to, and makes no guide', async () => {
    const fake = buildFakeCarrier()
    fake.state.create = FakeCarrierBehaviors.REJECT
    await expect(
      fake.plugin.createShipment?.(ctx, buildCreateShipmentParams())
    ).rejects.toBeInstanceOf(CarrierRejectedError)
    expect(fake.state.guides.size).toBe(0)
  })

  it('times out before the carrier acted: no guide exists', async () => {
    const fake = buildFakeCarrier()
    fake.state.create = FakeCarrierBehaviors.TIMEOUT_BEFORE
    await expect(
      fake.plugin.createShipment?.(ctx, buildCreateShipmentParams())
    ).rejects.toBeInstanceOf(CarrierUnavailableError)
    expect(fake.state.guides.size).toBe(0)
  })

  it('times out after the carrier acted: a guide exists the caller never heard of', async () => {
    const fake = buildFakeCarrier()
    fake.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
    await expect(
      fake.plugin.createShipment?.(ctx, buildCreateShipmentParams())
    ).rejects.toBeInstanceOf(CarrierUnavailableError)
    expect(fake.state.guides.size).toBe(1)
    // ... and "check with the carrier" finds it by the order number
    const events = await fake.plugin.fetchStatus?.(ctx, [{ reference: 'ORD-1001' }])
    expect(events).toHaveLength(1)
    expect(events?.[0]?.guideNumber).toBe([...fake.state.guides.keys()][0])
    expect(events?.[0]?.status).toBe(ShipmentStatus.LABEL_CREATED)
  })

  it('makes a second guide for a repeated key when it is not idempotent', async () => {
    const fake = buildFakeCarrier({ idempotent: false })
    const params = buildCreateShipmentParams()
    await fake.plugin.createShipment?.(ctx, params)
    await fake.plugin.createShipment?.(ctx, params)
    expect(fake.state.guides.size).toBe(2)
  })

  it('makes one guide for a repeated key when it is idempotent', async () => {
    const fake = buildFakeCarrier({ idempotent: true })
    fake.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
    const params = buildCreateShipmentParams()
    await expect(fake.plugin.createShipment?.(ctx, params)).rejects.toBeInstanceOf(
      CarrierUnavailableError
    )
    fake.state.create = FakeCarrierBehaviors.OK
    await fake.plugin.createShipment?.(ctx, params)
    expect(fake.state.guides.size).toBe(1)
  })

  it('has no cancel method and no capability when told so', () => {
    const { plugin } = buildFakeCarrier({ cancel: false })
    expect(plugin).not.toHaveProperty('cancelShipment')
    expect(plugin.capabilities).not.toContain(CarrierCapability.CANCEL_SHIPMENT)
  })

  it('has no webhook methods and no capability when told so', () => {
    const { plugin } = buildFakeCarrier({ webhook: false })
    expect(plugin).not.toHaveProperty('handleWebhook')
    expect(plugin).not.toHaveProperty('validateWebhookSignature')
    expect(plugin.capabilities).not.toContain(CarrierCapability.WEBHOOK_STATUS)
  })

  it('fails a cancel on demand, with or without the void having happened', async () => {
    const fake = buildFakeCarrier()
    const made = await fake.plugin.createShipment?.(ctx, buildCreateShipmentParams())
    const ref = {
      reference: 'ORD-1001',
      guideNumber: made?.guideNumber ?? '',
      idempotencyKey: 'cancel-1'
    }
    fake.state.cancel = FakeCarrierBehaviors.REJECT
    await expect(fake.plugin.cancelShipment?.(ctx, ref)).rejects.toBeInstanceOf(
      CarrierRejectedError
    )
    fake.state.cancel = FakeCarrierBehaviors.TIMEOUT_AFTER
    await expect(fake.plugin.cancelShipment?.(ctx, ref)).rejects.toBeInstanceOf(
      CarrierUnavailableError
    )
    expect([...fake.state.guides.values()][0]?.voided).toBe(true)
  })

  describe('as a pickup-bound carrier', () => {
    const window = { date: '2026-12-01', from: '09:00', to: '12:00' }
    const batch = (references: string[]) => ({
      idempotencyKey: `batch-${references.join('-')}`,
      pickup: { window, packageCount: references.length },
      shipments: references.map(reference =>
        buildCreateShipmentParams({ reference, idempotencyKey: `key-${reference}` })
      )
    })

    it('returns the guide of every shipment and lets one be refused alone', async () => {
      const fake = buildFakeCarrier({ mode: ShipmentCreationModes.PICKUP_BOUND })
      fake.state.rejectReferences.add('B')
      const result = await fake.plugin.createShipmentsWithPickup?.(ctx, batch(['A', 'B', 'C']))
      expect(result?.shipments.map(e => e.outcome)).toEqual([
        PickupBatchOutcomes.CREATED,
        PickupBatchOutcomes.REJECTED,
        PickupBatchOutcomes.CREATED
      ])
      expect(fake.state.guides.size).toBe(2)
      expect(fake.state.pickups.get(result?.pickupRef ?? '')?.packageCount).toBe(2)
    })

    it('refuses a batch above its size and one it refuses whole', async () => {
      const fake = buildFakeCarrier({ mode: ShipmentCreationModes.PICKUP_BOUND, maxBatchSize: 2 })
      await expect(
        fake.plugin.createShipmentsWithPickup?.(ctx, batch(['A', 'B', 'C']))
      ).rejects.toBeInstanceOf(CarrierRejectedError)
      fake.state.rejectReferences.add('A')
      await expect(
        fake.plugin.createShipmentsWithPickup?.(ctx, batch(['A']))
      ).rejects.toBeInstanceOf(CarrierRejectedError)
    })

    it('loses the answer after acting, and the pickup still holds the guides', async () => {
      const fake = buildFakeCarrier({ mode: ShipmentCreationModes.PICKUP_BOUND })
      fake.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      await expect(
        fake.plugin.createShipmentsWithPickup?.(ctx, batch(['A', 'B']))
      ).rejects.toBeInstanceOf(CarrierUnavailableError)
      const [pickupRef] = [...fake.state.pickups.keys()]
      const found = await fake.plugin.fetchPickup?.(ctx, { pickupRef: pickupRef ?? '' })
      expect(found?.shipments.map(s => s.reference)).toEqual(['A', 'B'])
    })

    it('joins the open pickup of a date with PICKUP_MODIFY and opens another without it', async () => {
      const joining = buildFakeCarrier({
        mode: ShipmentCreationModes.PICKUP_BOUND,
        pickupModify: true
      })
      const one = await joining.plugin.createShipmentsWithPickup?.(ctx, batch(['A']))
      const two = await joining.plugin.createShipmentsWithPickup?.(ctx, batch(['B']))
      expect(two?.pickupRef).toBe(one?.pickupRef)
      expect(joining.state.pickups.get(one?.pickupRef ?? '')?.packageCount).toBe(2)

      const separate = buildFakeCarrier({ mode: ShipmentCreationModes.PICKUP_BOUND })
      const first = await separate.plugin.createShipmentsWithPickup?.(ctx, batch(['A']))
      const second = await separate.plugin.createShipmentsWithPickup?.(ctx, batch(['B']))
      expect(second?.pickupRef).not.toBe(first?.pickupRef)
    })
  })

  it('counts the packages of a pickup once when an idempotent batch is retried', async () => {
    const fake = buildFakeCarrier({ mode: ShipmentCreationModes.PICKUP_BOUND, idempotent: true })
    const params = {
      idempotencyKey: 'batch-1',
      pickup: { window: { date: '2026-12-01', from: '09:00', to: '12:00' }, packageCount: 2 },
      shipments: ['A', 'B'].map(reference =>
        buildCreateShipmentParams({ reference, idempotencyKey: `key-${reference}` })
      )
    }
    fake.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
    await expect(fake.plugin.createShipmentsWithPickup?.(ctx, params)).rejects.toBeInstanceOf(
      CarrierUnavailableError
    )
    fake.state.create = FakeCarrierBehaviors.OK
    const retried = await fake.plugin.createShipmentsWithPickup?.(ctx, params)
    expect(fake.state.guides.size).toBe(2)
    expect(fake.state.pickups.get(retried?.pickupRef ?? '')?.packageCount).toBe(2)
  })

  it('times out before acting on a batch and on a cancel: nothing happened', async () => {
    const batchFake = buildFakeCarrier({ mode: ShipmentCreationModes.PICKUP_BOUND })
    batchFake.state.create = FakeCarrierBehaviors.TIMEOUT_BEFORE
    await expect(
      batchFake.plugin.createShipmentsWithPickup?.(ctx, {
        idempotencyKey: 'b',
        pickup: { window: { date: '2026-12-01', from: '09:00', to: '12:00' }, packageCount: 1 },
        shipments: [buildCreateShipmentParams()]
      })
    ).rejects.toBeInstanceOf(CarrierUnavailableError)
    expect(batchFake.state.guides.size).toBe(0)
    expect(batchFake.state.pickups.size).toBe(0)

    const fake = buildFakeCarrier()
    const made = await fake.plugin.createShipment?.(ctx, buildCreateShipmentParams())
    fake.state.cancel = FakeCarrierBehaviors.TIMEOUT_BEFORE
    await expect(
      fake.plugin.cancelShipment?.(ctx, {
        reference: 'ORD-1001',
        guideNumber: made?.guideNumber ?? '',
        idempotencyKey: 'c'
      })
    ).rejects.toBeInstanceOf(CarrierUnavailableError)
    expect([...fake.state.guides.values()][0]?.voided).toBe(false)
  })

  it('requests, modifies and cancels a pickup, and says what it does to its state', async () => {
    const fake = buildFakeCarrier({ pickupRequest: true, pickupModify: true, pickupCancel: true })
    const window = { date: '2026-12-02', from: '09:00', to: '12:00' }
    const pickup = await fake.plugin.requestPickup?.(ctx, {
      idempotencyKey: 'p1',
      window,
      packageCount: 2
    })
    const ref = pickup?.pickupRef ?? ''
    expect(fake.state.pickups.get(ref)).toEqual({ window, packageCount: 2 })
    const modified = await fake.plugin.modifyPickup?.(ctx, { pickupRef: ref, packageCount: 5 })
    expect(modified).toEqual({ pickupRef: ref, window, packageCount: 5 })
    await expect(
      fake.plugin.modifyPickup?.(ctx, { pickupRef: 'unknown', packageCount: 1 })
    ).rejects.toBeInstanceOf(CarrierRejectedError)
    await fake.plugin.cancelPickup?.(ctx, { pickupRef: ref })
    expect(fake.state.pickups.has(ref)).toBe(false)
  })

  it('serves a label again and reports the status the carrier moved a guide to', async () => {
    const fake = buildFakeCarrier()
    const made = await fake.plugin.createShipment?.(ctx, buildCreateShipmentParams())
    const guideNumber = made?.guideNumber ?? ''
    const label = await fake.plugin.fetchLabel?.(ctx, {
      reference: 'ORD-1001',
      guideNumber,
      format: LabelFormat.PDF_A6
    })
    expect(label?.format).toBe(LabelFormat.PDF_A6)
    expect(new TextDecoder().decode(label?.data)).toContain(guideNumber)

    fake.setRawStatus(guideNumber, 'delivered')
    const [delivered] =
      (await fake.plugin.fetchStatus?.(ctx, [{ reference: 'x', guideNumber }])) ?? []
    expect(delivered?.status).toBe(ShipmentStatus.DELIVERED)
    fake.setRawStatus(guideNumber, 'info')
    const [info] = (await fake.plugin.fetchStatus?.(ctx, [{ reference: 'x', guideNumber }])) ?? []
    expect(info?.status).toBeNull()
  })

  it('signs the webhooks it sends and maps an unknown code to no status', async () => {
    const fake = buildFakeCarrier()
    const sent = fake.signedWebhook([
      { id: 'e1', status: 'mystery', guide: 'FAKE-000001', at: '2026-12-01T10:00:00.000Z' }
    ])
    expect(
      fake.plugin.validateWebhookSignature?.(sent.rawBody, sent.headers, FAKE_CARRIER_SECRET)
    ).toBe(true)
    const events = await fake.plugin.handleWebhook?.(sent.body)
    expect(events?.[0]?.status).toBeNull()
    expect(events?.[0]?.rawStatus).toBe('mystery')
  })
})
