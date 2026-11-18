import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  EntryOrigin,
  FinanceCountryCodes,
  FinanceEventKind,
  FinancePostingFailureReason,
  FinancePostingKey,
  FinancePostingOutcome,
  FinanceSourceType,
  InventoryAdjustmentReason,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  PeriodStatus,
  TransferShortageAction,
  TransferStatus
} from '@platform/core/domain'
import { FinancePostingService } from '@platform/core/finance-ledger'
import { JobNames, QueueNames } from '@platform/core/queues'

import { createCarrierConnection, createOrder, createPeriod, createTransfer } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404

const TODAY = new Date().toISOString().slice(0, 10)
// Noon in El Salvador is 18:00 UTC: the day of the event is the same in both zones
const NOON = (day: string): Date => new Date(`${day}T18:00:00Z`)

type Line = [code: string, debit: number, credit: number]

describe('The automatic entries (Step 4B.6a)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let posting: FinancePostingService
  // The code of the account each role is mapped to, per organization
  const codeOf: Record<string, Record<string, string>> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    posting = app.get(FinancePostingService)
    for (const actor of [asAdmin(ctx.adminA, ctx.storeA), asAdmin(ctx.adminB, ctx.storeB)]) {
      const setup = await actor
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    for (const organizationId of [ctx.orgA.id, ctx.orgB.id]) {
      const rows = await owner.accountRoleMapping.findMany({
        where: { organizationId },
        include: { account: { select: { code: true } } }
      })
      codeOf[organizationId] = Object.fromEntries(rows.map(row => [row.role, row.account.code]))
    }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = (user: TestContext['adminA'], store: TestContext['storeA']) =>
    api(app, user, store)
  const asAdminA = () => asAdmin(ctx.adminA, ctx.storeA)

  const code = (role: AccountRole, organizationId = ctx.orgA.id): string =>
    codeOf[organizationId]?.[role] ?? ''

  // An order of the store, in the shape the tax step stores it: 2 x $11.30 with 13 % in the price, a $5.65 shipping fee with $0.65 of it,
  // so the total is $28.25 (net 20.00 + shipping 5.00 + tax 3.25)
  async function order(
    input: {
      method?: string
      paymentStatus?: string
      status?: string
      day?: string
      storeId?: string
      carrierConnectionId?: string
    } = {}
  ): Promise<string> {
    const storeId = input.storeId ?? ctx.storeA.id
    const made = await createOrder(owner, {
      storeId,
      ...(input.carrierConnectionId === undefined
        ? {}
        : { carrierConnectionId: input.carrierConnectionId })
    })
    const day = input.day ?? TODAY
    const status = input.status ?? 'DELIVERED'
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
        paymentMethod: input.method ?? 'CASH_ON_DELIVERY',
        paymentStatus: input.paymentStatus ?? 'PENDING',
        shippedAt: status === 'PENDING_CONFIRMATION' ? null : NOON(day),
        deliveredAt: status === 'DELIVERED' ? NOON(day) : null
      }
    })
    return made.id
  }

  // The stock that left for an order: 2 units at $4.00 each
  async function issue(
    orderId: string,
    unitCostCents: number | null = 400,
    storeId = ctx.storeA.id
  ) {
    const item = await owner.orderItem.findFirstOrThrow({
      where: { orderId },
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
        referenceId: orderId,
        idempotencyKey: `issue-${randomUUID()}`,
        unitCostCents,
        onHandAfter: 0,
        reservedAfter: 0
      }
    })
  }

  const run = (
    sourceId: string,
    kind: FinanceEventKind,
    extra: { organizationId?: string; sourceType?: FinanceSourceType; occurredAt?: string } = {}
  ) =>
    posting.post({
      organizationId: extra.organizationId ?? ctx.orgA.id,
      sourceType: extra.sourceType ?? FinanceSourceType.ORDER,
      sourceId,
      kind,
      ...(extra.occurredAt === undefined ? {} : { occurredAt: extra.occurredAt })
    })

  async function entryOf(key: string, organizationId = ctx.orgA.id) {
    return owner.journalEntry.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: key } },
      include: { lines: { include: { account: { select: { code: true } } } } }
    })
  }
  const linesOf = (entry: NonNullable<Awaited<ReturnType<typeof entryOf>>>): Line[] =>
    entry.lines
      .map((line): Line => [line.account.code, line.debitCents, line.creditCents])
      .sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1])
  const sorted = (lines: Line[]): Line[] =>
    [...lines].sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1])

  // One carrier connection per store, made when first needed
  const connections = new Map<string, string>()
  async function connectionOf(storeId = ctx.storeA.id): Promise<string> {
    const known = connections.get(storeId)
    if (known !== undefined) return known
    const built = await createCarrierConnection(owner, { storeId })
    connections.set(storeId, built.id)
    return built.id
  }

  describe('a delivered cash on delivery order (E2 then E3)', () => {
    it('moves the cost to transit when the goods leave, then recognizes the sale against the carrier', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      await issue(id)

      const sent = await run(id, FinanceEventKind.SENT)
      expect(sent.outcome).toBe(FinancePostingOutcome.POSTED)
      const e2 = await entryOf(FinancePostingKey.ORDER_SENT(id))
      expect(e2).toMatchObject({
        type: JournalEntryType.SALE_SHIPMENT,
        origin: EntryOrigin.SYSTEM,
        createdBy: null,
        sourceType: FinanceSourceType.ORDER,
        sourceId: id,
        totalCents: 800
      })
      expect(linesOf(e2 as NonNullable<typeof e2>)).toEqual(
        sorted([
          [code(AccountRole.INVENTORY_IN_TRANSIT), 800, 0],
          [code(AccountRole.INVENTORY), 0, 800]
        ])
      )

      const sale = await run(id, FinanceEventKind.SALE)
      expect(sale.outcome).toBe(FinancePostingOutcome.POSTED)
      const e3 = await entryOf(FinancePostingKey.ORDER_SALE(id))
      expect(linesOf(e3 as NonNullable<typeof e3>)).toEqual(
        sorted([
          [code(AccountRole.RECEIVABLE_CARRIERS), 2825, 0],
          [code(AccountRole.SALES_REVENUE), 0, 2000],
          [code(AccountRole.SHIPPING_REVENUE), 0, 500],
          [code(AccountRole.VAT_OUTPUT), 0, 325],
          [code(AccountRole.COST_OF_GOODS_SOLD), 800, 0],
          [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 800]
        ])
      )
      // The receivable names the carrier that owes it
      const receivable = e3?.lines.find(
        line => line.account.code === code(AccountRole.RECEIVABLE_CARRIERS)
      )
      expect(receivable).toMatchObject({ partyType: 'carrier_connection', partyId: connectionId })
      // The lines carry the store as their dimension
      expect(e3?.lines.every(line => line.storeId === ctx.storeA.id)).toBe(true)
    })

    it('posts the same event twice as one entry, whatever the order of the jobs', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      await issue(id)
      const first = await run(id, FinanceEventKind.SALE)
      const second = await run(id, FinanceEventKind.SALE)
      expect(first.outcome).toBe(FinancePostingOutcome.POSTED)
      expect(second).toMatchObject({
        outcome: FinancePostingOutcome.REPLAYED,
        entryId: first.entryId
      })
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, sourceId: id }
        })
      ).toBe(1)
    })

    it('does not take the cost out twice when the sale came before the shipment entry', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      await issue(id)
      expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      // The sale took the cost straight from inventory, so the shipment entry has nothing left to do
      expect((await run(id, FinanceEventKind.SENT)).outcome).toBe(
        FinancePostingOutcome.NOTHING_TO_POST
      )
      const e3 = await entryOf(FinancePostingKey.ORDER_SALE(id))
      expect(linesOf(e3 as NonNullable<typeof e3>)).toEqual(
        expect.arrayContaining([[code(AccountRole.INVENTORY), 0, 800]])
      )
      expect(await entryOf(FinancePostingKey.ORDER_SENT(id))).toBeNull()
    })

    it('fails visibly with no carrier to owe the money', async () => {
      const id = await order()
      await issue(id)
      const result = await run(id, FinanceEventKind.SALE)
      expect(result).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.CARRIER_MISSING
      })
      expect(await entryOf(FinancePostingKey.ORDER_SALE(id))).toBeNull()
    })
  })

  describe('a prepaid order (E1 then E3)', () => {
    it('receives the money in the account of the method and clears the advance at the sale', async () => {
      const id = await order({ method: 'TRANSFER', paymentStatus: 'COMPLETED' })
      await issue(id)
      expect((await run(id, FinanceEventKind.PAYMENT)).outcome).toBe(FinancePostingOutcome.POSTED)
      const e1 = await entryOf(FinancePostingKey.ORDER_PAYMENT(id))
      const advances = code(AccountRole.CUSTOMER_ADVANCES)
      expect(e1?.lines.map(line => [line.debitCents, line.creditCents])).toEqual(
        expect.arrayContaining([
          [2825, 0],
          [0, 2825]
        ])
      )
      expect(e1?.lines.find(line => line.creditCents === 2825)?.account.code).toBe(advances)

      // The payment entry posted the sale too (an order already delivered waited for it): asking again finds it
      expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.REPLAYED)
      const e3 = await entryOf(FinancePostingKey.ORDER_SALE(id))
      expect(e3?.lines.find(line => line.debitCents === 2825)?.account.code).toBe(advances)
      // The advance nets to zero across the two entries
      const net = [...(e1?.lines ?? []), ...(e3?.lines ?? [])]
        .filter(line => line.account.code === advances)
        .reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
      expect(net).toBe(0)
    })

    it("does not post a payment of a cash on delivery order, which is the carrier's money", async () => {
      const id = await order({ method: 'CASH_ON_DELIVERY', paymentStatus: 'COMPLETED' })
      expect((await run(id, FinanceEventKind.PAYMENT)).outcome).toBe(
        FinancePostingOutcome.NOTHING_TO_POST
      )
    })

    it('does not recognize a delivered order that is neither paid nor cash on delivery: a failure a person sees', async () => {
      const id = await order({ method: 'TRANSFER', paymentStatus: 'PENDING' })
      const result = await run(id, FinanceEventKind.SALE)
      expect(result).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.SOURCE_NOT_READY
      })
      // Paid later: the same event posts and the failure closes
      await owner.order.update({ where: { id }, data: { paymentStatus: 'COMPLETED' } })
      // Paid, but the advance is not there yet: the sale waits for the payment entry, and posts once it exists
      expect((await run(id, FinanceEventKind.SALE)).reason).toBe(
        FinancePostingFailureReason.SOURCE_NOT_READY
      )
      expect((await run(id, FinanceEventKind.PAYMENT)).outcome).toBe(FinancePostingOutcome.POSTED)
      // ... and it posted the sale that was waiting for it, closing the failure
      expect(await entryOf(FinancePostingKey.ORDER_SALE(id))).not.toBeNull()
      expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.REPLAYED)
      const failure = await owner.financePostingFailure.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, sourceId: id }
      })
      expect(failure.resolvedAt).not.toBeNull()
    })
  })

  describe('an order whose payment was refunded (HC-105, AUT-R2-010)', () => {
    it('posts the sale of an order paid and delivered, then refunded: the money was received, E1 holds it', async () => {
      const id = await order({
        method: 'TRANSFER',
        paymentStatus: 'COMPLETED',
        status: 'CONFIRMED'
      })
      expect((await run(id, FinanceEventKind.PAYMENT)).outcome).toBe(FinancePostingOutcome.POSTED)
      // Delivered, and the payment goes back before the sale job runs (a return after delivery marks it so)
      await owner.order.update({
        where: { id },
        data: { paymentStatus: 'REFUNDED', status: 'DELIVERED', deliveredAt: new Date() }
      })
      await issue(id)
      expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      const e1 = await entryOf(FinancePostingKey.ORDER_PAYMENT(id))
      const e3 = await entryOf(FinancePostingKey.ORDER_SALE(id))
      const advances = code(AccountRole.CUSTOMER_ADVANCES)
      expect(e3?.lines.find(line => line.debitCents === 2825)?.account.code).toBe(advances)
      const net = [...(e1?.lines ?? []), ...(e3?.lines ?? [])]
        .filter(line => line.account.code === advances)
        .reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
      expect(net).toBe(0)
    })

    it('tells a person when there is no advance to clear, instead of waiting for ever', async () => {
      const id = await order({ method: 'TRANSFER', paymentStatus: 'REFUNDED' })
      await issue(id)
      expect(await run(id, FinanceEventKind.SALE)).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.PAYMENT_REFUNDED
      })
      expect(await entryOf(FinancePostingKey.ORDER_SALE(id))).toBeNull()
      const row = await owner.financePostingFailure.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, sourceId: id, eventKind: FinanceEventKind.SALE }
      })
      expect(row).toMatchObject({
        reason: FinancePostingFailureReason.PAYMENT_REFUNDED,
        resolvedAt: null
      })
    })

    it('does not touch an order that was never delivered, or was cancelled', async () => {
      const open = await order({
        method: 'TRANSFER',
        paymentStatus: 'REFUNDED',
        status: 'CONFIRMED'
      })
      expect((await run(open, FinanceEventKind.SALE)).outcome).toBe(
        FinancePostingOutcome.NOTHING_TO_POST
      )
      const cancelled = await order({
        method: 'TRANSFER',
        paymentStatus: 'REFUNDED',
        status: 'CANCELLED'
      })
      expect((await run(cancelled, FinanceEventKind.SALE)).outcome).toBe(
        FinancePostingOutcome.NOTHING_TO_POST
      )
    })
  })

  describe('when it cannot post', () => {
    it('a missing mapping fails, is recorded, and "post again" posts it once fixed', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      const mapping = await owner.accountRoleMapping.findUniqueOrThrow({
        where: {
          organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.VAT_OUTPUT }
        }
      })
      await owner.accountRoleMapping.delete({
        where: {
          organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.VAT_OUTPUT }
        }
      })
      try {
        const failed = await run(id, FinanceEventKind.SALE)
        expect(failed).toMatchObject({
          outcome: FinancePostingOutcome.FAILED,
          reason: FinancePostingFailureReason.ROLE_NOT_MAPPED
        })
        // Nothing half posted
        expect(await entryOf(FinancePostingKey.ORDER_SALE(id))).toBeNull()
        const row = await owner.financePostingFailure.findFirstOrThrow({
          where: { organizationId: ctx.orgA.id, sourceId: id, eventKind: FinanceEventKind.SALE }
        })
        expect(row).toMatchObject({
          reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
          attempts: 1,
          resolvedAt: null
        })
        // It appears in the list of failures for the person
        const listed = await asAdminA().get(ApiRoutes.finance.postings)
        expect(listed.status).toBe(OK)
        expect(JSON.stringify(listed.body)).toContain(row.id)

        // "Post again" queues the same job the event did; the worker would run exactly this, and it still fails and counts the attempt
        const queued = await asAdminA().post(ApiRoutes.finance.postingRetry(row.id))
        expect(queued.status).toBe(OK)
        expect(queued.body).toMatchObject({ data: { queued: true } })
        // The job the worker will receive: the source, the event and the date of the trouble, and nothing else
        const job = queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.find(
          candidate =>
            candidate.name === JobNames.POST_FINANCE_EVENT &&
            (candidate.data as { sourceId?: string }).sourceId === id
        )
        expect(job?.data).toEqual({
          organizationId: ctx.orgA.id,
          sourceType: FinanceSourceType.ORDER,
          sourceId: id,
          kind: FinanceEventKind.SALE,
          occurredAt: row.createdAt.toISOString()
        })
        expect(
          await run(id, FinanceEventKind.SALE, { occurredAt: row.createdAt.toISOString() })
        ).toMatchObject({
          outcome: FinancePostingOutcome.FAILED,
          reason: FinancePostingFailureReason.ROLE_NOT_MAPPED
        })
        expect(
          (await owner.financePostingFailure.findUniqueOrThrow({ where: { id: row.id } })).attempts
        ).toBe(2)

        // Fixed: the job posts, and the failure closes
        await owner.accountRoleMapping.create({ data: mapping })
        const fixed = await run(id, FinanceEventKind.SALE, {
          occurredAt: row.createdAt.toISOString()
        })
        expect(fixed.outcome).toBe(FinancePostingOutcome.POSTED)
        expect(await entryOf(FinancePostingKey.ORDER_SALE(id))).not.toBeNull()
        expect(
          (await owner.financePostingFailure.findUniqueOrThrow({ where: { id: row.id } }))
            .resolvedAt
        ).not.toBeNull()
        const audited = await waitForAuditEntries(
          owner,
          {
            action: AuditAction.FINANCE_POSTING_RETRIED,
            organizationId: ctx.orgA.id,
            resourceId: row.id
          },
          1
        )
        expect(audited).toHaveLength(1)
        // A closed failure is not retried: there is nothing to fix
        const closed = await asAdminA().post(ApiRoutes.finance.postingRetry(row.id))
        expect(closed.status).toBe(NOT_FOUND)
      } finally {
        await owner.accountRoleMapping.upsert({
          where: {
            organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.VAT_OUTPUT }
          },
          create: mapping,
          update: {}
        })
      }
    })

    it('a movement that left with no cost cannot be valued: a failure, never a cost of zero', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      await issue(id, null)
      expect(await run(id, FinanceEventKind.SENT)).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.COST_MISSING
      })
    })

    it('an order with no tax recorded (made before the tax step) is not given an invented one', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      await owner.order.update({ where: { id }, data: { taxCents: null, pricesIncludeTax: null } })
      expect(await run(id, FinanceEventKind.SALE)).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.TAX_MISSING
      })
    })

    it('a payment method with no account is a failure naming the cause', async () => {
      const id = await order({ method: 'CARD', paymentStatus: 'COMPLETED' })
      const rows = await owner.paymentMethodAccount.findMany({
        where: { organizationId: ctx.orgA.id, paymentMethod: 'CARD' }
      })
      await owner.paymentMethodAccount.deleteMany({
        where: { organizationId: ctx.orgA.id, paymentMethod: 'CARD' }
      })
      try {
        expect(await run(id, FinanceEventKind.PAYMENT)).toMatchObject({
          outcome: FinancePostingOutcome.FAILED,
          reason: FinancePostingFailureReason.PAYMENT_ACCOUNT_MISSING
        })
      } finally {
        await owner.paymentMethodAccount.createMany({ data: rows })
      }
    })
  })

  describe('when the sale is recognized', () => {
    it('posts the cost from inventory at shipping when the organization recognizes the sale there', async () => {
      const connectionId = await connectionOf()
      await owner.financeSettings.update({
        where: { organizationId: ctx.orgA.id },
        data: { recognizeSaleOn: 'shipped' }
      })
      try {
        const id = await order({ carrierConnectionId: connectionId, status: 'SHIPPED' })
        await issue(id)
        // E2 is skipped: E3 posts the cost
        expect((await run(id, FinanceEventKind.SENT)).outcome).toBe(
          FinancePostingOutcome.NOTHING_TO_POST
        )
        expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
        const e3 = await entryOf(FinancePostingKey.ORDER_SALE(id))
        expect(linesOf(e3 as NonNullable<typeof e3>)).toEqual(
          expect.arrayContaining([
            [code(AccountRole.COST_OF_GOODS_SOLD), 800, 0],
            [code(AccountRole.INVENTORY), 0, 800]
          ])
        )
      } finally {
        await owner.financeSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { recognizeSaleOn: 'delivered' }
        })
      }
    })

    it('an order returned after delivery is still a sale: its return is another entry', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      await owner.order.update({ where: { id }, data: { status: 'RETURNED' } })
      expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
    })

    it('an event paired with a source of another kind posts nothing under a wrong key', async () => {
      const id = await order()
      expect(
        (await run(id, FinanceEventKind.SALE, { sourceType: FinanceSourceType.INVENTORY_MOVEMENT }))
          .outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
    })

    it('an entry already posted is a replay even if an account was re-mapped since', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      const mapping = await owner.accountRoleMapping.findUniqueOrThrow({
        where: {
          organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.SALES_REVENUE }
        }
      })
      const other = await owner.ledgerAccount.findFirstOrThrow({
        where: {
          organizationId: ctx.orgA.id,
          type: 'income',
          isPostable: true,
          active: true,
          NOT: { id: mapping.accountId }
        }
      })
      await owner.accountRoleMapping.update({
        where: {
          organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.SALES_REVENUE }
        },
        data: { accountId: other.id }
      })
      try {
        expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.REPLAYED)
      } finally {
        await owner.accountRoleMapping.update({
          where: {
            organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.SALES_REVENUE }
          },
          data: { accountId: mapping.accountId }
        })
      }
    })

    it('posts nothing for an order that has not reached the moment', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId, status: 'SHIPPED' })
      expect((await run(id, FinanceEventKind.SALE)).outcome).toBe(
        FinancePostingOutcome.NOTHING_TO_POST
      )
    })
  })

  describe('the date of an automatic entry', () => {
    it('never posts what happened before the books started', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId, day: '2019-06-10' })
      const result = await run(id, FinanceEventKind.SALE)
      expect(result.outcome).toBe(FinancePostingOutcome.BEFORE_START)
      expect(await entryOf(FinancePostingKey.ORDER_SALE(id))).toBeNull()
      // And it is not "unposted" either: no failure waits for a person
      expect(
        await owner.financePostingFailure.count({
          where: { organizationId: ctx.orgA.id, sourceId: id, resolvedAt: null }
        })
      ).toBe(0)
    })

    it('a source of a closed period is dated the first day of the open one and keeps its own date', async () => {
      // Organization B: its books are closed through March 2025
      await createPeriod(owner, ctx.orgB.id, 2025, 3, PeriodStatus.CLOSED)
      await owner.financeSettings.update({
        where: { organizationId: ctx.orgB.id },
        data: { lockedThrough: new Date('2025-03-31T00:00:00Z') }
      })
      try {
        const connectionId = await connectionOf(ctx.storeB.id)
        const id = await order({
          storeId: ctx.storeB.id,
          day: '2025-03-15',
          carrierConnectionId: connectionId
        })
        const result = await run(id, FinanceEventKind.SALE, { organizationId: ctx.orgB.id })
        expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
        const entry = await entryOf(FinancePostingKey.ORDER_SALE(id), ctx.orgB.id)
        expect(entry?.entryDate.toISOString().slice(0, 10)).toBe('2025-04-01')
        expect(entry?.sourceDate?.toISOString().slice(0, 10)).toBe('2025-03-15')
        // A retry after the date moved finds its entry instead of being refused for it
        expect(
          (await run(id, FinanceEventKind.SALE, { organizationId: ctx.orgB.id })).outcome
        ).toBe(FinancePostingOutcome.REPLAYED)
      } finally {
        // The lock of the books only moves forward (a trigger holds it): organization B stays closed through March 2025, which no other
        // case of this suite depends on
      }
    })
  })

  describe('stock adjustments (E9)', () => {
    async function movement(
      type: string,
      quantity: number,
      unitCostCents: number | null,
      reason: string | null = null
    ): Promise<string> {
      const made = await createOrder(owner, { storeId: ctx.storeA.id })
      const item = await owner.orderItem.findFirstOrThrow({
        where: { orderId: made.id },
        select: { productId: true }
      })
      const row = await owner.inventoryMovement.create({
        data: {
          storeId: ctx.storeA.id,
          productId: item.productId,
          warehouseId: ctx.warehouseA.id,
          type,
          quantity,
          reason,
          idempotencyKey: `adj-${randomUUID()}`,
          unitCostCents,
          onHandAfter: 0,
          reservedAfter: 0
        },
        select: { id: true }
      })
      return row.id
    }
    const adjust = (id: string) =>
      run(id, FinanceEventKind.ADJUST, { sourceType: FinanceSourceType.INVENTORY_MOVEMENT })

    it('a count variance of units out is a loss at the cost of the movement', async () => {
      const id = await movement(InventoryMovementType.COUNT_OUT, 3, 250)
      expect((await adjust(id)).outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.MOVEMENT_ADJUST(id))
      expect(entry?.type).toBe(JournalEntryType.INVENTORY_ADJUSTMENT)
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.INVENTORY_LOSS), 750, 0],
          [code(AccountRole.INVENTORY), 0, 750]
        ])
      )
    })

    it('units found are a gain, and opening stock goes against the opening equity', async () => {
      const found = await movement(
        InventoryMovementType.ADJUSTMENT_IN,
        2,
        500,
        InventoryAdjustmentReason.FOUND
      )
      await adjust(found)
      const gain = await entryOf(FinancePostingKey.MOVEMENT_ADJUST(found))
      expect(linesOf(gain as NonNullable<typeof gain>)).toEqual(
        sorted([
          [code(AccountRole.INVENTORY), 1000, 0],
          [code(AccountRole.INVENTORY_GAIN), 0, 1000]
        ])
      )
      const opening = await movement(
        InventoryMovementType.ADJUSTMENT_IN,
        4,
        100,
        InventoryAdjustmentReason.OPENING_STOCK
      )
      await adjust(opening)
      const equity = await entryOf(FinancePostingKey.MOVEMENT_ADJUST(opening))
      expect(linesOf(equity as NonNullable<typeof equity>)).toEqual(
        sorted([
          [code(AccountRole.INVENTORY), 400, 0],
          [code(AccountRole.OPENING_EQUITY), 0, 400]
        ])
      )
    })

    it('a transfer posts nothing: the same asset moves inside the organization', async () => {
      const id = await movement(InventoryMovementType.TRANSFER_OUT, 1, 100)
      expect((await adjust(id)).outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(await entryOf(FinancePostingKey.MOVEMENT_ADJUST(id))).toBeNull()
    })

    // AUT-911: a transfer of 4 units of which 3 arrived, closed with the missing unit written off, left the books with the whole value
    // in INVENTORY while the stock had lost one unit and no entry said so
    describe('a transfer shortage written off', () => {
      async function closedWithShortage(action: TransferShortageAction | null) {
        const made = await createTransfer(owner, {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          status: TransferStatus.RECEIVED
        })
        const lineId = made.lineId as string
        const line = await owner.stockTransferLine.update({
          where: { id: lineId },
          data: { quantity: 4, receivedQuantity: 3, shortageAction: action },
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
        return lineId
      }
      const writeOff = (lineId: string, organizationId = ctx.orgA.id) =>
        run(lineId, FinanceEventKind.TRANSFER_WRITE_OFF, {
          organizationId,
          sourceType: FinanceSourceType.TRANSFER_LINE
        })

      it('is a loss of the missing units at the cost they left with, once', async () => {
        const lineId = await closedWithShortage(TransferShortageAction.WRITE_OFF)
        expect((await writeOff(lineId)).outcome).toBe(FinancePostingOutcome.POSTED)
        const entry = await entryOf(FinancePostingKey.TRANSFER_LINE_WRITE_OFF(lineId))
        expect(entry?.type).toBe(JournalEntryType.INVENTORY_ADJUSTMENT)
        expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
          sorted([
            [code(AccountRole.INVENTORY_LOSS), 250, 0],
            [code(AccountRole.INVENTORY), 0, 250]
          ])
        )
        expect((await writeOff(lineId)).outcome).toBe(FinancePostingOutcome.REPLAYED)
        expect(
          await owner.journalEntry.count({
            where: { organizationId: ctx.orgA.id, sourceId: lineId }
          })
        ).toBe(1)
      })

      it('is not retroactive: a transfer closed before the entry existed posts nothing', async () => {
        const lineId = await closedWithShortage(TransferShortageAction.WRITE_OFF)
        const line = await owner.stockTransferLine.findUniqueOrThrow({
          where: { id: lineId },
          select: { transferId: true }
        })
        await owner.stockTransfer.update({
          where: { id: line.transferId },
          data: { closedAt: new Date('2026-11-17T12:00:00.000Z') }
        })
        expect((await writeOff(lineId)).outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
        expect(await entryOf(FinancePostingKey.TRANSFER_LINE_WRITE_OFF(lineId))).toBeNull()
      })

      it('posts nothing for a shortage sent back to the source', async () => {
        const lineId = await closedWithShortage(TransferShortageAction.RETURN_TO_SOURCE)
        expect((await writeOff(lineId)).outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      })

      it('cannot be posted by another organization', async () => {
        const lineId = await closedWithShortage(TransferShortageAction.WRITE_OFF)
        expect((await writeOff(lineId, ctx.orgB.id)).outcome).toBe(
          FinancePostingOutcome.NOTHING_TO_POST
        )
      })
    })
  })

  describe('isolation between organizations', () => {
    it('an organization cannot post the source of another', async () => {
      const connectionId = await connectionOf()
      const id = await order({ carrierConnectionId: connectionId })
      const result = await run(id, FinanceEventKind.SALE, { organizationId: ctx.orgB.id })
      expect(result.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(
        await owner.journalEntry.count({ where: { organizationId: ctx.orgB.id, sourceId: id } })
      ).toBe(0)
    })

    it('"post again" does not reach the failure of another organization, and needs the permission', async () => {
      const id = await order()
      await run(id, FinanceEventKind.SALE)
      const failure = await owner.financePostingFailure.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, sourceId: id }
      })
      const other = await asAdmin(ctx.adminB, ctx.storeB).post(
        ApiRoutes.finance.postingRetry(failure.id)
      )
      expect(other.status).toBe(NOT_FOUND)
      const viewer = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'posting-viewer',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: [Permissions.FINANCE_VIEW]
        }),
        ctx.storeA
      )
      expect((await viewer.post(ApiRoutes.finance.postingRetry(failure.id))).status).toBe(FORBIDDEN)
    })
  })
})
