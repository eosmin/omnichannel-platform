import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  CodStatus,
  commissionCents,
  OrderStatus,
  PaymentMethod,
  ShipmentStatus,
  ShippingPayer,
  ShippingPlugin
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { CarrierRegistry } from '@platform/plugins/runtime'
import type { CarrierFeeSettings } from '@platform/plugins/sdk'

import {
  buildFakeCarrier,
  createInventoryLevel,
  createOrder,
  FAKE_CARRIER_API_KEY
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404

const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }

interface ErrorBody {
  error: { code: string }
}
interface ConnectionBody {
  id: string
  commissionBps: number | null
  serviceRatesCents: Record<string, number>
}

// What a carrier says the owner can agree with it: a commission and a price for a collected guide and for any other
const FEES: CarrierFeeSettings = {
  commission: true,
  rateServices: [
    { code: 'COLLECTED', labelKey: 'settings.carriers.rates.test.collected' },
    { code: 'PAID', labelKey: 'settings.carriers.rates.test.paid' }
  ],
  rateServiceOf: guide => (guide.cod ? 'COLLECTED' : 'PAID')
}

// Step 4.15 (PR 6): the commission and the rates per service of a connection are fields the carrier declares, kept with money rules
// (whole basis points and cents, in range, only for what the carrier declared), audited with their old and new value, and what a
// guide kept of them decides what a delivered cash-on-delivery guide is expected to bring (FUNC-H4).
describe('Settings → Carriers: commission and rates', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const registry = app.get(CarrierRegistry, { strict: false })
    // Forza's id stands for the carrier that prices things; C807's, for one that declares nothing
    registry.register(
      buildFakeCarrier({ id: CarrierId.FORZA, feeSettings: FEES, reportsCost: false }).plugin
    )
    registry.register(buildFakeCarrier({ id: CarrierId.C807, mode: 'pickup_bound' }).plugin)
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    const installed = await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: ShippingPlugin.ID })
    expect(installed.status).toBe(CREATED)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const connect = (carrierId: string, over: Record<string, unknown> = {}) =>
    asAdmin()
      .post(ApiRoutes.carriers.create)
      .send({
        carrierId,
        credentials: { apiKey: FAKE_CARRIER_API_KEY },
        displayName: `${prefix}-carrier-${(counter += 1)}`,
        ...over
      })
  const made = (response: { status: number; body: unknown }): ConnectionBody => {
    expect(response.status).toBe(CREATED)
    return response.body as ConnectionBody
  }
  const edit = (id: string, body: Record<string, unknown>) =>
    asAdmin().patch(ApiRoutes.carriers.byId(id)).send(body)

  describe('what the carrier declares', () => {
    it('reaches the registry answer, and is empty for a carrier that declares nothing', async () => {
      const entries = (await asAdmin().get(ApiRoutes.carriers.registry)).body as {
        id: string
        feeSettings: { commission: boolean; rateServices: { code: string; labelKey: string }[] }
      }[]
      expect(entries.find(entry => entry.id === CarrierId.FORZA)?.feeSettings).toEqual({
        commission: true,
        rateServices: FEES.rateServices
      })
      expect(entries.find(entry => entry.id === CarrierId.C807)?.feeSettings).toEqual({
        commission: false,
        rateServices: []
      })
      expect(entries.find(entry => entry.id === CarrierId.LOCAL)?.feeSettings).toEqual({
        commission: false,
        rateServices: []
      })
    })
  })

  describe('connecting and editing', () => {
    it('keeps the commission and the rates it was given, and shows them back', async () => {
      const body = made(
        await connect(CarrierId.FORZA, {
          commissionBps: 450,
          serviceRatesCents: { COLLECTED: 300, PAID: 0 }
        })
      )
      expect(body.commissionBps).toBe(450)
      expect(body.serviceRatesCents).toEqual({ COLLECTED: 300, PAID: 0 })
      const row = await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.commissionBps).toBe(450)
      expect(row.serviceRatesCents).toEqual({ COLLECTED: 300, PAID: 0 })
      const read = await asAdmin().get(ApiRoutes.carriers.byId(body.id))
      expect((read.body as ConnectionBody).commissionBps).toBe(450)
    })

    it('starts with none, and an edit changes only what it sends', async () => {
      const body = made(await connect(CarrierId.FORZA))
      expect(body.commissionBps).toBeNull()
      expect(body.serviceRatesCents).toEqual({})
      const first = (await edit(body.id, { commissionBps: 500 })).body as ConnectionBody
      expect(first.commissionBps).toBe(500)
      const second = (await edit(body.id, { serviceRatesCents: { COLLECTED: 250 } }))
        .body as ConnectionBody
      expect(second.commissionBps).toBe(500)
      expect(second.serviceRatesCents).toEqual({ COLLECTED: 250 })
      const cleared = (await edit(body.id, { commissionBps: null, serviceRatesCents: null }))
        .body as ConnectionBody
      expect(cleared.commissionBps).toBeNull()
      expect(cleared.serviceRatesCents).toEqual({})
    })

    it.each([
      ['a fraction of a basis point', { commissionBps: 4.5 }],
      ['a negative commission', { commissionBps: -1 }],
      ['a commission over the limit', { commissionBps: 5001 }],
      ['a rate with a fraction of a cent', { serviceRatesCents: { COLLECTED: 1.5 } }],
      ['a negative rate', { serviceRatesCents: { COLLECTED: -1 } }],
      ['a rate over the limit', { serviceRatesCents: { COLLECTED: 100_000_001 } }],
      ['a rate for a service the carrier did not declare', { serviceRatesCents: { OTHER: 100 } }],
      ['a rate under a key that is not a code', { serviceRatesCents: { 'a b': 100 } }]
    ])('refuses %s, on connect and on edit, and keeps what was there', async (_name, bad) => {
      expect((await connect(CarrierId.FORZA, bad)).status).toBe(BAD_REQUEST)
      const body = made(await connect(CarrierId.FORZA, { commissionBps: 300 }))
      const response = await edit(body.id, bad)
      expect(response.status).toBe(BAD_REQUEST)
      expect([ErrorCodes.VALIDATION_INVALID_INPUT, ErrorCodes.VALIDATION_FAILED]).toContain(
        codeOf(response.body)
      )
      const row = await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.commissionBps).toBe(300)
    })

    it('refuses a commission or a rate for a carrier that declares none', async () => {
      expect((await connect(CarrierId.C807, { commissionBps: 100 })).status).toBe(BAD_REQUEST)
      expect((await connect(CarrierId.C807, { serviceRatesCents: { CCE: 100 } })).status).toBe(
        BAD_REQUEST
      )
      const body = made(await connect(CarrierId.C807))
      expect((await edit(body.id, { commissionBps: 100 })).status).toBe(BAD_REQUEST)
      // Clearing is always allowed
      expect((await edit(body.id, { commissionBps: null, serviceRatesCents: null })).status).toBe(
        OK
      )
    })

    it('keeps a commission of 0 as none for a carrier that takes no commission, so a form that sends its default is not refused', async () => {
      const body = made(await connect(CarrierId.C807, { commissionBps: 0 }))
      expect(body.commissionBps).toBeNull()
      expect((await edit(body.id, { commissionBps: 0 })).status).toBe(OK)
      const row = await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.commissionBps).toBeNull()
      const priced = made(await connect(CarrierId.FORZA, { commissionBps: 0 }))
      expect(priced.commissionBps).toBe(0)
    })

    it('does not show a rate for a service the carrier no longer declares', async () => {
      const body = made(await connect(CarrierId.FORZA, { serviceRatesCents: { COLLECTED: 300 } }))
      await owner.carrierConnection.update({
        where: { id: body.id },
        data: { serviceRatesCents: { COLLECTED: 300, DROPPED: 50 } }
      })
      const read = (await asAdmin().get(ApiRoutes.carriers.byId(body.id))).body as ConnectionBody
      expect(read.serviceRatesCents).toEqual({ COLLECTED: 300 })
      // Sending the table back as it was read is accepted
      expect((await edit(body.id, { serviceRatesCents: read.serviceRatesCents })).status).toBe(OK)
    })

    it('audits each change with the old and the new value, and nothing when nothing changed', async () => {
      const body = made(await connect(CarrierId.FORZA, { commissionBps: 450 }))
      const [connected] = await waitForAuditEntries(owner, {
        action: AuditAction.CARRIER_FEES_CHANGED,
        resourceId: body.id
      })
      expect(connected?.metadata).toEqual({ commissionBps: { from: null, to: 450 } })

      await edit(body.id, { commissionBps: 450 })
      await edit(body.id, { commissionBps: 500, serviceRatesCents: { COLLECTED: 300 } })
      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.CARRIER_FEES_CHANGED, resourceId: body.id },
        2
      )
      expect(entries).toHaveLength(2)
      // The edit that changed nothing wrote nothing, also a moment later
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.CARRIER_FEES_CHANGED, resourceId: body.id }
        })
      ).toBe(2)
      expect(entries.map(entry => entry.metadata)).toContainEqual({
        commissionBps: { from: 450, to: 500 },
        serviceRatesCents: { COLLECTED: { from: null, to: 300 } }
      })
      expect(entries.every(entry => entry.storeId === ctx.storeA.id)).toBe(true)
    })

    it('needs the permission to manage carriers, and keeps one store out of another', async () => {
      const body = made(await connect(CarrierId.FORZA))
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'fees-viewer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW]
      })
      const denied = await api(app, viewer, ctx.storeA)
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ commissionBps: 100 })
      expect(denied.status).toBe(FORBIDDEN)
      const other = await asAdminB()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ commissionBps: 100 })
      expect(other.status).toBe(NOT_FOUND)
      const row = await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.commissionBps).toBeNull()
    })
  })

  describe('what a guide keeps and what it is expected to bring', () => {
    async function deliveredGuide(
      connection: ConnectionBody,
      over: { payer?: ShippingPayer; payment?: string; deducts: boolean }
    ): Promise<{ id: string; cod: number | null }> {
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.CONFIRMED,
        shippingAddress: ADDRESS,
        allocatedAt: ctx.warehouseA.id,
        paymentMethod: over.payment ?? PaymentMethod.CASH_ON_DELIVERY
      })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: order.productId,
        warehouseId: ctx.warehouseA.id,
        onHand: 5,
        reserved: 1
      })
      expect((await edit(connection.id, { remittanceDeductsFee: over.deducts })).status).toBe(OK)
      const guide = await asAdmin()
        .post(ApiRoutes.shipments.forOrder(order.id))
        .send({
          connectionId: connection.id,
          ...(over.payer === undefined ? {} : { shippingPayer: over.payer })
        })
      expect(guide.status).toBe(CREATED)
      const id = (guide.body as { id: string }).id
      const delivered = await asAdmin()
        .post(ApiRoutes.shipments.status(id))
        .send({ status: ShipmentStatus.DELIVERED })
      expect(delivered.status).toBe(OK)
      const row = await owner.shipment.findUniqueOrThrow({ where: { id } })
      return { id, cod: row.codAmountCents }
    }

    it('keeps the rate and the commission it was made under, and the later edits never rewrite them', async () => {
      const connection = made(
        await connect(CarrierId.FORZA, {
          commissionBps: 450,
          serviceRatesCents: { COLLECTED: 300, PAID: 120 }
        })
      )
      const { id, cod } = await deliveredGuide(connection, { deducts: true })
      expect(cod).not.toBeNull()
      const row = await owner.shipment.findUniqueOrThrow({ where: { id } })
      expect(row.carrierRateCents).toBe(300)
      expect(row.commissionBps).toBe(450)
      await edit(connection.id, { commissionBps: 100, serviceRatesCents: { COLLECTED: 999 } })
      const after = await owner.shipment.findUniqueOrThrow({ where: { id } })
      expect(after.carrierRateCents).toBe(300)
      expect(after.commissionBps).toBe(450)
    })

    it('expects the amount minus the rate of the service and the commission when the connection deducts (FUNC-H4)', async () => {
      const connection = made(
        await connect(CarrierId.FORZA, {
          commissionBps: 450,
          serviceRatesCents: { COLLECTED: 300 }
        })
      )
      const { id, cod } = await deliveredGuide(connection, {
        deducts: true,
        payer: ShippingPayer.SENDER
      })
      const row = await owner.shipment.findUniqueOrThrow({ where: { id } })
      // 1,999 collected: 4.5 % is 89.955, 90 cents; minus the rate of 300
      expect(cod).toBe(1999)
      expect(row.codExpectedCents).toBe(1999 - 300 - 90)
      expect(row.codExpectedCents).toBe((cod ?? 0) - 300 - commissionCents(cod ?? 0, 450))
    })

    it('takes the commission but not the rate when the recipient pays the carrier', async () => {
      const connection = made(
        await connect(CarrierId.FORZA, {
          commissionBps: 450,
          serviceRatesCents: { COLLECTED: 300 }
        })
      )
      const { id, cod } = await deliveredGuide(connection, {
        deducts: true,
        payer: ShippingPayer.RECIPIENT
      })
      const row = await owner.shipment.findUniqueOrThrow({ where: { id } })
      expect(cod).toBe(1999)
      expect(row.codExpectedCents).toBe(1999 - 90)
    })

    it('leaves the amount gross when the connection does not deduct, whatever was agreed', async () => {
      const connection = made(
        await connect(CarrierId.FORZA, {
          commissionBps: 450,
          serviceRatesCents: { COLLECTED: 300 }
        })
      )
      const { id, cod } = await deliveredGuide(connection, { deducts: false })
      const row = await owner.shipment.findUniqueOrThrow({ where: { id } })
      expect(row.codExpectedCents).toBe(cod)
    })

    it('leaves the amount gross when nothing was agreed (what happened before this change)', async () => {
      const connection = made(await connect(CarrierId.FORZA))
      const { id, cod } = await deliveredGuide(connection, { deducts: true })
      const row = await owner.shipment.findUniqueOrThrow({ where: { id } })
      expect(row.carrierRateCents).toBeNull()
      expect(row.commissionBps).toBeNull()
      expect(row.codExpectedCents).toBe(cod)
    })

    it('never goes below zero when the rate and the commission are above the amount', async () => {
      const connection = made(
        await connect(CarrierId.FORZA, {
          commissionBps: 5000,
          serviceRatesCents: { COLLECTED: 99_999_999 }
        })
      )
      const { id } = await deliveredGuide(connection, { deducts: true })
      expect((await owner.shipment.findUniqueOrThrow({ where: { id } })).codExpectedCents).toBe(0)
    })

    it('keeps no rate for a prepaid order, and the amount of a prepaid order stays empty', async () => {
      const connection = made(
        await connect(CarrierId.FORZA, {
          commissionBps: 450,
          serviceRatesCents: { COLLECTED: 300, PAID: 120 }
        })
      )
      const { id } = await deliveredGuide(connection, {
        deducts: true,
        payment: PaymentMethod.CASH
      })
      const row = await owner.shipment.findUniqueOrThrow({ where: { id } })
      expect(row.codStatus).toBe(CodStatus.NOT_APPLICABLE)
      expect(row.codExpectedCents).toBeNull()
      expect(row.carrierRateCents).toBe(120)
    })
  })
})
