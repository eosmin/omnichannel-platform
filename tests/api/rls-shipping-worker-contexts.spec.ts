import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { CarrierId, GuideMovementKind, PickupStatus, ShipmentStatus } from '@platform/core/domain'
import {
  PickupSync,
  PickupSyncOutcomes,
  ShipmentCancellation,
  VoidSettlements
} from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import {
  buildFakeCarrier,
  createCarrierConnection,
  createGuideOn,
  type FakeCarrier,
  FakeCarrierBehaviors
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const CREATED = 201

// RLS phase 5, C3: the job that voids a guide (`ShipmentCancellation.settle`) and the job that asks for a pickup (`PickupSync.run`) mix
// database work with a call to the carrier. With the guard of PrismaService ON (a query behind row security with no context throws),
// each must work because every database section opens a short context of the store, and the carrier must be called with NO context
// open (no connection is held while it answers). A carrier that fails leaves the row where it was, and the retry settles it once.
describe('RLS phase 5: the carrier jobs call the carrier outside any context', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let fake: FakeCarrier
  let registry: CarrierRegistry
  let cancellation: ShipmentCancellation
  let sync: PickupSync
  let connectionId = ''
  let serviceCode = ''
  // Whether a tenant context was open at the moment each call to the carrier was made
  const opened: { call: string; tenantOpen: boolean }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(CarrierRegistry, { strict: false })
    cancellation = app.get(ShipmentCancellation, { strict: false })
    sync = app.get(PickupSync, { strict: false })
    fake = buildFakeCarrier({
      id: CarrierId.FORZA,
      cancel: true,
      pickupRequest: true,
      pickupModify: true,
      pickupCancel: true
    })
    const cancel = fake.plugin.cancelShipment?.bind(fake.plugin)
    const requestPickup = fake.plugin.requestPickup?.bind(fake.plugin)
    if (cancel === undefined || requestPickup === undefined) {
      throw new Error('the fake carrier voids guides and asks for pickups')
    }
    registry.register({
      ...fake.plugin,
      cancelShipment: (context, params) => {
        opened.push({ call: 'cancelShipment', tenantOpen: guarded.hasTenantContext() })
        return cancel(context, params)
      },
      requestPickup: (context, params) => {
        opened.push({ call: 'requestPickup', tenantOpen: guarded.hasTenantContext() })
        return requestPickup(context, params)
      }
    })
    const connection = await createCarrierConnection(owner, {
      storeId: ctx.storeA.id,
      carrierId: CarrierId.FORZA
    })
    connectionId = connection.id
    serviceCode = connection.serviceCode
    await owner.carrierConnection.update({
      where: { id: connectionId },
      data: { pickupEnabled: true, pickupDays: [1, 2, 3, 4, 5, 6, 7], pickupCutoffTime: null }
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    opened.length = 0
    fake.state.guides.clear()
    fake.state.pickups.clear()
    fake.state.calls.length = 0
    fake.state.cancel = FakeCarrierBehaviors.OK
    fake.state.pickup = FakeCarrierBehaviors.OK
    // Nothing is left over from an earlier case
    await owner.shipment.updateMany({
      where: { connectionId },
      data: { pickupId: null, status: ShipmentStatus.CANCELLED }
    })
    await owner.pickupRequest.updateMany({
      where: { connectionId },
      data: { status: PickupStatus.CANCELLED }
    })
  })

  const guide = () =>
    createGuideOn(owner, { storeId: ctx.storeA.id, connectionId, serviceCode, packageCount: 1 })
  const settle = (shipmentId: string, lastAttempt = false) =>
    cancellation.settle(ctx.storeA.id, shipmentId, carrierId => registry.find(carrierId), {
      actor: { type: 'user', id: ctx.adminA.id },
      lastAttempt
    })
  const runSync = (pickupId: string, lastAttempt = false) =>
    sync.run(ctx.storeA.id, pickupId, carrierId => registry.find(carrierId), lastAttempt)
  const shipmentRow = (id: string) => owner.shipment.findUniqueOrThrow({ where: { id } })
  const pickupRow = (id: string) => owner.pickupRequest.findUniqueOrThrow({ where: { id } })
  const refunds = (shipmentId: string) =>
    owner.carrierGuideMovement.count({
      where: { shipmentId, storeId: ctx.storeA.id, kind: GuideMovementKind.REFUND }
    })
  async function pending() {
    const made = await guide()
    await owner.shipment.update({
      where: { id: made.id },
      data: { status: ShipmentStatus.CANCEL_PENDING, cancelRequestedAt: new Date() }
    })
    return made
  }
  async function requested(): Promise<string> {
    await guide()
    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.pickups.create)
      .send({ connectionId })
    expect(response.status).toBe(CREATED)
    return (response.body as { pickup: { id: string } }).pickup.id
  }

  it('the guard is on: a read with no context is refused, not answered with no row', async () => {
    await expect(
      guarded.client.shipment.findFirst({ where: { storeId: ctx.storeA.id } })
    ).rejects.toThrow(/no tenant context/)
  })

  describe('the job that voids a guide', () => {
    it('asks the carrier with no context open and leaves the guide cancelled', async () => {
      const made = await pending()

      expect(await settle(made.id)).toBe(VoidSettlements.CANCELLED)

      expect(opened).toEqual([{ call: 'cancelShipment', tenantOpen: false }])
      expect(await shipmentRow(made.id)).toMatchObject({ status: ShipmentStatus.CANCELLED })
    })

    it('leaves the guide waiting when the carrier does not answer, and the retry voids it once', async () => {
      const made = await pending()
      const before = await refunds(made.id)
      fake.state.cancel = FakeCarrierBehaviors.TIMEOUT_BEFORE

      expect(await settle(made.id, false)).toBe(VoidSettlements.RETRY)

      expect(await shipmentRow(made.id)).toMatchObject({ status: ShipmentStatus.CANCEL_PENDING })
      expect(await refunds(made.id)).toBe(before)
      fake.state.cancel = FakeCarrierBehaviors.OK
      expect(await settle(made.id, false)).toBe(VoidSettlements.CANCELLED)
      // A job that runs twice voids nothing twice
      const after = await refunds(made.id)
      expect(await settle(made.id, false)).toBe(VoidSettlements.SKIPPED)

      expect(await refunds(made.id)).toBe(after)
      expect(await shipmentRow(made.id)).toMatchObject({ status: ShipmentStatus.CANCELLED })
      expect(opened.map(entry => entry.tenantOpen)).toEqual([false, false])
      expect(fake.callsTo('cancelShipment')).toHaveLength(2)
    })
  })

  describe('the job that asks for a pickup', () => {
    it('asks the carrier with no context open and leaves the pickup requested', async () => {
      const pickupId = await requested()

      expect(await runSync(pickupId)).toBe(PickupSyncOutcomes.DONE)

      expect(opened).toEqual([{ call: 'requestPickup', tenantOpen: false }])
      const row = await pickupRow(pickupId)
      expect(row.status).toBe(PickupStatus.REQUESTED)
      expect(row.providerPickupId).not.toBeNull()
    })

    it('leaves the pickup waiting when the carrier does not answer, and the retry asks once more', async () => {
      const pickupId = await requested()
      fake.state.pickup = FakeCarrierBehaviors.TIMEOUT_BEFORE

      expect(await runSync(pickupId, false)).toBe(PickupSyncOutcomes.RETRY)

      // Not half way: no reference, still PENDING, its guides still hold it
      expect(await pickupRow(pickupId)).toMatchObject({
        status: PickupStatus.PENDING,
        providerPickupId: null
      })
      expect(await owner.shipment.count({ where: { pickupId } })).toBe(1)
      fake.state.pickup = FakeCarrierBehaviors.OK
      expect(await runSync(pickupId, false)).toBe(PickupSyncOutcomes.DONE)

      expect((await pickupRow(pickupId)).status).toBe(PickupStatus.REQUESTED)
      expect(opened.map(entry => entry.tenantOpen)).toEqual([false, false])
      expect(fake.callsTo('requestPickup')).toHaveLength(2)
    })
  })
})
