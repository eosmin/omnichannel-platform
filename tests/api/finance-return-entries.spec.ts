import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  CodStatus,
  EntryOrigin,
  FinanceCountryCodes,
  FinanceEventKind,
  FinancePostingFailureReason,
  FinancePostingKey,
  FinancePostingOutcome,
  FinanceSourceType,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  OrderReturnStatus,
  RemittanceLineOutcome,
  RemittanceStatus,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { FinancePostingService } from '@platform/core/finance-ledger'
import { JobNames, QueueNames } from '@platform/core/queues'

import { createCarrierConnection, createOrder, createReturn, createShipment } from '../builders'
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
const CONFLICT = 409

const TODAY = new Date().toISOString().slice(0, 10)
// Before the books begin (the setup below starts them on 2020-01-01): the guide's sale is in the opening balance
const BEFORE_BOOKS = '2019-12-31'
const NOON = (day: string): Date => new Date(`${day}T18:00:00Z`)

type Line = [code: string, debit: number, credit: number]

// E7 and E8 (TDD_18 §4.2): the difference of a guide written off by a person, and what a return gives back of the sale. Amounts are
// exact: a guide of $25.15 collected, 2 x $11.30 with 13 % in the price (net 20.00, tax 2.60), a $5.65 shipping fee, each unit at a
// cost of $4.00.
describe('The entries of a difference written off and of a return (Step 4B.6b-2)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let posting: FinancePostingService
  const codeOf: Record<string, Record<string, string>> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    posting = app.get(FinancePostingService)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, user, store)
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

  const code = (role: AccountRole, organizationId = ctx.orgA.id): string =>
    codeOf[organizationId]?.[role] ?? ''
  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)

  const post = (
    sourceType: FinanceSourceType,
    sourceId: string,
    kind: FinanceEventKind,
    organizationId = ctx.orgA.id
  ) => posting.post({ organizationId, sourceType, sourceId, kind })

  async function entryOf(key: string, organizationId = ctx.orgA.id) {
    return owner.journalEntry.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: key } },
      include: { lines: { include: { account: { select: { code: true } } } } }
    })
  }
  const sorted = (lines: Line[]): Line[] =>
    [...lines].sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2])
  const linesOf = (entry: NonNullable<Awaited<ReturnType<typeof entryOf>>>): Line[] =>
    sorted(entry.lines.map((line): Line => [line.account.code, line.debitCents, line.creditCents]))

  // ---------------------------------------------------------------------------------------------------------------------------
  // E7

  // A guide of the store delivered before the books began, in discrepancy with a confirmed remittance that reported `reported` and
  // whose entry (E5) is posted: $25.15 collected, the cost $3.00 and 4.5 % of commission, so the carrier kept the estimate $4.13
  async function discrepancy(
    input: { reported?: number; storeId?: string; postRemittance?: boolean } = {}
  ) {
    const storeId = input.storeId ?? ctx.storeA.id
    const shipment = await createShipment(owner, {
      storeId,
      status: ShipmentStatus.DELIVERED,
      codAmountCents: 2515,
      codStatus: CodStatus.PENDING_REMITTANCE,
      codExpectedCents: 2102,
      carrierCostCents: 300,
      commissionBps: 450,
      deliveredAt: NOON(BEFORE_BOOKS)
    })
    await owner.carrierConnection.update({
      where: { id: shipment.connectionId },
      data: { remittanceDeductsFee: true }
    })
    const author = await owner.membership.findFirstOrThrow({
      where: { storeId },
      select: { userId: true }
    })
    const reported = input.reported ?? 2000
    const remittance = await owner.codRemittance.create({
      data: {
        storeId,
        connectionId: shipment.connectionId,
        status: RemittanceStatus.CONFIRMED,
        createdBy: author.userId,
        confirmedAt: new Date(),
        confirmedBy: author.userId
      },
      select: { id: true }
    })
    await owner.codRemittanceLine.create({
      data: {
        storeId,
        remittanceId: remittance.id,
        position: 1,
        shipmentId: shipment.id,
        guideNumber: `G-${remittance.id.slice(0, 8)}`,
        reportedCents: reported,
        expectedCents: 2102,
        outcome: RemittanceLineOutcome.AMOUNT_DIFFERS
      }
    })
    await owner.shipment.update({
      where: { id: shipment.id },
      data: {
        codStatus: CodStatus.DISCREPANCY,
        codRemittedCents: reported,
        codRemittanceId: remittance.id
      }
    })
    if (input.postRemittance !== false) {
      const posted = await post(
        FinanceSourceType.REMITTANCE,
        remittance.id,
        FinanceEventKind.REMITTANCE_CONFIRM,
        storeId === ctx.storeB.id ? ctx.orgB.id : ctx.orgA.id
      )
      expect(posted.outcome).toBe(FinancePostingOutcome.POSTED)
    }
    return {
      shipmentId: shipment.id,
      remittanceId: remittance.id,
      connectionId: shipment.connectionId
    }
  }

  describe('E7: the difference of a guide, written off', () => {
    it('closes the guide, queues the entry and writes off what the books still hold as owed, with the carrier as the party', async () => {
      const guide = await discrepancy()
      const response = await asAdminA().post(ApiRoutes.remittances.writeOff(guide.shipmentId))
      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        shipmentId: guide.shipmentId,
        codStatus: CodStatus.WRITTEN_OFF
      })
      expect(
        (await owner.shipment.findUniqueOrThrow({ where: { id: guide.shipmentId } })).codStatus
      ).toBe(CodStatus.WRITTEN_OFF)
      const audited = await waitForAuditEntries(owner, {
        action: AuditAction.REMITTANCE_DIFFERENCE_WRITTEN_OFF,
        storeId: ctx.storeA.id,
        resourceId: guide.shipmentId
      })
      expect(audited).toHaveLength(1)
      // The job the worker will receive: the source and the event, and no amount
      const job = queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.find(
        candidate =>
          candidate.name === JobNames.POST_FINANCE_EVENT &&
          (candidate.data as { sourceId?: string }).sourceId === guide.shipmentId
      )
      expect(job?.data).toMatchObject({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.SHIPMENT,
        sourceId: guide.shipmentId,
        kind: FinanceEventKind.COD_WRITE_OFF
      })

      // $25.15 to collect, less the $20.00 the carrier reported and the $4.13 it kept: $1.02 is still owed
      const result = await post(
        FinanceSourceType.SHIPMENT,
        guide.shipmentId,
        FinanceEventKind.COD_WRITE_OFF
      )
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.SHIPMENT_WRITE_OFF(guide.shipmentId))
      expect(entry).toMatchObject({
        type: JournalEntryType.COD_WRITE_OFF,
        origin: EntryOrigin.SYSTEM,
        createdBy: null,
        sourceType: FinanceSourceType.SHIPMENT,
        sourceId: guide.shipmentId,
        totalCents: 102
      })
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.COD_DIFFERENCES), 102, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 102]
        ])
      )
      const receivable = entry?.lines.find(
        line => line.account.code === code(AccountRole.RECEIVABLE_CARRIERS)
      )
      expect(receivable).toMatchObject({
        partyType: 'carrier_connection',
        partyId: guide.connectionId,
        storeId: ctx.storeA.id
      })
      // The same event twice is one entry
      const again = await post(
        FinanceSourceType.SHIPMENT,
        guide.shipmentId,
        FinanceEventKind.COD_WRITE_OFF
      )
      expect(again).toMatchObject({
        outcome: FinancePostingOutcome.REPLAYED,
        entryId: result.entryId
      })
    })

    it('writes a surplus off the other way round', async () => {
      // The carrier reported $26.00 and kept $4.13: $5.98 more than the guide was worth
      const guide = await discrepancy({ reported: 2600 })
      expect((await asAdminA().post(ApiRoutes.remittances.writeOff(guide.shipmentId))).status).toBe(
        OK
      )
      await post(FinanceSourceType.SHIPMENT, guide.shipmentId, FinanceEventKind.COD_WRITE_OFF)
      const entry = await entryOf(FinancePostingKey.SHIPMENT_WRITE_OFF(guide.shipmentId))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.RECEIVABLE_CARRIERS), 498, 0],
          [code(AccountRole.COD_DIFFERENCES), 0, 498]
        ])
      )
    })

    it('waits for the entry of the remittance and never clears a receivable it has not seen cleared', async () => {
      const guide = await discrepancy({ postRemittance: false })
      expect((await asAdminA().post(ApiRoutes.remittances.writeOff(guide.shipmentId))).status).toBe(
        OK
      )
      const waiting = await post(
        FinanceSourceType.SHIPMENT,
        guide.shipmentId,
        FinanceEventKind.COD_WRITE_OFF
      )
      expect(waiting).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.SOURCE_NOT_READY
      })
      await post(
        FinanceSourceType.REMITTANCE,
        guide.remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      const done = await post(
        FinanceSourceType.SHIPMENT,
        guide.shipmentId,
        FinanceEventKind.COD_WRITE_OFF
      )
      expect(done.outcome).toBe(FinancePostingOutcome.POSTED)
    })

    it('refuses a guide that is not in discrepancy and a guide of another store, and writes it once', async () => {
      const pending = await createShipment(owner, {
        storeId: ctx.storeA.id,
        status: ShipmentStatus.DELIVERED,
        codAmountCents: 2515,
        codStatus: CodStatus.PENDING_REMITTANCE
      })
      expect((await asAdminA().post(ApiRoutes.remittances.writeOff(pending.id))).status).toBe(
        CONFLICT
      )

      const elsewhere = await discrepancy({ storeId: ctx.storeB.id })
      expect(
        (await asAdminA().post(ApiRoutes.remittances.writeOff(elsewhere.shipmentId))).status
      ).toBe(NOT_FOUND)
      expect(
        (await owner.shipment.findUniqueOrThrow({ where: { id: elsewhere.shipmentId } })).codStatus
      ).toBe(CodStatus.DISCREPANCY)

      const guide = await discrepancy()
      expect((await asAdminA().post(ApiRoutes.remittances.writeOff(guide.shipmentId))).status).toBe(
        OK
      )
      expect((await asAdminA().post(ApiRoutes.remittances.writeOff(guide.shipmentId))).status).toBe(
        CONFLICT
      )
    })

    it('asks for the permission to move money on top of managing remittances', async () => {
      const guide = await discrepancy()
      for (const [name, permissions] of [
        ['manage-only', [Permissions.REMITTANCES_MANAGE, Permissions.REMITTANCES_VIEW]],
        ['money-only', [Permissions.FINANCE_MOVE_MONEY]]
      ] as const) {
        const actor = api(
          app,
          await actorWithPermissions(owner, app, {
            prefix,
            name: `writeoff-${name}`,
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA.id,
            permissions
          }),
          ctx.storeA
        )
        expect((await actor.post(ApiRoutes.remittances.writeOff(guide.shipmentId))).status).toBe(
          FORBIDDEN
        )
      }
      expect(
        (await owner.shipment.findUniqueOrThrow({ where: { id: guide.shipmentId } })).codStatus
      ).toBe(CodStatus.DISCREPANCY)
    })

    it('does not let the remittance that left the difference be voided', async () => {
      const guide = await discrepancy()
      await asAdminA().post(ApiRoutes.remittances.writeOff(guide.shipmentId))
      const voided = await asAdminA().post(ApiRoutes.remittances.void(guide.remittanceId)).send({})
      expect(voided.status).toBe(CONFLICT)
      expect(
        (await owner.codRemittance.findUniqueOrThrow({ where: { id: guide.remittanceId } })).status
      ).toBe(RemittanceStatus.CONFIRMED)
    })

    it('never reads a guide of another organization', async () => {
      const guide = await discrepancy()
      await asAdminA().post(ApiRoutes.remittances.writeOff(guide.shipmentId))
      const result = await post(
        FinanceSourceType.SHIPMENT,
        guide.shipmentId,
        FinanceEventKind.COD_WRITE_OFF,
        ctx.orgB.id
      )
      expect(result.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgB.id, sourceId: guide.shipmentId }
        })
      ).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------------
  // E8

  // An order of the store in the shape the tax step stores it (2 x $11.30 with 13 % in the price, a $5.65 shipping fee): the total is
  // $28.25 (net 20.00 + shipping 5.00 + tax 3.25). `orderId` shapes an order that already exists (the one of a guide)
  async function order(
    input: { status?: string; day?: string; orderId?: string; connectionId?: string } = {}
  ): Promise<{ id: string; itemId: string }> {
    const made =
      input.orderId === undefined
        ? await createOrder(owner, {
            storeId: ctx.storeA.id,
            ...(input.connectionId === undefined ? {} : { carrierConnectionId: input.connectionId })
          })
        : {
            id: input.orderId,
            itemId: (
              await owner.orderItem.findFirstOrThrow({
                where: { orderId: input.orderId },
                select: { id: true }
              })
            ).id
          }
    const status = input.status ?? 'DELIVERED'
    const day = input.day ?? TODAY
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
        ...(input.connectionId === undefined ? {} : { carrierConnectionId: input.connectionId }),
        paymentMethod: 'CASH_ON_DELIVERY',
        paymentStatus: 'PENDING',
        shippedAt: NOON(day),
        deliveredAt: status === 'SHIPPED' ? null : NOON(day)
      }
    })
    return { id: made.id, itemId: made.itemId }
  }

  async function movement(
    orderId: string,
    type: InventoryMovementType,
    reference: { type: InventoryReferenceType; id: string },
    input: { quantity: number; unitCostCents: number | null }
  ) {
    const item = await owner.orderItem.findFirstOrThrow({
      where: { orderId },
      select: { productId: true }
    })
    await owner.inventoryMovement.create({
      data: {
        storeId: ctx.storeA.id,
        productId: item.productId,
        warehouseId: ctx.warehouseA.id,
        type,
        quantity: input.quantity,
        referenceType: reference.type,
        referenceId: reference.id,
        idempotencyKey: `m-${randomUUID()}`,
        unitCostCents: input.unitCostCents,
        onHandAfter: 0,
        reservedAfter: 0
      }
    })
  }

  // The goods left (2 x $4.00) and the sale is recognized against the carrier
  async function sold(input: { connectionId?: string; orderId?: string } = {}) {
    const connectionId =
      input.connectionId ?? (await createCarrierConnection(owner, { storeId: ctx.storeA.id })).id
    const made = await order({
      connectionId,
      ...(input.orderId === undefined ? {} : { orderId: input.orderId })
    })
    await movement(
      made.id,
      InventoryMovementType.ISSUE,
      { type: InventoryReferenceType.ORDER, id: made.id },
      { quantity: 2, unitCostCents: 400 }
    )
    expect((await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.SENT)).outcome).toBe(
      FinancePostingOutcome.POSTED
    )
    expect((await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.SALE)).outcome).toBe(
      FinancePostingOutcome.POSTED
    )
    return { ...made, connectionId }
  }

  // A return of `quantity` units of the line, received at `receivedAt`, with its units put back at `unitCostCents` each
  async function received(
    made: { id: string; itemId: string },
    input: { quantity: number; receivedAt: Date; unitCostCents?: number | null; restocked?: number }
  ): Promise<string> {
    const author = await owner.membership.findFirstOrThrow({
      where: { storeId: ctx.storeA.id },
      select: { userId: true }
    })
    const made2 = await owner.orderReturn.create({
      data: {
        storeId: ctx.storeA.id,
        orderId: made.id,
        type: 'refund',
        reason: 'DEFECTIVE',
        status: OrderReturnStatus.RECEIVED,
        shippingPayer: 'sender',
        createdBy: author.userId,
        receivedAt: input.receivedAt
      },
      select: { id: true }
    })
    await owner.orderReturnLine.create({
      data: {
        storeId: ctx.storeA.id,
        returnId: made2.id,
        orderItemId: made.itemId,
        quantity: input.quantity
      }
    })
    await movement(
      made.id,
      InventoryMovementType.RETURN_IN,
      { type: InventoryReferenceType.RETURN, id: made2.id },
      {
        quantity: input.restocked ?? input.quantity,
        // The engine stores a unit that comes back with no cost (it values it at the average of the level): the books value it at the
        // cost its sale took it out at, unless the movement says one
        unitCostCents: input.unitCostCents === undefined ? null : input.unitCostCents
      }
    )
    return made2.id
  }

  describe('E8: a return received', () => {
    it('gives back its share of the revenue and the tax against the customer advance, and puts the cost back', async () => {
      const made = await sold()
      const returnId = await received(made, { quantity: 1, receivedAt: new Date() })
      const result = await post(FinanceSourceType.RETURN, returnId, FinanceEventKind.RETURN_RESTOCK)
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.RETURN_RESTOCK(returnId))
      expect(entry).toMatchObject({
        type: JournalEntryType.SALE_RETURN,
        origin: EntryOrigin.SYSTEM,
        createdBy: null,
        sourceType: FinanceSourceType.RETURN,
        sourceId: returnId,
        totalCents: 1530
      })
      // One of the two units: $10.00 of revenue and $1.30 of tax back, owed to the customer; $4.00 of cost back on the shelf
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.SALES_RETURNS), 1000, 0],
          [code(AccountRole.VAT_OUTPUT), 130, 0],
          [code(AccountRole.CUSTOMER_ADVANCES), 0, 1130],
          [code(AccountRole.INVENTORY), 400, 0],
          [code(AccountRole.COST_OF_GOODS_SOLD), 0, 400]
        ])
      )
      expect(entry?.lines.every(line => line.storeId === ctx.storeA.id)).toBe(true)
      expect(
        await post(FinanceSourceType.RETURN, returnId, FinanceEventKind.RETURN_RESTOCK)
      ).toMatchObject({ outcome: FinancePostingOutcome.REPLAYED, entryId: result.entryId })
    })

    it('adds up to the whole sale to the cent when every unit has come back, in two returns', async () => {
      const made = await sold()
      const first = await received(made, {
        quantity: 1,
        receivedAt: new Date(Date.now() - 60_000)
      })
      const second = await received(made, { quantity: 1, receivedAt: new Date() })
      // The later one first: each return is read against the units that came back before it, not against the order of the jobs
      await post(FinanceSourceType.RETURN, second, FinanceEventKind.RETURN_RESTOCK)
      await post(FinanceSourceType.RETURN, first, FinanceEventKind.RETURN_RESTOCK)
      const entries = [
        await entryOf(FinancePostingKey.RETURN_RESTOCK(first)),
        await entryOf(FinancePostingKey.RETURN_RESTOCK(second))
      ]
      const total = (role: AccountRole, side: 'debitCents' | 'creditCents'): number =>
        entries.reduce(
          (sum, entry) =>
            sum +
            (entry?.lines
              .filter(line => line.account.code === code(role))
              .reduce((inner, line) => inner + line[side], 0) ?? 0),
          0
        )
      expect(total(AccountRole.SALES_RETURNS, 'debitCents')).toBe(2000)
      expect(total(AccountRole.VAT_OUTPUT, 'debitCents')).toBe(260)
      expect(total(AccountRole.COST_OF_GOODS_SOLD, 'creditCents')).toBe(800)
    })

    it('credits the carrier receivable, with its party, when the carrier will never remit the guide', async () => {
      const connectionId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id })).id
      const guide = await createShipment(owner, {
        storeId: ctx.storeA.id,
        connectionId,
        // The parcel came back: its guide is returned and the carrier will never remit it
        status: ShipmentStatus.RETURNED,
        codAmountCents: 2825,
        codStatus: CodStatus.VOID
      })
      const made = await sold({ connectionId, orderId: guide.orderId })
      const returnId = await received(made, { quantity: 2, receivedAt: new Date() })
      await post(FinanceSourceType.RETURN, returnId, FinanceEventKind.RETURN_RESTOCK)
      const entry = await entryOf(FinancePostingKey.RETURN_RESTOCK(returnId))
      const receivable = entry?.lines.find(
        line => line.account.code === code(AccountRole.RECEIVABLE_CARRIERS)
      )
      // The whole receivable E3 debited goes, shipping included: the order is back in full and the carrier will never remit
      expect(receivable).toMatchObject({
        creditCents: 2825,
        partyType: 'carrier_connection',
        partyId: connectionId
      })
      expect(
        entry?.lines.some(line => line.account.code === code(AccountRole.CUSTOMER_ADVANCES))
      ).toBe(false)
      expect(
        entry?.lines.find(line => line.account.code === code(AccountRole.SHIPPING_REVENUE))
      ).toMatchObject({ debitCents: 500 })
      expect(
        entry?.lines.find(line => line.account.code === code(AccountRole.VAT_OUTPUT))
      ).toMatchObject({ debitCents: 325 })
    })

    it('waits for the sale it reverses, and posts once it is there', async () => {
      const connectionId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id })).id
      const made = await order({ connectionId })
      await movement(
        made.id,
        InventoryMovementType.ISSUE,
        { type: InventoryReferenceType.ORDER, id: made.id },
        { quantity: 2, unitCostCents: 400 }
      )
      const returnId = await received(made, { quantity: 1, receivedAt: new Date() })
      expect(
        await post(FinanceSourceType.RETURN, returnId, FinanceEventKind.RETURN_RESTOCK)
      ).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.SOURCE_NOT_READY
      })
      await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.SALE)
      expect(
        (await post(FinanceSourceType.RETURN, returnId, FinanceEventKind.RETURN_RESTOCK)).outcome
      ).toBe(FinancePostingOutcome.POSTED)
    })

    it('values a unit at the cost its movement recorded when it has one, and posts nothing for a return that is not received', async () => {
      const made = await sold()
      const priced = await received(made, {
        quantity: 1,
        receivedAt: new Date(),
        unitCostCents: 450
      })
      expect(
        (await post(FinanceSourceType.RETURN, priced, FinanceEventKind.RETURN_RESTOCK)).outcome
      ).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.RETURN_RESTOCK(priced))
      expect(
        entry?.lines.find(line => line.account.code === code(AccountRole.INVENTORY))
      ).toMatchObject({ debitCents: 450 })
      const open = await received(made, { quantity: 1, receivedAt: new Date() })
      await owner.orderReturn.update({
        where: { id: open },
        data: { status: OrderReturnStatus.REQUESTED, receivedAt: null }
      })
      expect(
        (await post(FinanceSourceType.RETURN, open, FinanceEventKind.RETURN_RESTOCK)).outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
    })

    it('names the role with no account and posts once it is mapped, and never reads a return of another organization', async () => {
      const made = await sold()
      const returnId = await received(made, { quantity: 1, receivedAt: new Date() })
      const mapping = await owner.accountRoleMapping.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, role: AccountRole.SALES_RETURNS }
      })
      await owner.accountRoleMapping.delete({
        where: {
          organizationId_role: { organizationId: mapping.organizationId, role: mapping.role }
        }
      })
      try {
        expect(
          await post(FinanceSourceType.RETURN, returnId, FinanceEventKind.RETURN_RESTOCK)
        ).toMatchObject({
          outcome: FinancePostingOutcome.FAILED,
          reason: FinancePostingFailureReason.ROLE_NOT_MAPPED
        })
      } finally {
        await owner.accountRoleMapping.create({
          data: {
            organizationId: mapping.organizationId,
            role: mapping.role,
            accountId: mapping.accountId
          }
        })
      }
      expect(
        (
          await post(
            FinanceSourceType.RETURN,
            returnId,
            FinanceEventKind.RETURN_RESTOCK,
            ctx.orgB.id
          )
        ).outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(
        (await post(FinanceSourceType.RETURN, returnId, FinanceEventKind.RETURN_RESTOCK)).outcome
      ).toBe(FinancePostingOutcome.POSTED)
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgB.id, sourceId: returnId }
        })
      ).toBe(0)
    })
  })

  describe('E8: an order put back as a whole', () => {
    it('moves the cost from transit back to inventory when the parcel came back before the sale', async () => {
      const connectionId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id })).id
      const made = await order({ status: 'SHIPPED', connectionId })
      await movement(
        made.id,
        InventoryMovementType.ISSUE,
        { type: InventoryReferenceType.ORDER, id: made.id },
        { quantity: 2, unitCostCents: 400 }
      )
      await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.SENT)
      await owner.order.update({ where: { id: made.id }, data: { status: 'RETURNED' } })
      await movement(
        made.id,
        InventoryMovementType.RETURN_IN,
        { type: InventoryReferenceType.ORDER, id: made.id },
        { quantity: 2, unitCostCents: 400 }
      )
      const result = await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.ORDER_RETURN)
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.ORDER_RETURN(made.id))
      expect(entry).toMatchObject({ type: JournalEntryType.SALE_RETURN, totalCents: 800 })
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.INVENTORY), 800, 0],
          [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 800]
        ])
      )
    })

    it('reverses the whole revenue of a delivered order an agent put back, and the cost of what went back on the shelf', async () => {
      const made = await sold()
      await owner.order.update({ where: { id: made.id }, data: { status: 'RETURNED' } })
      await movement(
        made.id,
        InventoryMovementType.RETURN_IN,
        { type: InventoryReferenceType.ORDER, id: made.id },
        { quantity: 2, unitCostCents: 400 }
      )
      await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.ORDER_RETURN)
      const entry = await entryOf(FinancePostingKey.ORDER_RETURN(made.id))
      // The shipping fee is not reversed: the order does not say it was given back (the accountant decides, debt of the plan)
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.SALES_RETURNS), 2000, 0],
          [code(AccountRole.VAT_OUTPUT), 260, 0],
          [code(AccountRole.CUSTOMER_ADVANCES), 0, 2260],
          [code(AccountRole.INVENTORY), 800, 0],
          [code(AccountRole.COST_OF_GOODS_SOLD), 0, 800]
        ])
      )
    })

    it('leaves an order that has received returns to them, and posts nothing for one that is not returned', async () => {
      const made = await sold()
      expect(
        (await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.ORDER_RETURN)).outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      await received(made, { quantity: 2, receivedAt: new Date() })
      await owner.order.update({ where: { id: made.id }, data: { status: 'RETURNED' } })
      expect(
        (await post(FinanceSourceType.ORDER, made.id, FinanceEventKind.ORDER_RETURN)).outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(await entryOf(FinancePostingKey.ORDER_RETURN(made.id))).toBeNull()
    })
  })

  describe('E4 for the guide of a return', () => {
    it('owes the carrier the cost of the guide when the store pays the return, with no commission, and nothing when the customer pays it', async () => {
      const ret = await createReturn(owner, { storeId: ctx.storeA.id })
      const retOrder = (await owner.orderReturn.findUniqueOrThrow({ where: { id: ret.id } }))
        .orderId
      const guide = await createShipment(owner, {
        storeId: ctx.storeA.id,
        returnOf: { returnId: ret.id, orderId: retOrder },
        status: ShipmentStatus.DELIVERED,
        // The store pays the return: the guide's payer is its recipient (the warehouse)
        shippingPayer: ShippingPayer.RECIPIENT,
        carrierCostCents: 300,
        commissionBps: 450,
        deliveredAt: NOON(TODAY)
      })
      const result = await post(FinanceSourceType.SHIPMENT, guide.id, FinanceEventKind.CHARGES)
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.SHIPMENT_CHARGES(guide.id))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.CARRIER_FREIGHT_EXPENSE), 300, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 0, 300]
        ])
      )

      const other = await createReturn(owner, { storeId: ctx.storeA.id })
      const otherOrder = (await owner.orderReturn.findUniqueOrThrow({ where: { id: other.id } }))
        .orderId
      const theirs = await createShipment(owner, {
        storeId: ctx.storeA.id,
        returnOf: { returnId: other.id, orderId: otherOrder },
        status: ShipmentStatus.DELIVERED,
        shippingPayer: ShippingPayer.SENDER,
        carrierCostCents: 300,
        deliveredAt: NOON(TODAY)
      })
      expect(
        (await post(FinanceSourceType.SHIPMENT, theirs.id, FinanceEventKind.CHARGES)).outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
    })
  })
})
