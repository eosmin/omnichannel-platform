import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
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
  GuideMovementKind,
  JournalEntryType,
  PartyType,
  RemittanceLineOutcome,
  RemittanceStatus,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { FinancePostingService } from '@platform/core/finance-ledger'

import { createShipment } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const CREATED = 201

const TODAY = new Date().toISOString().slice(0, 10)
const NOON = (day: string): Date => new Date(`${day}T18:00:00Z`)

type Line = [code: string, debit: number, credit: number]

// E4 to E6 (TDD_18 §4.2): what a carrier charges for a delivered guide, the remittance that settles it and the voiding of that
// remittance. Amounts are exact: a guide of $25.15 collected, the carrier's cost $3.00 and its commission 4.5 % (= $1.13).
describe('The entries that depend on a carrier (Step 4B.6b-1)', () => {
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

  // A delivered guide of the store with its connection: $25.15 collected, the cost the carrier reported $3.00, commission 4.5 %
  async function delivered(
    input: {
      payer?: ShippingPayer
      status?: ShipmentStatus
      deductsFee?: boolean
      day?: string
      commissionBps?: number | null
      cost?: number
      cod?: number
      // The sale of the order is in the books (E3 must post it before a remittance clears its receivable); by default it is in
      // the opening balance, as a guide of an order sold before the books began
      saleInBooks?: boolean
    } = {}
  ) {
    const built = await createShipment(owner, {
      storeId: ctx.storeA.id,
      status: input.status ?? ShipmentStatus.DELIVERED,
      shippingPayer: input.payer ?? ShippingPayer.SENDER,
      codAmountCents: input.cod ?? 2515,
      codStatus: CodStatus.PENDING_REMITTANCE,
      codExpectedCents: 2102,
      carrierCostCents: input.cost ?? 300,
      ...(input.commissionBps === null ? {} : { commissionBps: input.commissionBps ?? 450 }),
      deliveredAt: NOON(input.day ?? TODAY)
    })
    await owner.carrierConnection.update({
      where: { id: built.connectionId },
      data: { remittanceDeductsFee: input.deductsFee ?? true }
    })
    if (input.saleInBooks !== true) {
      await owner.order.update({
        where: { id: built.orderId },
        data: { shippedAt: NOON('2019-06-01'), deliveredAt: NOON('2019-06-01') }
      })
    }
    return built
  }

  // A confirmed remittance of a connection with one settled line per guide (what the confirmation of 4.15 leaves)
  async function confirmed(
    connectionId: string,
    lines: { shipmentId: string; reported: number; fee?: number | null }[],
    extra: { destinationAccountId?: string; confirmedAt?: Date } = {}
  ) {
    const author = await owner.membership.findFirstOrThrow({
      where: { storeId: ctx.storeA.id },
      select: { userId: true }
    })
    const remittance = await owner.codRemittance.create({
      data: {
        storeId: ctx.storeA.id,
        connectionId,
        status: RemittanceStatus.CONFIRMED,
        createdBy: author.userId,
        confirmedAt: extra.confirmedAt ?? new Date(),
        confirmedBy: author.userId,
        ...(extra.destinationAccountId === undefined
          ? {}
          : { destinationAccountId: extra.destinationAccountId })
      },
      select: { id: true }
    })
    let position = 0
    for (const line of lines) {
      position += 1
      await owner.codRemittanceLine.create({
        data: {
          storeId: ctx.storeA.id,
          remittanceId: remittance.id,
          position,
          shipmentId: line.shipmentId,
          guideNumber: `G-${position}-${remittance.id.slice(0, 6)}`,
          reportedCents: line.reported,
          reportedFeeCents: line.fee ?? null,
          expectedCents: 2102,
          outcome: RemittanceLineOutcome.MATCHED
        }
      })
    }
    return remittance.id
  }

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
  const linesOf = (entry: NonNullable<Awaited<ReturnType<typeof entryOf>>>): Line[] =>
    entry.lines
      .map((line): Line => [line.account.code, line.debitCents, line.creditCents])
      .sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2])
  const sorted = (lines: Line[]): Line[] =>
    [...lines].sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2])

  describe('E4: the charges of a delivered guide', () => {
    it('owes the carrier the guide and the commission when the sender pays', async () => {
      const shipment = await delivered()
      const result = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.SHIPMENT_CHARGES(shipment.id))
      expect(entry).toMatchObject({
        type: JournalEntryType.SALE_SHIPMENT,
        origin: EntryOrigin.SYSTEM,
        createdBy: null,
        sourceType: FinanceSourceType.SHIPMENT,
        sourceId: shipment.id,
        totalCents: 413
      })
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.CARRIER_FREIGHT_EXPENSE), 300, 0],
          [code(AccountRole.CARRIER_COMMISSION_EXPENSE), 113, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 0, 413]
        ])
      )
      const payable = entry?.lines.find(
        line => line.account.code === code(AccountRole.PAYABLE_CARRIERS)
      )
      expect(payable).toMatchObject({
        partyType: 'carrier_connection',
        partyId: shipment.connectionId,
        storeId: ctx.storeA.id
      })
    })

    it('charges only the commission when the recipient pays the guide', async () => {
      const shipment = await delivered({ payer: ShippingPayer.RECIPIENT })
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const entry = await entryOf(FinancePostingKey.SHIPMENT_CHARGES(shipment.id))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.CARRIER_COMMISSION_EXPENSE), 113, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 0, 113]
        ])
      )
    })

    it('posts once however many times the event comes', async () => {
      const shipment = await delivered()
      const first = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const second = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      expect(second).toMatchObject({
        outcome: FinancePostingOutcome.REPLAYED,
        entryId: first.entryId
      })
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, sourceId: shipment.id }
        })
      ).toBe(1)
    })

    it('asks the waiting remittance again even when the charges were already posted', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      // The charges were posted (the job that did it died before asking the remittance again): the retry is a replay and still asks
      const again = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      expect(again.outcome).toBe(FinancePostingOutcome.REPLAYED)
      expect(await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))).not.toBeNull()
    })

    it('posts nothing for a guide that was not delivered, or that has nothing to charge', async () => {
      const onTheWay = await delivered({ status: ShipmentStatus.IN_TRANSIT })
      expect(
        (await post(FinanceSourceType.SHIPMENT, onTheWay.id, FinanceEventKind.CHARGES)).outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      const free = await delivered({ payer: ShippingPayer.RECIPIENT, commissionBps: null })
      expect(
        (await post(FinanceSourceType.SHIPMENT, free.id, FinanceEventKind.CHARGES)).outcome
      ).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, sourceId: { in: [onTheWay.id, free.id] } }
        })
      ).toBe(0)
    })

    it('never reads a guide of another organization', async () => {
      const shipment = await delivered()
      const result = await post(
        FinanceSourceType.SHIPMENT,
        shipment.id,
        FinanceEventKind.CHARGES,
        ctx.orgB.id
      )
      expect(result.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgB.id, sourceId: shipment.id }
        })
      ).toBe(0)
    })

    it('records a failure naming the role when the payable is not mapped, and posts once it is', async () => {
      const shipment = await delivered()
      const mapping = await owner.accountRoleMapping.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, role: AccountRole.PAYABLE_CARRIERS }
      })
      await owner.accountRoleMapping.delete({
        where: {
          organizationId_role: { organizationId: mapping.organizationId, role: mapping.role }
        }
      })
      try {
        const failed = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
        expect(failed).toMatchObject({
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
      const again = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      expect(again.outcome).toBe(FinancePostingOutcome.POSTED)
      const failure = await owner.financePostingFailure.findFirst({
        where: { organizationId: ctx.orgA.id, sourceId: shipment.id }
      })
      expect(failure?.resolvedAt).not.toBeNull()
    })
  })

  // HC-101: a guide a prepaid connection made took its cost out of the advance when it was made, so the carrier is not owed it again
  describe('E4 of a guide paid out of the advance (Step 4B.6b-4)', () => {
    async function prepaid(
      input: { unitCost: number | null; onAdvance?: boolean } = { unitCost: 273 }
    ) {
      const shipment = await delivered()
      await owner.carrierGuideMovement.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: shipment.connectionId,
          kind: GuideMovementKind.CONSUME,
          guidesDelta: -1,
          unitCostCents: input.unitCost,
          onAdvance: input.onAdvance ?? true,
          shipmentId: shipment.id,
          createdBy: 'system'
        }
      })
      return shipment
    }
    const payableOf = async (connectionId: string): Promise<number> => {
      const lines = await owner.journalLine.findMany({
        where: {
          organizationId: ctx.orgA.id,
          partyType: PartyType.CARRIER_CONNECTION,
          partyId: connectionId,
          // Only what is owed to the carrier: the receivable of a remittance names the same carrier
          account: { code: code(AccountRole.PAYABLE_CARRIERS) }
        },
        select: { creditCents: true, debitCents: true }
      })
      return lines.reduce((total, line) => total + line.creditCents - line.debitCents, 0)
    }

    it('credits the advance for the guide at its cost and owes the carrier only the commission', async () => {
      const shipment = await prepaid()
      const result = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.SHIPMENT_CHARGES(shipment.id))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.CARRIER_FREIGHT_EXPENSE), 273, 0],
          [code(AccountRole.CARRIER_COMMISSION_EXPENSE), 113, 0],
          [code(AccountRole.PREPAID_CARRIER_GUIDES), 0, 273],
          [code(AccountRole.PAYABLE_CARRIERS), 0, 113]
        ])
      )
      // Nothing is owed for a freight that was already paid: the payable of the carrier is the commission
      expect(await payableOf(shipment.connectionId)).toBe(113)
    })

    it('charges a guide no advance covered as an invoice, as before: no purchase on record, nothing to take', async () => {
      const shipment = await prepaid({ unitCost: null })
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const entry = await entryOf(FinancePostingKey.SHIPMENT_CHARGES(shipment.id))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.CARRIER_FREIGHT_EXPENSE), 300, 0],
          [code(AccountRole.CARRIER_COMMISSION_EXPENSE), 113, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 0, 413]
        ])
      )
    })

    it('does not read the advance for a guide that was not made on it, whatever the connection is now', async () => {
      const shipment = await prepaid({ unitCost: 273, onAdvance: false })
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      expect(await payableOf(shipment.connectionId)).toBe(413)
    })

    it('fails naming the advance when it is not mapped, and never owes the carrier the guide instead', async () => {
      const shipment = await prepaid()
      const mapping = await owner.accountRoleMapping.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, role: AccountRole.PREPAID_CARRIER_GUIDES }
      })
      await owner.accountRoleMapping.delete({
        where: {
          organizationId_role: { organizationId: mapping.organizationId, role: mapping.role }
        }
      })
      try {
        const failed = await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
        expect(failed).toMatchObject({
          outcome: FinancePostingOutcome.FAILED,
          reason: FinancePostingFailureReason.ROLE_NOT_MAPPED
        })
        expect(await entryOf(FinancePostingKey.SHIPMENT_CHARGES(shipment.id))).toBeNull()
      } finally {
        await owner.accountRoleMapping.create({
          data: {
            organizationId: mapping.organizationId,
            role: mapping.role,
            accountId: mapping.accountId
          }
        })
      }
    })

    it('settles in the remittance only what the carrier is owed: the commission, not the guide that was paid', async () => {
      const shipment = await prepaid()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      // The carrier collected $25.15 and kept only its commission ($1.13): the guide was prepaid
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2402 }
      ])
      const result = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 2402, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 113, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
        ])
      )
      // The payable of the carrier is closed: what it was owed it kept out of the cash
      expect(await payableOf(shipment.connectionId)).toBe(0)
    })
  })

  describe('E5: a confirmed remittance', () => {
    it('brings the cash, settles the fee the carrier kept and clears the receivable of the guide', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      // The carrier kept the cost and the commission out of the cash and remitted $21.02
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      const result = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(entry).toMatchObject({
        type: JournalEntryType.COD_REMITTANCE,
        origin: EntryOrigin.SYSTEM,
        sourceType: FinanceSourceType.REMITTANCE,
        sourceId: remittanceId,
        totalCents: 2515
      })
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 2102, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 413, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
        ])
      )
      const receivable = entry?.lines.find(
        line => line.account.code === code(AccountRole.RECEIVABLE_CARRIERS)
      )
      expect(receivable).toMatchObject({
        partyType: 'carrier_connection',
        partyId: shipment.connectionId
      })
    })

    it('puts the money in the account the owner chose', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const cash = await owner.ledgerAccount.findFirstOrThrow({
        where: {
          organizationId: ctx.orgA.id,
          cashKind: { not: null },
          isPostable: true,
          active: true,
          NOT: { code: code(AccountRole.BANK_DEFAULT) }
        },
        orderBy: { code: 'desc' }
      })
      const remittanceId = await confirmed(
        shipment.connectionId,
        [{ shipmentId: shipment.id, reported: 2102 }],
        { destinationAccountId: cash.id }
      )
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      const to = entry?.lines.find(line => line.debitCents === 2102)
      expect(to?.account.code).toBe(cash.code)
    })

    it('lets the fee of the file replace the estimate and books the difference as commission expense', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      // The file says the carrier kept $5.40 (E4 estimated $4.13): the $1.27 more is expense, and $20.75 is what it remitted
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 1975, fee: 540 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 1975, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 413, 0],
          [code(AccountRole.CARRIER_COMMISSION_EXPENSE), 127, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
        ])
      )
    })

    it('leaves open on the receivable what a short remittance did not pay', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      // The carrier reported $19.02 instead of $21.02: it clears $23.15 of the $25.15 it owes, $2.00 stays open
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 1902 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 1902, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 413, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2315]
        ])
      )
    })

    // What the carrier takes out of the cash is bounded by the cash it collected (HC-001, AUT-523/529/530/531): a fee above it is still the
    // expense the file says, but the part the cash could not cover is owed to the carrier, never cleared from the receivable
    describe('a fee the cash could not cover', () => {
      // The receivable the remittances of a guide leave: what the entries credited it less what they debited
      async function receivableOf(connectionId: string): Promise<number> {
        const rows = await owner.journalLine.findMany({
          where: {
            organizationId: ctx.orgA.id,
            partyType: PartyType.CARRIER_CONNECTION,
            partyId: connectionId,
            account: { code: code(AccountRole.RECEIVABLE_CARRIERS) }
          },
          select: { debitCents: true, creditCents: true }
        })
        return rows.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0)
      }
      async function payableOf(connectionId: string): Promise<number> {
        const rows = await owner.journalLine.findMany({
          where: {
            organizationId: ctx.orgA.id,
            partyType: PartyType.CARRIER_CONNECTION,
            partyId: connectionId,
            account: { code: code(AccountRole.PAYABLE_CARRIERS) }
          },
          select: { debitCents: true, creditCents: true }
        })
        return rows.reduce((sum, row) => sum + row.creditCents - row.debitCents, 0)
      }

      it('a file fee larger than the cash: the receivable of the guide is cleared for the cash and the rest of the fee is owed', async () => {
        const shipment = await delivered()
        await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
        // $25.15 collected, E4 owes the carrier $4.13; the file says it kept $30.00 and remitted nothing
        const remittanceId = await confirmed(shipment.connectionId, [
          { shipmentId: shipment.id, reported: 0, fee: 3000 }
        ])
        const result = await post(
          FinanceSourceType.REMITTANCE,
          remittanceId,
          FinanceEventKind.REMITTANCE_CONFIRM
        )
        expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
        const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
        // All of the $30.00 is expense ($4.13 of it already posted by E4: $25.87 here); the $25.15 the cash covered clears the receivable; the
        // $4.85 it could not cover is owed (the payable E4 left, $4.13, is settled and $4.85 owed again: a credit of $0.72)
        expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
          sorted([
            [code(AccountRole.CARRIER_COMMISSION_EXPENSE), 2587, 0],
            [code(AccountRole.PAYABLE_CARRIERS), 0, 72],
            [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
          ])
        )
        // The receivable of the connection never went above what it collected, and the carrier is owed the $4.85 of its fee
        expect(await receivableOf(shipment.connectionId)).toBe(-2515)
        expect(await payableOf(shipment.connectionId)).toBe(485)
      })

      it('a cash on delivery smaller than the guide: the carrier keeps the cash and the rest of the guide is owed', async () => {
        // $2.00 to collect and a guide of $3.50 the sender pays: nothing to remit, $1.50 owed
        const shipment = await delivered({ cod: 200, cost: 350, commissionBps: null })
        await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
        const remittanceId = await confirmed(shipment.connectionId, [
          { shipmentId: shipment.id, reported: 0 }
        ])
        await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
        const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
        expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
          sorted([
            [code(AccountRole.PAYABLE_CARRIERS), 200, 0],
            [code(AccountRole.RECEIVABLE_CARRIERS), 0, 200]
          ])
        )
        expect(await receivableOf(shipment.connectionId)).toBe(-200)
        expect(await payableOf(shipment.connectionId)).toBe(150)
      })

      it('a fee equal to the cash takes all of it, and a cent more leaves that cent owed', async () => {
        for (const [fee, owed] of [
          [2515, 0],
          [2516, 1]
        ] as const) {
          const shipment = await delivered({ cost: 0, commissionBps: null })
          await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
          const remittanceId = await confirmed(shipment.connectionId, [
            { shipmentId: shipment.id, reported: 0, fee }
          ])
          await post(
            FinanceSourceType.REMITTANCE,
            remittanceId,
            FinanceEventKind.REMITTANCE_CONFIRM
          )
          // E4 posted nothing (no cost, no commission): the whole fee is expense, and what the cash could not cover is owed
          expect(await receivableOf(shipment.connectionId)).toBe(-2515)
          expect(await payableOf(shipment.connectionId)).toBe(owed)
        }
      })

      it('a carrier that does not deduct its fee but lists it with the whole cash remitted: nothing is cleared above the cash', async () => {
        const shipment = await delivered({ deductsFee: false })
        await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
        const remittanceId = await confirmed(shipment.connectionId, [
          { shipmentId: shipment.id, reported: 2515, fee: 413 }
        ])
        await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
        const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
        // The $4.13 E4 owes stays owed: it was not taken out of the cash
        expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
          sorted([
            [code(AccountRole.BANK_DEFAULT), 2515, 0],
            [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
          ])
        )
        expect(await receivableOf(shipment.connectionId)).toBe(-2515)
        expect(await payableOf(shipment.connectionId)).toBe(413)
      })

      it('a guide remitted in parts has only what the earlier remittances left to take the fee out of', async () => {
        const shipment = await delivered()
        await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
        const first = await confirmed(
          shipment.connectionId,
          [{ shipmentId: shipment.id, reported: 2400 }],
          { confirmedAt: new Date(Date.now() - 60_000) }
        )
        const second = await confirmed(shipment.connectionId, [
          { shipmentId: shipment.id, reported: 0, fee: 50 }
        ])
        await post(FinanceSourceType.REMITTANCE, first, FinanceEventKind.REMITTANCE_CONFIRM)
        await post(FinanceSourceType.REMITTANCE, second, FinanceEventKind.REMITTANCE_CONFIRM)
        // The first one reported $24.00 of $25.15: only $1.15 was left for the carrier to keep, so the $4.13 E4 owes is settled for $1.15 and
        // $2.98 of it stays owed; it cleared all $25.15
        const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(first))
        expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
          sorted([
            [code(AccountRole.BANK_DEFAULT), 2400, 0],
            [code(AccountRole.PAYABLE_CARRIERS), 115, 0],
            [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
          ])
        )
        // The second remittance finds nothing left to take its $0.50 out of: it is all expense and all owed, and clears nothing
        const later = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(second))
        expect(linesOf(later as NonNullable<typeof later>)).toEqual(
          sorted([
            [code(AccountRole.CARRIER_COMMISSION_EXPENSE), 50, 0],
            [code(AccountRole.PAYABLE_CARRIERS), 0, 50]
          ])
        )
        expect(await receivableOf(shipment.connectionId)).toBe(-2515)
        expect(await payableOf(shipment.connectionId)).toBe(348)
      })
    })

    it('settles the payable once when a guide with a difference is remitted again', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const first = await confirmed(
        shipment.connectionId,
        [{ shipmentId: shipment.id, reported: 1902 }],
        { confirmedAt: new Date(Date.now() - 60_000) }
      )
      const second = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 200 }
      ])
      await post(FinanceSourceType.REMITTANCE, first, FinanceEventKind.REMITTANCE_CONFIRM)
      await post(FinanceSourceType.REMITTANCE, second, FinanceEventKind.REMITTANCE_CONFIRM)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(second))
      // The later remittance brings only the $2.00 that was missing: no fee, no payable again
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 200, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 200]
        ])
      )
    })

    it('waits for the sale of the order: no cash is credited before E3, and the failure is on the list (HC-103)', async () => {
      const shipment = await delivered({ saleInBooks: true })
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      const waiting = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      expect(waiting).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.SOURCE_NOT_READY
      })
      expect(await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))).toBeNull()
      const failure = await owner.financePostingFailure.findFirst({
        where: { organizationId: ctx.orgA.id, sourceId: remittanceId, resolvedAt: null }
      })
      expect(failure?.reason).toBe(FinancePostingFailureReason.SOURCE_NOT_READY)
    })

    it('waits for the charges of the guide, and posts by itself when they are posted', async () => {
      const shipment = await delivered()
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      const waiting = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      expect(waiting).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.SOURCE_NOT_READY
      })
      expect(await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))).toBeNull()

      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(entry?.totalCents).toBe(2515)
      const failure = await owner.financePostingFailure.findFirst({
        where: { organizationId: ctx.orgA.id, sourceId: remittanceId }
      })
      expect(failure?.resolvedAt).not.toBeNull()
    })

    it('settles nothing of the payable when the carrier does not deduct its fee: it stays owed', async () => {
      const shipment = await delivered({ deductsFee: false })
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2515 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 2515, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
        ])
      )
    })

    it('settles only what the carrier kept when the file says it kept less than the estimate', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      // The carrier kept the $1.13 commission only: the $3.00 of the guide stays owed
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2402, fee: 113 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 2402, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 113, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
        ])
      )
    })

    it('lets a later remittance settle the payable when the earlier one said the carrier kept nothing', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const first = await confirmed(
        shipment.connectionId,
        [{ shipmentId: shipment.id, reported: 1000, fee: 0 }],
        { confirmedAt: new Date(Date.now() - 60_000) }
      )
      const second = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 1102, fee: 413 }
      ])
      await post(FinanceSourceType.REMITTANCE, first, FinanceEventKind.REMITTANCE_CONFIRM)
      await post(FinanceSourceType.REMITTANCE, second, FinanceEventKind.REMITTANCE_CONFIRM)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(second))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 1102, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 413, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 1515]
        ])
      )
    })

    it('uses the charges read from a guide delivered before the start of the books', async () => {
      const shipment = await delivered({ day: '2019-12-20' })
      // No E4 exists for it (before the start) and none is awaited: its payable is in the opening balance
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      const result = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      expect(result.outcome).toBe(FinancePostingOutcome.POSTED)
      const entry = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(linesOf(entry as NonNullable<typeof entry>)).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 2102, 0],
          [code(AccountRole.PAYABLE_CARRIERS), 413, 0],
          [code(AccountRole.RECEIVABLE_CARRIERS), 0, 2515]
        ])
      )
    })

    it('fails, naming why, when the account chosen stopped being one the money can go to', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const cash = await owner.ledgerAccount.findFirstOrThrow({
        where: {
          organizationId: ctx.orgA.id,
          cashKind: { not: null },
          isPostable: true,
          active: true,
          NOT: { code: code(AccountRole.BANK_DEFAULT) }
        }
      })
      const remittanceId = await confirmed(
        shipment.connectionId,
        [{ shipmentId: shipment.id, reported: 2102 }],
        { destinationAccountId: cash.id }
      )
      await owner.ledgerAccount.update({ where: { id: cash.id }, data: { active: false } })
      try {
        const off = await post(
          FinanceSourceType.REMITTANCE,
          remittanceId,
          FinanceEventKind.REMITTANCE_CONFIRM
        )
        expect(off).toMatchObject({
          outcome: FinancePostingOutcome.FAILED,
          reason: FinancePostingFailureReason.ACCOUNT_INACTIVE
        })
        await owner.ledgerAccount.update({
          where: { id: cash.id },
          data: { active: true, cashKind: null }
        })
        const notCash = await post(
          FinanceSourceType.REMITTANCE,
          remittanceId,
          FinanceEventKind.REMITTANCE_CONFIRM
        )
        expect(notCash).toMatchObject({
          outcome: FinancePostingOutcome.FAILED,
          reason: FinancePostingFailureReason.ACCOUNT_NOT_POSTABLE
        })
      } finally {
        await owner.ledgerAccount.update({
          where: { id: cash.id },
          data: { active: true, cashKind: cash.cashKind }
        })
      }
      expect(
        (
          await post(
            FinanceSourceType.REMITTANCE,
            remittanceId,
            FinanceEventKind.REMITTANCE_CONFIRM
          )
        ).outcome
      ).toBe(FinancePostingOutcome.POSTED)
    })

    it('posts nothing for a remittance that is not confirmed', async () => {
      const shipment = await delivered()
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      await owner.codRemittance.update({
        where: { id: remittanceId },
        data: { status: RemittanceStatus.DRAFT, confirmedAt: null, confirmedBy: null }
      })
      const result = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      expect(result.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
    })

    it('never reads a remittance of another organization', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      const result = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM,
        ctx.orgB.id
      )
      expect(result.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
    })
  })

  describe('E6: a remittance that was voided', () => {
    async function voided(remittanceId: string): Promise<void> {
      await owner.codRemittance.update({
        where: { id: remittanceId },
        data: { status: RemittanceStatus.VOIDED, voidedAt: new Date(), voidedBy: 'system' }
      })
    }

    it('reverses the entry of the confirmation with an entry of the system, once', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const e5 = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      await voided(remittanceId)

      const first = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_VOID
      )
      expect(first.outcome).toBe(FinancePostingOutcome.POSTED)
      const reversal = await owner.journalEntry.findUniqueOrThrow({
        where: { id: first.entryId ?? '' },
        include: { lines: { include: { account: { select: { code: true } } } } }
      })
      expect(reversal).toMatchObject({
        type: JournalEntryType.REVERSAL,
        origin: EntryOrigin.SYSTEM,
        createdBy: null,
        reversesEntryId: e5?.id,
        totalCents: 2515
      })
      // The same lines with their sides swapped
      expect(
        reversal.lines
          .map((line): Line => [line.account.code, line.debitCents, line.creditCents])
          .sort((x, y) => x[0].localeCompare(y[0]))
      ).toEqual(
        sorted([
          [code(AccountRole.BANK_DEFAULT), 0, 2102],
          [code(AccountRole.PAYABLE_CARRIERS), 0, 413],
          [code(AccountRole.RECEIVABLE_CARRIERS), 2515, 0]
        ])
      )
      // The original is never touched
      expect(await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))).toMatchObject({
        id: e5?.id
      })

      const again = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_VOID
      )
      expect(again).toMatchObject({
        outcome: FinancePostingOutcome.REPLAYED,
        entryId: first.entryId
      })
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, reversesEntryId: e5?.id }
        })
      ).toBe(1)
    })

    it('answers with the reversal a person wrote first and writes no second one (HC-012)', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const e5 = await entryOf(FinancePostingKey.REMITTANCE_CONFIRM(remittanceId))
      expect(e5).not.toBeNull()
      // A person reverses the entry of the confirmation by hand before the remittance is voided
      const byHand = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.finance.entries.reverse(e5?.id ?? ''))
        .send({ memo: 'reversed by hand' })
      expect(byHand.status).toBe(CREATED)
      const personal = await owner.journalEntry.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, reversesEntryId: e5?.id }
      })
      expect(personal.createdBy).toBe(ctx.adminA.id)

      await voided(remittanceId)
      const system = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_VOID
      )
      // The system's reversal is settled by the one that exists: no second entry, and no failure left open for the remittance
      expect(system).toMatchObject({
        outcome: FinancePostingOutcome.REPLAYED,
        entryId: personal.id
      })
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, reversesEntryId: e5?.id }
        })
      ).toBe(1)
      expect(
        await owner.financePostingFailure.count({
          where: { organizationId: ctx.orgA.id, sourceId: remittanceId, resolvedAt: null }
        })
      ).toBe(0)
      // The person's entry stays as it was written
      expect(
        await owner.journalEntry.findUniqueOrThrow({ where: { id: personal.id } })
      ).toMatchObject({ createdBy: ctx.adminA.id, origin: personal.origin, memo: personal.memo })
    })

    it('has nothing to undo when the confirmation was never posted, and then posts nothing for it', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      await voided(remittanceId)
      const undo = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_VOID
      )
      expect(undo.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      // A confirmation that arrives late for a remittance already voided posts nothing either
      const late = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_CONFIRM
      )
      expect(late.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
    })

    it('closes the failure of a confirmation that never posted when the remittance is voided', async () => {
      const shipment = await delivered()
      // No E4 yet: the confirmation waits and leaves a failure
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      const open = await owner.financePostingFailure.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, sourceId: remittanceId }
      })
      expect(open.resolvedAt).toBeNull()
      await voided(remittanceId)
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_VOID)
      const closed = await owner.financePostingFailure.findFirstOrThrow({
        where: { id: open.id }
      })
      expect(closed.resolvedAt).not.toBeNull()
    })

    it('never reverses the entry of another organization', async () => {
      const shipment = await delivered()
      await post(FinanceSourceType.SHIPMENT, shipment.id, FinanceEventKind.CHARGES)
      const remittanceId = await confirmed(shipment.connectionId, [
        { shipmentId: shipment.id, reported: 2102 }
      ])
      await post(FinanceSourceType.REMITTANCE, remittanceId, FinanceEventKind.REMITTANCE_CONFIRM)
      await voided(remittanceId)
      const result = await post(
        FinanceSourceType.REMITTANCE,
        remittanceId,
        FinanceEventKind.REMITTANCE_VOID,
        ctx.orgB.id
      )
      expect(result.outcome).toBe(FinancePostingOutcome.NOTHING_TO_POST)
      expect(
        await owner.journalEntry.count({
          where: {
            organizationId: ctx.orgA.id,
            type: JournalEntryType.REVERSAL,
            sourceId: remittanceId
          }
        })
      ).toBe(0)
    })
  })
})
