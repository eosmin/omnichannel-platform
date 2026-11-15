import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  BenefitBase,
  BenefitLossRule,
  BenefitPeriodKind,
  BenefitRefundRule,
  GuideMovementKind,
  ShipmentEventSource,
  ShipmentStatus
} from '@platform/core/domain'
import { NotificationTypes } from '@platform/core/notifications'
import { closeBenefitPeriods, readGuidePolicy, ShipmentWrites } from '@platform/core/shipping'

import { createCarrierConnection, createShipment } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const DAY_MS = 24 * 60 * 60 * 1000

const POLICY = {
  balanceEnabled: true,
  benefitEnabled: true,
  warnOnEmptyBalance: true,
  lowBalanceThreshold: null,
  periodKind: BenefitPeriodKind.CALENDAR_MONTH,
  periodDays: 15,
  periodAnchor: '2026-01-01',
  thresholdBps: 1000,
  warnAtBps: 8000,
  base: BenefitBase.DELIVERED,
  returnStatuses: [ShipmentStatus.RETURNED],
  refundRule: BenefitRefundRule.AT_PERIOD_CLOSE,
  lossRule: BenefitLossRule.FROM_CROSSING
}

describe('The balance of prepaid guides and the refund benefit (TDD_17 §4.18)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let prisma: PrismaService
  let writes: ShipmentWrites

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    prisma = app.get(PrismaService, { strict: false })
    writes = app.get(ShipmentWrites, { strict: false })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const admin = () => api(app, ctx.adminA, ctx.storeA)
  const putPolicy = (connectionId: string, body: Record<string, unknown> = {}) =>
    admin()
      .put(ApiRoutes.carriers.guidePolicy(connectionId))
      .send({ ...POLICY, ...body })
  const buy = (connectionId: string, paidQuantity: number, totalCostCents: number, gift = 0) =>
    admin()
      .post(ApiRoutes.carriers.guidePurchases(connectionId))
      .send({ paidQuantity, giftQuantity: gift, totalCostCents })
  const balanceOf = async (connectionId: string) =>
    (await admin().get(ApiRoutes.carriers.guideBalance(connectionId))).body as {
      balance: number
      receivedGuides: number
      paidCents: number
      averageCostCents: number | null
      low: boolean
      empty: boolean
    }

  // One forward move of a shipment, written the way the engine writes it (through ShipmentWrites)
  async function move(
    shipmentId: string,
    from: ShipmentStatus,
    to: ShipmentStatus,
    occurredAt: Date = new Date()
  ): Promise<void> {
    const row = await owner.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: {
        storeId: true,
        orderId: true,
        connectionId: true,
        order: { select: { orderNumber: true } }
      }
    })
    await prisma.transaction(async tx => {
      await writes.move(
        tx,
        {
          shipmentId,
          storeId: row.storeId,
          orderId: row.orderId,
          orderNumber: row.order.orderNumber,
          connectionId: row.connectionId
        },
        from,
        to,
        {},
        { actor: { type: 'system', id: null }, source: ShipmentEventSource.SYSTEM, occurredAt }
      )
    })
  }

  // A guide of the connection made (taken from the balance) and then sent
  async function madeGuide(connectionId: string): Promise<string> {
    const { id } = await createShipment(owner, {
      storeId: ctx.storeA.id,
      connectionId,
      status: ShipmentStatus.CREATING
    })
    await move(id, ShipmentStatus.CREATING, ShipmentStatus.LABEL_CREATED)
    return id
  }

  // A package that was delivered: it counts in the base `delivered`
  async function deliveredGuide(connectionId: string): Promise<string> {
    const id = await madeGuide(connectionId)
    await move(id, ShipmentStatus.LABEL_CREATED, ShipmentStatus.DELIVERED)
    return id
  }

  async function returnedGuide(connectionId: string, at: Date): Promise<string> {
    const id = await madeGuide(connectionId)
    await move(id, ShipmentStatus.LABEL_CREATED, ShipmentStatus.RETURNING, at)
    await move(id, ShipmentStatus.RETURNING, ShipmentStatus.RETURNED, at)
    return id
  }

  const movementsOf = (connectionId: string, kind: string) =>
    owner.carrierGuideMovement.findMany({ where: { connectionId, kind } })

  async function notificationsOf(type: string, connectionId: string): Promise<number> {
    // The api tells the team after the transaction commits: give it a moment
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const count = await owner.notification.count({
        where: { storeId: ctx.storeA.id, type, resourceId: connectionId }
      })
      if (count > 0) return count
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return 0
  }

  it('records a purchase with a gift and gives the weighted average cost per guide', async () => {
    const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    // 100 paid + 10 free for 80.00: 8000 cents over 110 guides
    const first = await buy(id, 100, 8000, 10)
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ kind: 'purchase', guidesDelta: 110, costCentsDelta: 8000 })
    expect(await balanceOf(id)).toMatchObject({
      balance: 110,
      receivedGuides: 110,
      paidCents: 8000,
      averageCostCents: 73
    })
    // a second package at another price weighs in: 13000 over 160 guides
    expect((await buy(id, 50, 5000)).status).toBe(201)
    expect(await balanceOf(id)).toMatchObject({ balance: 160, averageCostCents: 81 })
  })

  it('voids a purchase once and writes a movement, never an edit', async () => {
    const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    const purchase = (await buy(id, 10, 1000)).body as { id: string }
    const voided = await admin()
      .post(ApiRoutes.carriers.guidePurchaseVoid(id, purchase.id))
      .send({ note: 'typed twice' })
    expect(voided.status).toBe(200)
    expect(voided.body).toMatchObject({ kind: 'void', guidesDelta: -10, costCentsDelta: -1000 })
    expect(await balanceOf(id)).toMatchObject({
      balance: 0,
      receivedGuides: 0,
      averageCostCents: null
    })
    const again = await admin()
      .post(ApiRoutes.carriers.guidePurchaseVoid(id, purchase.id))
      .send({ note: 'again' })
    expect(again.status).toBe(409)
    const page = await admin().get(ApiRoutes.carriers.guideMovements(id))
    const rows = (page.body as { data: Array<{ id: string; voided: boolean }> }).data
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.id === purchase.id)?.voided).toBe(true)
  })

  it('adjusts by a signed number of guides with a reason, and refuses a zero or no reason', async () => {
    const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    await buy(id, 5, 500)
    const ok = await admin()
      .post(ApiRoutes.carriers.guideAdjustments(id))
      .send({ guides: -2, note: 'lost box' })
    expect(ok.status).toBe(201)
    expect((await balanceOf(id)).balance).toBe(3)
    expect(
      (await admin().post(ApiRoutes.carriers.guideAdjustments(id)).send({ guides: 0, note: 'x' }))
        .status
    ).toBe(400)
    expect(
      (await admin().post(ApiRoutes.carriers.guideAdjustments(id)).send({ guides: 1 })).status
    ).toBe(400)
  })

  it('asks for its own permissions: the balance is read with one and written with the other', async () => {
    const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    const reader = await actorWithPermissions(owner, app, {
      prefix,
      name: 'guide-reader',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.CARRIERS_VIEW_GUIDE_BALANCE]
    })
    const writer = await actorWithPermissions(owner, app, {
      prefix,
      name: 'guide-writer',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.CARRIERS_MANAGE_GUIDE_BALANCE]
    })
    const as = (actor: typeof reader) => api(app, actor, ctx.storeA)
    expect((await as(reader).get(ApiRoutes.carriers.guideBalance(id))).status).toBe(200)
    expect(
      (
        await as(reader)
          .post(ApiRoutes.carriers.guidePurchases(id))
          .send({ paidQuantity: 1, totalCostCents: 1 })
      ).status
    ).toBe(403)
    expect((await as(writer).get(ApiRoutes.carriers.guideBalance(id))).status).toBe(403)
    expect(
      (
        await as(writer)
          .post(ApiRoutes.carriers.guidePurchases(id))
          .send({ paidQuantity: 1, totalCostCents: 1 })
      ).status
    ).toBe(201)
    // an agent holds neither
    expect(
      (await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.carriers.guideBalance(id))).status
    ).toBe(403)
  })

  it('refuses a policy that cannot be honored and keeps the old one', async () => {
    const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    expect((await putPolicy(id)).status).toBe(200)
    const bad = await putPolicy(id, {
      refundRule: BenefitRefundRule.IMMEDIATE,
      lossRule: BenefitLossRule.FROM_CLOSE
    })
    expect(bad.status).toBe(400)
    const read = await admin().get(ApiRoutes.carriers.guidePolicy(id))
    expect(read.body).toMatchObject({ stored: true, refundRule: BenefitRefundRule.AT_PERIOD_CLOSE })
    const audit = await owner.auditLog.findMany({
      where: { resourceId: id, action: 'carrier_guide.policy_changed' }
    })
    expect(audit).toHaveLength(1)
  })

  it('answers the defaults, marked to confirm, before a policy is saved', async () => {
    const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    const read = await admin().get(ApiRoutes.carriers.guidePolicy(id))
    expect(read.body).toMatchObject({
      stored: false,
      balanceEnabled: false,
      benefitEnabled: false,
      thresholdBps: 1000
    })
    expect((read.body as { toConfirm: string[] }).toConfirm).toEqual(
      expect.arrayContaining(['thresholdBps', 'refundRule'])
    )
  })

  describe('a guide is taken from the balance when it is made', () => {
    it('does nothing for a connection with no policy', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await madeGuide(id)
      expect(await movementsOf(id, GuideMovementKind.CONSUME)).toHaveLength(0)
    })

    it('takes one guide, once, and tells the team when the balance runs low and empty, but never refuses', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await putPolicy(id, { benefitEnabled: false, lowBalanceThreshold: 2 })
      await buy(id, 3, 300)
      await madeGuide(id)
      expect((await balanceOf(id)).balance).toBe(2)
      await madeGuide(id)
      await madeGuide(id)
      expect((await balanceOf(id)).balance).toBe(0)
      // one more against a balance of zero: made, not refused
      await madeGuide(id)
      const balance = await balanceOf(id)
      expect(balance).toMatchObject({ balance: -1, empty: true })
      const consumed = await movementsOf(id, GuideMovementKind.CONSUME)
      expect(consumed).toHaveLength(4)
      // what the guide cost on average when it was made, for the finance step to read
      expect(consumed.filter(row => row.unitCostCents === 100)).toHaveLength(3)
      expect(
        await notificationsOf(NotificationTypes.CARRIER_GUIDE_BALANCE_LOW, id)
      ).toBeGreaterThan(0)
      expect(
        await notificationsOf(NotificationTypes.CARRIER_GUIDE_BALANCE_EMPTY, id)
      ).toBeGreaterThan(0)
    })

    it('never takes a guide for a return guide', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await putPolicy(id, { benefitEnabled: false })
      const shipment = await createShipment(owner, {
        storeId: ctx.storeA.id,
        connectionId: id,
        status: ShipmentStatus.CREATING
      })
      await owner.shipment.update({ where: { id: shipment.id }, data: { kind: 'return' } })
      await move(shipment.id, ShipmentStatus.CREATING, ShipmentStatus.LABEL_CREATED)
      expect(await movementsOf(id, GuideMovementKind.CONSUME)).toHaveLength(0)
    })

    it('keeps the ledger append-only, even for the owner of the table, and one consume per shipment', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await putPolicy(id, { benefitEnabled: false })
      const shipmentId = await madeGuide(id)
      const [consume] = await movementsOf(id, GuideMovementKind.CONSUME)
      expect(consume).toBeDefined()
      await expect(
        owner.carrierGuideMovement.update({ where: { id: consume?.id ?? '' }, data: { note: 'x' } })
      ).rejects.toThrow(/append-only/)
      await expect(
        owner.carrierGuideMovement.delete({ where: { id: consume?.id ?? '' } })
      ).rejects.toThrow(/append-only/)
      await expect(
        owner.carrierGuideMovement.create({
          data: {
            storeId: ctx.storeA.id,
            connectionId: id,
            kind: GuideMovementKind.CONSUME,
            guidesDelta: -1,
            shipmentId,
            createdBy: 'system'
          }
        })
      ).rejects.toThrow()
    })
  })

  describe('the refund benefit', () => {
    const closeAt = () => {
      // The first moment after the current calendar month, the way the daily close sees it
      const now = new Date()
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2))
    }
    const policyOf = async (connectionId: string) => {
      const policy = await readGuidePolicy(prisma.client, ctx.storeA.id, connectionId)
      if (policy === null) throw new Error('no policy')
      return policy
    }

    it('gives back at the close the guides returned before the rate reached the threshold, once', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await putPolicy(id)
      await buy(id, 100, 10_000)
      for (let index = 0; index < 12; index += 1) await deliveredGuide(id)
      const start = Date.now() + 60_000
      const first = await returnedGuide(id, new Date(start))
      const second = await returnedGuide(id, new Date(start + 1000))
      // 1 of 12 is 8.3 %: close to the 10 % limit, still held; the second makes 16.7 %: lost
      const before = await balanceOf(id)

      const closed = await closeBenefitPeriods(prisma, await policyOf(id), closeAt())
      expect(closed.length).toBeGreaterThan(0)
      const refunds = await movementsOf(id, GuideMovementKind.REFUND)
      expect(refunds.map(row => row.shipmentId)).toEqual([first])
      expect(refunds.map(row => row.shipmentId)).not.toContain(second)
      expect((await balanceOf(id)).balance).toBe(before.balance + 1)
      const history = await admin().get(ApiRoutes.carriers.benefitPeriods(id))
      expect((history.body as unknown[])[0]).toMatchObject({
        baseCount: 12,
        returnCount: 2,
        state: 'lost',
        refundedCount: 1
      })

      // the same close again judges nothing and gives nothing back twice
      const again = await closeBenefitPeriods(prisma, await policyOf(id), closeAt())
      expect(again.every(period => period.refunded === 0)).toBe(true)
      expect(await movementsOf(id, GuideMovementKind.REFUND)).toHaveLength(1)
    })

    it('gives nothing back when the whole period is judged by its final rate and it is over the limit', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await putPolicy(id, { lossRule: BenefitLossRule.FROM_CLOSE })
      await buy(id, 100, 10_000)
      for (let index = 0; index < 12; index += 1) await deliveredGuide(id)
      await returnedGuide(id, new Date(Date.now() + 60_000))
      await returnedGuide(id, new Date(Date.now() + 61_000))
      await closeBenefitPeriods(prisma, await policyOf(id), closeAt())
      expect(await movementsOf(id, GuideMovementKind.REFUND)).toHaveLength(0)
    })

    it('gives the guide back at once when the policy says so, while the rate is under the limit', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await putPolicy(id, { refundRule: BenefitRefundRule.IMMEDIATE })
      await buy(id, 100, 10_000)
      for (let index = 0; index < 20; index += 1) await deliveredGuide(id)
      const returned = await returnedGuide(id, new Date(Date.now() + 60_000))
      const refunds = await movementsOf(id, GuideMovementKind.REFUND)
      expect(refunds.map(row => row.shipmentId)).toEqual([returned])
    })

    it('does not give back a guide that was never taken from the balance', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      // the benefit is on but the balance is not kept: nothing was taken, so nothing comes back
      await putPolicy(id, { balanceEnabled: false, refundRule: BenefitRefundRule.IMMEDIATE })
      for (let index = 0; index < 20; index += 1) await deliveredGuide(id)
      await returnedGuide(id, new Date(Date.now() + 60_000))
      expect(await movementsOf(id, GuideMovementKind.REFUND)).toHaveLength(0)
    })

    it('warns before the threshold is crossed and again when it is, and says where the period stands', async () => {
      const { id } = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await putPolicy(id)
      for (let index = 0; index < 12; index += 1) await deliveredGuide(id)
      await returnedGuide(id, new Date(Date.now() + 60_000))
      expect(await notificationsOf(NotificationTypes.CARRIER_BENEFIT_AT_RISK, id)).toBeGreaterThan(
        0
      )
      const atRisk = await admin().get(ApiRoutes.carriers.benefit(id))
      expect(atRisk.body).toMatchObject({
        enabled: true,
        state: 'at_risk',
        baseCount: 12,
        returnCount: 1,
        rateBps: 833
      })
      await returnedGuide(id, new Date(Date.now() + 61_000))
      expect(await notificationsOf(NotificationTypes.CARRIER_BENEFIT_LOST, id)).toBeGreaterThan(0)
      const lost = await admin().get(ApiRoutes.carriers.benefit(id))
      expect(lost.body).toMatchObject({ state: 'lost', returnCount: 2 })
      const period = lost.body as {
        crossedAt: string | null
        periodStart: string
        periodEnd: string
      }
      expect(period.crossedAt).not.toBeNull()
      expect(Date.parse(period.periodEnd) - Date.parse(period.periodStart)).toBeGreaterThanOrEqual(
        27 * DAY_MS
      )
    })
  })
})
