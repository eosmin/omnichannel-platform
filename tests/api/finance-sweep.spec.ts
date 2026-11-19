import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { JobContext } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FinanceEventKind,
  FinancePostingFailureReason,
  FinancePostingKey,
  FinancePostingOutcome,
  FinanceSourceType,
  GuideMovementKind,
  InventoryAdjustmentReason,
  InventoryMovementType,
  InventoryReferenceType,
  ShipmentStatus,
  ShippingPayer,
  TransferShortageAction,
  TransferStatus
} from '@platform/core/domain'
import {
  FinanceCloseGuard,
  FinancePostingService,
  FinanceSweepService
} from '@platform/core/finance-ledger'
import { InventoryService } from '@platform/core/inventory'
import { JobNames, reconcileFinanceJobId } from '@platform/core/queues'

import { FinanceReconciler } from '../../apps/worker/src/finance/finance-reconciler.service'
import { FinanceReconcileScheduler } from '../../apps/worker/src/schedulers/finance-reconcile.scheduler'
import {
  createCarrierConnection,
  createOrder,
  createProduct,
  createReturn,
  createShipment,
  createTransfer
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'
import { onWorkerDatabase, createGuardedWorkerPrisma } from '../helpers/worker-db'

const CREATED = 201
const TODAY = new Date().toISOString().slice(0, 10)
const NOON = (day: string): Date => new Date(`${day}T18:00:00Z`)

// The daily check of the books (TDD_18 §6.1, §11, Step 4B.6b-3): a source that should have an entry and has none is found and asked for,
// once, whatever the number of times the sweep runs; the balances are compared with the lines; and the close guard says what stands in
// the way of closing a month.
describe('The sweep of the books and the guard of the close', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sweep: FinanceSweepService
  let posting: FinancePostingService
  let guard: FinanceCloseGuard

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], onWorkerDatabase())
    ctx = await seedTestContext(owner, app, prefix)
    sweep = app.get(FinanceSweepService)
    posting = app.get(FinancePostingService)
    guard = app.get(FinanceCloseGuard)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, user, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // The sweep reads the whole organization, and the database is shared with the other suites of the run: what is checked is the sources
  // of the case, never a total
  const queuedOf = async (sourceId: string, organizationId = ctx.orgA.id) =>
    (await sweep.sweep(organizationId)).toQueue.filter(job => job.sourceId === sourceId)

  // A delivered order of the store, paid on delivery, with what left for it at $4.00 a unit
  async function deliveredOrder(
    input: { status?: string; day?: string; storeId?: string; withCost?: boolean } = {}
  ): Promise<string> {
    const storeId = input.storeId ?? ctx.storeA.id
    const made = await createOrder(owner, { storeId })
    await owner.orderItem.update({
      where: { id: made.itemId },
      data: {
        quantity: 2,
        unitPriceCents: 1130,
        taxTreatment: 'taxed',
        taxRateBps: 1300,
        taxCents: 260
      }
    })
    const day = input.day ?? TODAY
    const status = input.status ?? 'DELIVERED'
    await owner.order.update({
      where: { id: made.id },
      data: {
        status,
        subtotalCents: 2260,
        shippingCents: 565,
        discountCents: 0,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        paymentMethod: 'CASH_ON_DELIVERY',
        paymentStatus: 'PENDING',
        shippedAt: NOON(day),
        deliveredAt: status === 'DELIVERED' ? NOON(day) : null
      }
    })
    if (input.withCost !== false) {
      const item = await owner.orderItem.findFirstOrThrow({
        where: { orderId: made.id },
        select: { productId: true }
      })
      await owner.inventoryMovement.create({
        data: {
          storeId,
          productId: item.productId,
          warehouseId: ctx.warehouseA.id,
          type: InventoryMovementType.ISSUE,
          quantity: 2,
          referenceType: 'order',
          referenceId: made.id,
          idempotencyKey: `issue-${randomUUID()}`,
          unitCostCents: 400,
          onHandAfter: 0,
          reservedAfter: 0
        }
      })
    }
    return made.id
  }

  // A carrier connection for the COD sale: the order needs one to be posted
  async function withCarrier(orderId: string): Promise<void> {
    const connection = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    await owner.order.update({
      where: { id: orderId },
      data: { carrierConnectionId: connection.id }
    })
  }

  describe('finding what was never posted', () => {
    it('finds the sale and the shipment of a delivered order that no job posted, once', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)

      const found = await queuedOf(id)
      expect(found.map(job => job.kind).sort()).toEqual(
        [FinanceEventKind.SALE, FinanceEventKind.SENT].sort()
      )
      expect(found.every(job => job.organizationId === ctx.orgA.id)).toBe(true)
      expect(found.every(job => job.sourceType === FinanceSourceType.ORDER)).toBe(true)
      // The sweep only asks: nothing is posted and no failure is recorded by looking
      expect(
        await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id, sourceId: id } })
      ).toBe(0)
      expect(
        await owner.financePostingFailure.count({
          where: { organizationId: ctx.orgA.id, sourceId: id }
        })
      ).toBe(0)
    })

    it('stops finding a source once its job has posted it, whatever the order of the jobs', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)
      for (const job of await queuedOf(id)) await posting.post(job)

      expect(await queuedOf(id)).toEqual([])
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, idempotencyKey: FinancePostingKey.ORDER_SALE(id) }
        })
      ).toBe(1)
    })

    it('does not look for what is not due: a cancelled order, a sale before the start of the books, an order not delivered', async () => {
      const cancelled = await deliveredOrder({ status: 'CANCELLED' })
      const pending = await deliveredOrder({ status: 'SHIPPED' })
      await withCarrier(pending)
      const old = await deliveredOrder({ day: '2019-06-01' })
      await withCarrier(old)

      expect(await queuedOf(cancelled)).toEqual([])
      expect(await queuedOf(old)).toEqual([])
      // A shipped order has its shipment entry due, not its sale
      expect((await queuedOf(pending)).map(job => job.kind)).toEqual([FinanceEventKind.SENT])
    })

    it('tells a person about a source the books cannot post, once, and does not ask again for what is listed', async () => {
      // A COD order with no carrier cannot be posted (the receivable needs a party): the job would record that failure
      const id = await deliveredOrder()
      const first = await queuedOf(id)
      expect(first.length).toBeGreaterThan(0)
      for (const job of first) await posting.post(job)
      const failure = await owner.financePostingFailure.findFirst({
        where: {
          organizationId: ctx.orgA.id,
          sourceId: id,
          eventKind: FinanceEventKind.SALE,
          resolvedAt: null
        }
      })
      expect(failure?.reason).toBe(FinancePostingFailureReason.CARRIER_MISSING)
      // Listed: the sweep leaves it to the person and counts it in the open failures
      expect((await queuedOf(id)).filter(job => job.kind === FinanceEventKind.SALE)).toEqual([])
      expect((await sweep.sweep(ctx.orgA.id)).openFailures).toBeGreaterThan(0)
    })

    it('leaves alone a source that waits for another one, and does not queue it over and over', async () => {
      // A prepaid order delivered before its payment entry exists waits (the advance is not there)
      const id = await deliveredOrder()
      await withCarrier(id)
      await owner.order.update({
        where: { id },
        data: { paymentMethod: 'BANK_TRANSFER', paymentStatus: 'COMPLETED' }
      })
      const sale = (await queuedOf(id)).filter(job => job.kind === FinanceEventKind.SALE)
      for (const job of sale) await posting.post(job)
      const waiting = await owner.financePostingFailure.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, sourceId: id, eventKind: FinanceEventKind.SALE }
      })
      expect(waiting.reason).toBe(FinancePostingFailureReason.SOURCE_NOT_READY)
      // Still waiting: the preview says it would fail again, so it is not queued over and over
      expect((await queuedOf(id)).filter(job => job.kind === FinanceEventKind.SALE)).toEqual([])
    })

    it('finds the shipment entry of an order still in transit, in the mode that recognizes the sale at delivery', async () => {
      const id = await deliveredOrder({ status: 'SHIPPED' })
      await withCarrier(id)
      expect((await queuedOf(id)).map(job => job.kind)).toEqual([FinanceEventKind.SENT])
    })

    it('finds a stock adjustment with no entry, and stops once it is posted', async () => {
      const item = await owner.product.findFirstOrThrow({
        where: { storeId: ctx.storeA.id },
        select: { id: true }
      })
      const movement = await owner.inventoryMovement.create({
        data: {
          storeId: ctx.storeA.id,
          productId: item.id,
          warehouseId: ctx.warehouseA.id,
          type: InventoryMovementType.ADJUSTMENT_OUT,
          quantity: 1,
          reason: 'damaged',
          idempotencyKey: `adj-${randomUUID()}`,
          unitCostCents: 400,
          onHandAfter: 0,
          reservedAfter: 0
        },
        select: { id: true }
      })
      const found = await queuedOf(movement.id)
      expect(found.map(job => [job.sourceType, job.kind])).toEqual([
        [FinanceSourceType.INVENTORY_MOVEMENT, FinanceEventKind.ADJUST]
      ])
      for (const job of found) await posting.post(job)
      expect(await queuedOf(movement.id)).toEqual([])
    })

    it('finds a transfer shortage written off with no entry, and stops once it is posted (AUT-911)', async () => {
      const made = await createTransfer(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        status: TransferStatus.RECEIVED
      })
      const lineId = made.lineId as string
      const line = await owner.stockTransferLine.update({
        where: { id: lineId },
        data: {
          quantity: 4,
          receivedQuantity: 3,
          shortageAction: TransferShortageAction.WRITE_OFF
        },
        select: { productId: true }
      })
      const header = await owner.stockTransfer.findUniqueOrThrow({
        where: { id: made.id },
        select: { fromWarehouseId: true, toWarehouseId: true }
      })
      await owner.inventoryMovement.create({
        data: {
          storeId: ctx.storeA.id,
          productId: line.productId,
          warehouseId: header.fromWarehouseId,
          type: InventoryMovementType.TRANSFER_OUT,
          quantity: 4,
          referenceType: InventoryReferenceType.TRANSFER,
          referenceId: made.id,
          idempotencyKey: `transfer:${made.id}:${lineId}:dispatch`,
          unitCostCents: 250,
          valueCents: 1000n,
          onHandAfter: 0,
          reservedAfter: 0
        }
      })
      await owner.inventoryMovement.create({
        data: {
          storeId: ctx.storeA.id,
          productId: line.productId,
          warehouseId: header.toWarehouseId,
          type: InventoryMovementType.TRANSFER_IN,
          quantity: 3,
          referenceType: InventoryReferenceType.TRANSFER,
          referenceId: made.id,
          idempotencyKey: `transfer:${made.id}:${lineId}:receive:r1`,
          unitCostCents: 250,
          valueCents: 750n,
          onHandAfter: 0,
          reservedAfter: 0
        }
      })
      const found = await queuedOf(lineId)
      expect(found.map(job => [job.sourceType, job.kind])).toEqual([
        [FinanceSourceType.TRANSFER_LINE, FinanceEventKind.TRANSFER_WRITE_OFF]
      ])
      for (const job of found) await posting.post(job)
      expect(await queuedOf(lineId)).toEqual([])
    })

    it('finds the voiding of a remittance only when its confirmation was posted and nothing reversed it', async () => {
      const shipment = await createShipment(owner, {
        storeId: ctx.storeA.id,
        status: ShipmentStatus.DELIVERED,
        codAmountCents: 1000,
        // Delivered before the books began: its sale is in the opening balance, so the remittance does not wait for an E3
        deliveredAt: NOON('2019-06-01')
      })
      const author = await owner.membership.findFirstOrThrow({
        where: { storeId: ctx.storeA.id },
        select: { userId: true }
      })
      const remittance = await owner.codRemittance.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: shipment.connectionId,
          status: 'confirmed',
          createdBy: author.userId,
          confirmedAt: new Date(),
          confirmedBy: author.userId
        },
        select: { id: true }
      })
      await owner.codRemittanceLine.create({
        data: {
          storeId: ctx.storeA.id,
          remittanceId: remittance.id,
          position: 1,
          shipmentId: shipment.id,
          guideNumber: `G-${remittance.id.slice(0, 6)}`,
          reportedCents: 1000,
          expectedCents: 1000,
          outcome: 'matched'
        }
      })
      // Confirmed and not posted: the confirmation is what the sweep asks for
      expect((await queuedOf(remittance.id)).map(job => job.kind)).toEqual([
        FinanceEventKind.REMITTANCE_CONFIRM
      ])
      for (const job of await queuedOf(remittance.id)) await posting.post(job)
      expect(await queuedOf(remittance.id)).toEqual([])
      // Voided: the reversal is what it asks for, once
      await owner.codRemittance.update({
        where: { id: remittance.id },
        data: { status: 'voided', voidedAt: new Date(), voidedBy: 'system' }
      })
      expect((await queuedOf(remittance.id)).map(job => job.kind)).toEqual([
        FinanceEventKind.REMITTANCE_VOID
      ])
      for (const job of await queuedOf(remittance.id)) await posting.post(job)
      expect(await queuedOf(remittance.id)).toEqual([])
    })

    it('does not look at a source older than the date it is asked for', async () => {
      const id = await deliveredOrder({ day: '2026-02-01' })
      await withCarrier(id)
      const all = await sweep.sweep(ctx.orgA.id, new Date('2026-11-16T00:00:00Z'), {
        since: new Date('2026-01-01T00:00:00Z')
      })
      expect(all.toQueue.some(job => job.sourceId === id)).toBe(true)
      const recent = await sweep.sweep(ctx.orgA.id, new Date('2026-11-16T00:00:00Z'), {
        since: new Date('2026-06-01T00:00:00Z')
      })
      expect(recent.toQueue.some(job => job.sourceId === id)).toBe(false)
    })

    it('never queues the refund of a completed return: a refund from before E14 may be booked by hand (HC-105)', async () => {
      const made = await createReturn(owner, { storeId: ctx.storeA.id, status: 'completed' })
      await owner.orderReturn.update({
        where: { id: made.id },
        data: { refundAmountCents: 500, receivedAt: new Date() }
      })
      const jobs = (await sweep.sweep(ctx.orgA.id)).toQueue.filter(job => job.sourceId === made.id)
      expect(jobs.some(job => job.kind === FinanceEventKind.RETURN_REFUND)).toBe(false)
      // The refund is posted under its own key, once: a second job finds the entry
      const input = {
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.RETURN,
        sourceId: made.id,
        kind: FinanceEventKind.RETURN_REFUND
      }
      const first = await posting.post(input)
      expect(first.outcome).toBe(FinancePostingOutcome.POSTED)
      expect(await posting.post(input)).toMatchObject({
        outcome: FinancePostingOutcome.REPLAYED,
        entryId: first.entryId
      })
    })

    it('never reads another organization', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)
      expect((await queuedOf(id)).length).toBeGreaterThan(0)
      // The same id looked for from the other organization is nothing: its sweep finds none of these sources
      expect(await queuedOf(id, ctx.orgB.id)).toEqual([])
      const theirs = await sweep.sweep(ctx.orgB.id)
      expect(theirs.toQueue.every(job => job.organizationId === ctx.orgB.id)).toBe(true)
    })

    it('stops at its cap and says so, oldest first', async () => {
      const older = await deliveredOrder({ day: '2026-01-05' })
      await withCarrier(older)
      const result = await sweep.sweep(ctx.orgA.id, new Date(), { maxCandidates: 1 })
      // The work that a job would do stops at the cap (a batch of previews may go a little over it), and the run says it stopped
      expect(result.toQueue.length).toBeGreaterThanOrEqual(1)
      expect(result.truncated).toBe(true)
    })

    it('finds the charges of a delivered guide, of any kind, and not a guide with nothing to charge', async () => {
      const charged = await createShipment(owner, {
        storeId: ctx.storeA.id,
        status: ShipmentStatus.DELIVERED,
        codAmountCents: 2515,
        carrierCostCents: 300,
        commissionBps: 450,
        deliveredAt: NOON(TODAY)
      })
      const free = await createShipment(owner, {
        storeId: ctx.storeA.id,
        status: ShipmentStatus.DELIVERED,
        shippingPayer: ShippingPayer.RECIPIENT,
        deliveredAt: NOON(TODAY)
      })
      expect((await queuedOf(charged.id)).map(job => job.kind)).toEqual([FinanceEventKind.CHARGES])
      expect(await queuedOf(free.id)).toEqual([])
    })

    it('finds the purchase of guides of a prepaid connection and its void, and not one the books do not carry or one that cost nothing (E15, E16)', async () => {
      const { connectionId } = await createShipment(owner, {
        storeId: ctx.storeA.id,
        status: ShipmentStatus.DELIVERED,
        deliveredAt: NOON(TODAY)
      })
      const movement = (over: {
        kind: string
        cents: number
        onAdvance: boolean
        voids?: string
      }) =>
        owner.carrierGuideMovement.create({
          data: {
            storeId: ctx.storeA.id,
            connectionId,
            kind: over.kind,
            guidesDelta: over.kind === GuideMovementKind.VOID ? -10 : 10,
            costCentsDelta: over.kind === GuideMovementKind.VOID ? -over.cents : over.cents,
            paidQuantity: over.kind === GuideMovementKind.PURCHASE ? 10 : null,
            giftQuantity: over.kind === GuideMovementKind.PURCHASE ? 0 : null,
            onAdvance: over.onAdvance,
            voidsMovementId: over.voids ?? null,
            note: over.kind === GuideMovementKind.VOID ? 'typed twice' : null,
            createdBy: 'system'
          }
        })
      const carried = await movement({
        kind: GuideMovementKind.PURCHASE,
        cents: 1000,
        onAdvance: true
      })
      const carriedVoid = await movement({
        kind: GuideMovementKind.VOID,
        cents: 1000,
        onAdvance: true,
        voids: carried.id
      })
      const plain = await movement({
        kind: GuideMovementKind.PURCHASE,
        cents: 1000,
        onAdvance: false
      })
      const plainVoid = await movement({
        kind: GuideMovementKind.VOID,
        cents: 1000,
        onAdvance: false,
        voids: plain.id
      })
      const gifts = await movement({ kind: GuideMovementKind.PURCHASE, cents: 0, onAdvance: true })
      expect((await queuedOf(carried.id)).map(job => job.kind)).toEqual([
        FinanceEventKind.GUIDE_PURCHASE
      ])
      expect((await queuedOf(carriedVoid.id)).map(job => job.kind)).toEqual([
        FinanceEventKind.GUIDE_PURCHASE_VOID
      ])
      expect(await queuedOf(plain.id)).toEqual([])
      expect(await queuedOf(plainVoid.id)).toEqual([])
      expect(await queuedOf(gifts.id)).toEqual([])
    })

    it('closes the failure of a source that waited once the source needs nothing any more', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)
      // Listed as not queued, then cancelled: the sweep still asks the job, which closes the row
      await owner.financePostingFailure.create({
        data: {
          organizationId: ctx.orgA.id,
          sourceType: FinanceSourceType.ORDER,
          sourceId: id,
          eventKind: FinanceEventKind.SALE,
          reason: FinancePostingFailureReason.NOT_QUEUED
        }
      })
      await owner.order.update({ where: { id }, data: { status: 'CANCELLED' } })
      const jobs = (await sweep.sweep(ctx.orgA.id)).toQueue.filter(job => job.sourceId === id)
      expect(jobs.map(job => job.kind)).toContain(FinanceEventKind.SALE)
      for (const job of jobs) await posting.post(job)
      const row = await owner.financePostingFailure.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, sourceId: id, eventKind: FinanceEventKind.SALE }
      })
      expect(row.resolvedAt).not.toBeNull()
    })

    it('has nothing to look at for an organization that has not set up its books', async () => {
      await owner.financeSettings.delete({ where: { organizationId: ctx.orgB.id } }).catch(() => {
        // purged by the cleanup of another suite: nothing to delete
      })
      expect(await sweep.sweep(ctx.orgB.id)).toEqual({
        examined: 0,
        toQueue: [],
        openFailures: 0,
        unposted: 0,
        truncated: false
      })
      await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    })
  })

  describe('the balances', () => {
    it('agree with the lines, and a difference is counted and never corrected', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)
      for (const job of await queuedOf(id)) await posting.post(job)
      expect(await sweep.balanceMismatches(ctx.orgA.id)).toBe(0)

      // Someone changed a balance by hand (the owner role can; the application cannot): the check sees it
      const balance = await owner.accountPeriodBalance.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id }
      })
      await owner.accountPeriodBalance.update({
        where: { id: balance.id },
        data: { debitCents: balance.debitCents + 1n }
      })
      try {
        expect(await sweep.balanceMismatches(ctx.orgA.id)).toBe(1)
        // Another organization's check is not touched by it
        expect(await sweep.balanceMismatches(ctx.orgB.id)).toBe(0)
      } finally {
        await owner.accountPeriodBalance.update({
          where: { id: balance.id },
          data: { debitCents: balance.debitCents }
        })
      }
      expect(await sweep.balanceMismatches(ctx.orgA.id)).toBe(0)
    })
  })

  describe('the inventory account against the stock (HC-007)', () => {
    // The books of the suite carry entries that no stock stands behind (the sales above issue units the fixtures never received), so what
    // is checked is the DIFFERENCE and that a movement leaves it where it was
    const stockMove = (input: {
      productId: string
      type: InventoryMovementType
      quantity: number
      unitCostCents?: number
    }) =>
      app.get(InventoryService, { strict: false }).move({
        storeId: ctx.storeA.id,
        warehouseId: ctx.warehouseA.id,
        idempotencyKey: `${prefix}-${randomUUID()}`,
        reason:
          input.type === InventoryMovementType.RECEIPT
            ? InventoryAdjustmentReason.OPENING_STOCK
            : InventoryAdjustmentReason.DAMAGED,
        ...input
      })
    const postAdjustment = (movementId: string) =>
      posting.post({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.INVENTORY_MOVEMENT,
        sourceId: movementId,
        kind: FinanceEventKind.ADJUST
      })

    it('keeps the books and the stock the same to the cent through issues of a level whose average has a fraction of a cent', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      // 3 at 1.00 and 2 at 1.01: 5 units worth 502, an average of 100.4
      await stockMove({
        productId: product.id,
        type: InventoryMovementType.RECEIPT,
        quantity: 3,
        unitCostCents: 100
      })
      await stockMove({
        productId: product.id,
        type: InventoryMovementType.RECEIPT,
        quantity: 2,
        unitCostCents: 101
      })
      // The receipts post nothing here (a purchase does, E10): the baseline is where the books and the stock stand with 502 in the level
      const baseline = (await sweep.inventoryDrift(ctx.orgA.id)).differenceCents

      const first = await stockMove({
        productId: product.id,
        type: InventoryMovementType.ADJUSTMENT_OUT,
        quantity: 2
      })
      await postAdjustment(first.movement.id)
      const level = await owner.inventoryLevel.findFirstOrThrow({
        where: { productId: product.id, warehouseId: ctx.warehouseA.id }
      })
      // The level lost 201 (not 2 x 100) and the books credited the same 201
      expect(level.valueCents).toBe(301n)
      expect((await sweep.inventoryDrift(ctx.orgA.id)).differenceCents).toBe(baseline)

      // Everything that is left leaves: no residue of the rounding stays in the books with the stock at zero
      const last = await stockMove({
        productId: product.id,
        type: InventoryMovementType.ADJUSTMENT_OUT,
        quantity: 3
      })
      await postAdjustment(last.movement.id)
      const emptied = await owner.inventoryLevel.findFirstOrThrow({
        where: { productId: product.id, warehouseId: ctx.warehouseA.id }
      })
      expect(emptied).toMatchObject({ onHand: 0, valueCents: 0n })
      expect((await sweep.inventoryDrift(ctx.orgA.id)).differenceCents).toBe(baseline)
      const moved = await owner.inventoryMovement.findMany({
        where: { productId: product.id, type: InventoryMovementType.ADJUSTMENT_OUT },
        orderBy: { seq: 'asc' },
        select: { valueCents: true }
      })
      expect(moved.map(row => row.valueCents)).toEqual([201n, 301n])
    })

    it('says how far the books are from the stock, and a movement that bypassed the books shows', async () => {
      const before = await sweep.inventoryDrift(ctx.orgA.id)
      expect(before.differenceCents).toBe(before.ledgerCents - before.stockCents)
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      // Stock that no entry stands behind: 7 cents more in the warehouse than in the books
      await owner.inventoryLevel.create({
        data: {
          storeId: ctx.storeA.id,
          productId: product.id,
          warehouseId: ctx.warehouseA.id,
          onHand: 1,
          valueCents: 7n
        }
      })
      const after = await sweep.inventoryDrift(ctx.orgA.id)
      expect(after.stockCents).toBe(before.stockCents + 7n)
      expect(after.differenceCents).toBe(before.differenceCents - 7n)
      // The other organization has its own books and its own stock: nothing of this reaches it
      const other = await sweep.inventoryDrift(ctx.orgB.id)
      expect(other.stockCents).toBe(0n)
      // Nothing is posted to close it
      expect(await sweep.inventoryDrift(ctx.orgA.id)).toEqual(after)
    })
  })

  describe('the guard of the close', () => {
    it('blocks while an entry failed and nobody fixed it, and opens when it is fixed', async () => {
      const id = await deliveredOrder()
      for (const job of await queuedOf(id)) await posting.post(job)
      const blocked = await guard.check(ctx.orgA.id)
      expect(blocked.blocked).toBe(true)
      expect(blocked.failureCount).toBeGreaterThan(0)
      expect(
        blocked.failures.some(
          row => row.reason === (FinancePostingFailureReason.CARRIER_MISSING as string)
        )
      ).toBe(true)

      await withCarrier(id)
      await posting.post({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.ORDER,
        sourceId: id,
        kind: FinanceEventKind.SALE
      })
      await posting.post({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.ORDER,
        sourceId: id,
        kind: FinanceEventKind.SENT
      })
      const failure = await owner.financePostingFailure.findFirst({
        where: { organizationId: ctx.orgA.id, sourceId: id, resolvedAt: null }
      })
      expect(failure).toBeNull()
    })

    it('blocks while a source has no entry that a job would post, and counts it', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)
      const check = await guard.check(ctx.orgA.id)
      expect(check.pendingSources).toBeGreaterThanOrEqual(2)
      expect(check.blocked).toBe(true)
    })

    it('is clear for an organization with nothing pending', async () => {
      const ids = await owner.order.findMany({
        where: { store: { organizationId: ctx.orgB.id } },
        select: { id: true }
      })
      expect(ids.length).toBe(0)
      const check = await guard.check(ctx.orgB.id)
      expect(check).toMatchObject({
        failureCount: 0,
        failures: [],
        pendingSources: 0,
        truncated: false,
        blocked: false
      })
    })
  })

  describe('the daily job', () => {
    const NOW = new Date('2026-11-12T04:30:00.000Z')
    const locks = {
      withLock: async (_name: string, _seconds: number, work: () => Promise<void>) => {
        await work()
        return true
      }
    } as never
    const logger = {
      setContext: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined
    } as unknown as PinoLogger

    it('queues one check for each organization with books, with an id of its own for the day', async () => {
      const heavy = new CapturedQueue()
      const scheduler = new FinanceReconcileScheduler(
        locks,
        heavy as never,
        createGuardedWorkerPrisma(),
        logger,
        new JobContext(createGuardedWorkerPrisma())
      )
      await scheduler.enqueueAll(NOW, { pageSize: 1 })
      const mine = heavy.jobs.filter(
        job => (job.data as { organizationId: string }).organizationId === ctx.orgA.id
      )
      expect(mine).toEqual([
        {
          name: JobNames.RECONCILE_FINANCE,
          data: { organizationId: ctx.orgA.id },
          opts: {
            jobId: reconcileFinanceJobId(ctx.orgA.id, '2026-11-12'),
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnFail: true
          }
        }
      ])
      // Each organization once, however many pages it took
      const ids = heavy.jobs.map(job => job.opts?.jobId)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('does not throw when the queue is down: the next day tries again', async () => {
      const broken = { addBulk: () => Promise.reject(new Error('redis is down')) }
      const failing = new FinanceReconcileScheduler(
        locks,
        broken as never,
        createGuardedWorkerPrisma(),
        logger,
        new JobContext(createGuardedWorkerPrisma())
      )
      await expect(failing.run()).resolves.toBeUndefined()
    })

    it('asks the posting job for what it found, sets the gauge and counts a balance that disagrees', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)
      const heavy = new CapturedQueue()
      const gauge: { labels: Record<string, string>; value: number }[] = []
      const counter: { labels: Record<string, string>; value: number }[] = []
      const reconciler = new FinanceReconciler(
        sweep,
        heavy as never,
        {
          set: (labels: Record<string, string>, value: number) => gauge.push({ labels, value })
        } as never,
        {
          set: (labels: Record<string, string>, value: number) => counter.push({ labels, value })
        } as never,
        logger
      )
      const report = await reconciler.reconcile(ctx.orgA.id)
      const jobs = heavy.jobs.filter(job => (job.data as { sourceId: string }).sourceId === id)
      expect(jobs.map(job => job.name)).toEqual([
        JobNames.POST_FINANCE_EVENT,
        JobNames.POST_FINANCE_EVENT
      ])
      expect(jobs.map(job => (job.data as { kind: string }).kind).sort()).toEqual(
        [FinanceEventKind.SALE, FinanceEventKind.SENT].sort()
      )
      expect(report.queued).toBeGreaterThanOrEqual(2)
      expect(gauge).toEqual([{ labels: { organization_id: ctx.orgA.id }, value: report.unposted }])
      // The mismatches gauge is set to how many there are now, zero included, so that it goes back to zero when they are fixed
      // The suite's sales credit inventory with no stock behind them, but this run just asked for entries that are not in the books yet: that
      // is lag and not a difference, so the gauge says zero
      expect(report.inventoryDriftCents).not.toBe(0)
      expect(counter).toEqual([{ labels: { organization_id: ctx.orgA.id }, value: 0 }])
      expect(report.balanceMismatches).toBe(0)
    })

    it('counts the inventory of the books against the stock as one difference when nothing waits to be posted, and posts nothing', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeB.id })
      const level = await owner.inventoryLevel.create({
        data: {
          storeId: ctx.storeB.id,
          productId: product.id,
          warehouseId: ctx.warehouseB.id,
          onHand: 1,
          valueCents: 7n
        }
      })
      try {
        const heavy = new CapturedQueue()
        const counter: { labels: Record<string, string>; value: number }[] = []
        const reconciler = new FinanceReconciler(
          sweep,
          heavy as never,
          { set: () => undefined } as never,
          {
            set: (labels: Record<string, string>, value: number) => counter.push({ labels, value })
          } as never,
          logger
        )
        const report = await reconciler.reconcile(ctx.orgB.id)
        expect(report.queued).toBe(0)
        expect(report.inventoryDriftCents).toBe(-7)
        expect(report.balanceMismatches).toBe(1)
        expect(counter).toEqual([{ labels: { organization_id: ctx.orgB.id }, value: 1 }])
        expect(heavy.jobs).toEqual([])
        expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgB.id } })).toBe(0)
      } finally {
        await owner.inventoryLevel.delete({ where: { id: level.id } })
      }
    })

    it('posts nothing by itself: what it queued is posted by the job, under the key', async () => {
      const id = await deliveredOrder()
      await withCarrier(id)
      const heavy = new CapturedQueue()
      const reconciler = new FinanceReconciler(
        sweep,
        heavy as never,
        { set: () => undefined } as never,
        { set: () => undefined } as never,
        logger
      )
      await reconciler.reconcile(ctx.orgA.id)
      expect(
        await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id, sourceId: id } })
      ).toBe(0)
      // Running the checks twice queues the same jobs, and posting them twice is one entry
      await reconciler.reconcile(ctx.orgA.id)
      for (const job of heavy.jobs.filter(
        item => (item.data as { sourceId: string }).sourceId === id
      )) {
        await posting.post(job.data as never)
      }
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, idempotencyKey: FinancePostingKey.ORDER_SALE(id) }
        })
      ).toBe(1)
    })
  })
})
