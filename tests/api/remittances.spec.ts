import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CodStatus,
  OrderStatus,
  PaymentMethod,
  RemittanceLimits,
  RemittanceLineOutcome,
  RemittanceStatus,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import {
  createCarrierConnection,
  createInventoryLevel,
  createOrder,
  createShipment
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const DAY_MS = 24 * 60 * 60 * 1000

const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }

interface LineBody {
  guideNumber: string
  outcome: RemittanceLineOutcome
  expectedCents: number | null
  differenceCents: number | null
  excluded: boolean
  id: string
}
interface RemittanceBody {
  id: string
  status: RemittanceStatus
  totals: {
    expectedCents: number
    reportedCents: number
    feeCents: number
    differenceCents: number
  }
  lines: LineBody[]
}
const errorCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } }).error?.code

describe('COD remittances (TDD_17 §4.15)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let connectionId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    connectionId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'RM' }))
      .id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const shipmentRow = (id: string) => owner.shipment.findUniqueOrThrow({ where: { id } })

  // A delivered COD guide as a carrier left it, written as the owner
  const pendingShipment = (
    guideNumber: string,
    expected: number,
    over: Partial<Parameters<typeof createShipment>[1]> = {}
  ) =>
    createShipment(owner, {
      storeId: ctx.storeA.id,
      connectionId,
      guideNumber,
      status: ShipmentStatus.DELIVERED,
      codAmountCents: expected,
      codExpectedCents: expected,
      codStatus: CodStatus.PENDING_REMITTANCE,
      deliveredAt: new Date(Date.now() - 3 * DAY_MS),
      ...over
    })
  const draftWith = async (lines: { guideNumber: string; reportedCents: number }[]) => {
    const made = await asAdmin().post(ApiRoutes.remittances.list).send({ connectionId, lines })
    expect(made.status).toBe(CREATED)
    return made.body as RemittanceBody
  }
  const lineOf = (body: RemittanceBody, guide: string): LineBody => {
    const found = body.lines.find(line => line.guideNumber === guide)
    if (found === undefined) throw new Error(`no line for ${guide}`)
    return found
  }

  describe('what a delivered package is expected to bring', () => {
    // A confirmed order with one unit reserved, shipped through the api so that the engine decides the amount
    async function guideFor(
      over: { payment?: string; payer?: ShippingPayer; deducts?: boolean; cost?: number },
      connection: string
    ): Promise<string> {
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
      await owner.carrierConnection.update({
        where: { id: connection },
        data: { remittanceDeductsFee: over.deducts ?? false }
      })
      const made = await asAdmin()
        .post(ApiRoutes.shipments.forOrder(order.id))
        .send({
          connectionId: connection,
          ...(over.payer === undefined ? {} : { shippingPayer: over.payer })
        })
      expect(made.status).toBe(CREATED)
      const id = (made.body as { id: string }).id
      if (over.cost !== undefined) {
        await owner.shipment.update({ where: { id }, data: { carrierCostCents: over.cost } })
      }
      return id
    }
    const deliver = (id: string) =>
      asAdmin().post(ApiRoutes.shipments.status(id)).send({ status: ShipmentStatus.DELIVERED })

    it('writes the gross amount when the carrier does not deduct its fee', async () => {
      const id = await guideFor({ deducts: false, cost: 300 }, connectionId)
      const before = await shipmentRow(id)
      expect(before.codStatus).toBe(CodStatus.NOT_DELIVERED)
      expect((await deliver(id)).status).toBe(OK)
      const after = await shipmentRow(id)
      expect(after.codStatus).toBe(CodStatus.PENDING_REMITTANCE)
      expect(after.codExpectedCents).toBe(after.codAmountCents)
      expect(after.deliveredAt).not.toBeNull()
    })

    it('writes the amount net of the fee when the carrier deducts it and the sender pays', async () => {
      const id = await guideFor(
        { deducts: true, payer: ShippingPayer.SENDER, cost: 300 },
        connectionId
      )
      expect((await deliver(id)).status).toBe(OK)
      const after = await shipmentRow(id)
      expect(after.codExpectedCents).toBe((after.codAmountCents ?? 0) - 300)
    })

    it('deducts nothing when the recipient pays the carrier, or when no fee is known', async () => {
      const recipient = await guideFor(
        { deducts: true, payer: ShippingPayer.RECIPIENT, cost: 300 },
        connectionId
      )
      await deliver(recipient)
      const paid = await shipmentRow(recipient)
      expect(paid.codExpectedCents).toBe(paid.codAmountCents)

      const unknown = await guideFor({ deducts: true, payer: ShippingPayer.SENDER }, connectionId)
      await deliver(unknown)
      const gross = await shipmentRow(unknown)
      expect(gross.codExpectedCents).toBe(gross.codAmountCents)
    })

    it('never goes below zero when the fee is larger than the amount', async () => {
      const id = await guideFor(
        { deducts: true, payer: ShippingPayer.SENDER, cost: 99_999_999 },
        connectionId
      )
      await deliver(id)
      expect((await shipmentRow(id)).codExpectedCents).toBe(0)
    })

    it('leaves a prepaid package with no COD status', async () => {
      const id = await guideFor({ payment: PaymentMethod.CASH }, connectionId)
      await deliver(id)
      const row = await shipmentRow(id)
      expect(row.codStatus).toBe(CodStatus.NOT_APPLICABLE)
      expect(row.codExpectedCents).toBeNull()
    })

    it('voids the COD status of a package that comes back without being delivered', async () => {
      const id = await guideFor({}, connectionId)
      const back = await asAdmin()
        .post(ApiRoutes.shipments.status(id))
        .send({ status: ShipmentStatus.RETURNING })
      expect(back.status).toBe(OK)
      expect((await shipmentRow(id)).codStatus).toBe(CodStatus.VOID)
    })
  })

  describe('the draft, matched against the shipments', () => {
    it('gives every line its outcome and the totals of what would settle', async () => {
      const matched = await pendingShipment('DR-MATCH', 1000)
      const differs = await pendingShipment('DR-DIFF', 2000)
      const remitted = await pendingShipment('DR-DONE', 500, {
        codStatus: CodStatus.REMITTED,
        codRemittedCents: 500
      })
      const open = await createShipment(owner, {
        storeId: ctx.storeA.id,
        connectionId,
        guideNumber: 'DR-OPEN',
        codAmountCents: 700
      })
      const body = await draftWith([
        { guideNumber: ' dr-match ', reportedCents: 1000 },
        { guideNumber: 'DR-DIFF', reportedCents: 1800 },
        { guideNumber: 'DR-DONE', reportedCents: 500 },
        { guideNumber: 'DR-OPEN', reportedCents: 700 },
        { guideNumber: 'DR-NOPE', reportedCents: 100 },
        { guideNumber: 'DR-MATCH', reportedCents: 1000 }
      ])
      expect(body.status).toBe(RemittanceStatus.DRAFT)
      expect(body.lines.map(line => line.outcome)).toEqual([
        RemittanceLineOutcome.MATCHED,
        RemittanceLineOutcome.AMOUNT_DIFFERS,
        RemittanceLineOutcome.ALREADY_REMITTED,
        RemittanceLineOutcome.NOT_DELIVERED,
        RemittanceLineOutcome.NOT_FOUND,
        RemittanceLineOutcome.DUPLICATE_IN_FILE
      ])
      expect(body.lines[1]?.differenceCents).toBe(-200)
      expect(body.totals).toEqual({
        expectedCents: 3000,
        reportedCents: 2800,
        feeCents: 0,
        differenceCents: -200
      })
      // Nothing is written to a shipment by a draft
      expect((await shipmentRow(matched.id)).codStatus).toBe(CodStatus.PENDING_REMITTANCE)
      expect((await shipmentRow(differs.id)).codStatus).toBe(CodStatus.PENDING_REMITTANCE)
      expect((await shipmentRow(remitted.id)).codStatus).toBe(CodStatus.REMITTED)
      expect((await shipmentRow(open.id)).codStatus).toBe(CodStatus.NOT_DELIVERED)
    })

    it('holds a line against the fee it reports when the fee was unknown at delivery', async () => {
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { remittanceDeductsFee: true }
      })
      await pendingShipment('FEE-LATE', 1000, { codExpectedCents: 1000 })
      const body = await asAdmin()
        .post(ApiRoutes.remittances.list)
        .send({
          connectionId,
          lines: [{ guideNumber: 'FEE-LATE', reportedCents: 880, reportedFeeCents: 120 }]
        })
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { remittanceDeductsFee: false }
      })
      const draft = body.body as RemittanceBody
      expect(lineOf(draft, 'FEE-LATE').outcome).toBe(RemittanceLineOutcome.MATCHED)
      expect(lineOf(draft, 'FEE-LATE').expectedCents).toBe(880)
      expect(draft.totals.feeCents).toBe(120)
    })

    it('holds a line against the net amount when the cost arrived after the delivery', async () => {
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { remittanceDeductsFee: true }
      })
      await pendingShipment('COST-LATE', 1000, { codExpectedCents: 1000, carrierCostCents: 300 })
      const body = await draftWith([{ guideNumber: 'COST-LATE', reportedCents: 700 }])
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { remittanceDeductsFee: false }
      })
      expect(lineOf(body, 'COST-LATE').outcome).toBe(RemittanceLineOutcome.MATCHED)
    })

    it('lets the second line of a guide count when the first one is left out', async () => {
      await pendingShipment('DUP-EXCL', 500)
      const draft = await draftWith([
        { guideNumber: 'DUP-EXCL', reportedCents: 450 },
        { guideNumber: 'dup-excl', reportedCents: 500 }
      ])
      expect(draft.lines.map(line => line.outcome)).toEqual([
        RemittanceLineOutcome.AMOUNT_DIFFERS,
        RemittanceLineOutcome.DUPLICATE_IN_FILE
      ])
      const first = draft.lines[0]
      if (first === undefined) throw new Error('no first line')
      const left = await asAdmin()
        .patch(ApiRoutes.remittances.lineById(draft.id, first.id))
        .send({ excluded: true })
      expect((left.body as RemittanceBody).lines.map(line => line.outcome)).toEqual([
        RemittanceLineOutcome.AMOUNT_DIFFERS,
        RemittanceLineOutcome.MATCHED
      ])
    })

    it('keeps two guides that differ only in case apart', async () => {
      const upper = await pendingShipment('CASE-ab', 300)
      const lower = await pendingShipment('case-AB', 400)
      const draft = await draftWith([
        { guideNumber: 'CASE-ab', reportedCents: 300 },
        { guideNumber: 'case-AB', reportedCents: 400 }
      ])
      expect(draft.lines.map(line => line.outcome)).toEqual([
        RemittanceLineOutcome.MATCHED,
        RemittanceLineOutcome.MATCHED
      ])
      await asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      expect((await shipmentRow(upper.id)).codStatus).toBe(CodStatus.REMITTED)
      expect((await shipmentRow(lower.id)).codStatus).toBe(CodStatus.REMITTED)
    })

    it('takes a file of six hundred rows in one request and refuses more lines than a settlement file holds', async () => {
      const lines = Array.from({ length: 600 }, (_, index) => ({
        guideNumber: `BULK-${index}`,
        reportedCents: 1
      }))
      const made = await asAdmin().post(ApiRoutes.remittances.list).send({ connectionId, lines })
      expect(made.status).toBe(CREATED)
      const draft = made.body as RemittanceBody
      expect(draft.lines).toHaveLength(600)
      await owner.codRemittanceLine.createMany({
        data: Array.from({ length: RemittanceLimits.MAX_LINES - 601 }, (_, index) => ({
          storeId: ctx.storeA.id,
          remittanceId: draft.id,
          position: 601 + index,
          guideNumber: `FILL-${index}`,
          reportedCents: 1,
          outcome: RemittanceLineOutcome.NOT_FOUND
        }))
      })
      const over = await asAdmin()
        .post(ApiRoutes.remittances.lines(draft.id))
        .send({
          lines: [
            { guideNumber: 'ONE-MORE', reportedCents: 1 },
            { guideNumber: 'TWO-MORE', reportedCents: 1 }
          ]
        })
      expect(over.status).toBe(400)
      expect(errorCode(over.body)).toBe(ErrorCodes.REMITTANCE_TOO_MANY_LINES)
    })

    it('lets a line be left out, annotated and added by hand, and a draft be discarded', async () => {
      await pendingShipment('HAND-1', 400)
      await pendingShipment('HAND-2', 600)
      const draft = await draftWith([{ guideNumber: 'HAND-1', reportedCents: 400 }])
      const added = await asAdmin()
        .post(ApiRoutes.remittances.lines(draft.id))
        .send({ lines: [{ guideNumber: 'HAND-2', reportedCents: 600 }] })
      expect(added.status).toBe(CREATED)
      expect((added.body as RemittanceBody).totals.reportedCents).toBe(1000)
      const second = lineOf(added.body as RemittanceBody, 'HAND-2')
      const left = await asAdmin()
        .patch(ApiRoutes.remittances.lineById(draft.id, second.id))
        .send({ excluded: true, note: 'not in the file' })
      expect(left.status).toBe(OK)
      expect((left.body as RemittanceBody).totals.reportedCents).toBe(400)
      const gone = await asAdmin().delete(ApiRoutes.remittances.byId(draft.id))
      expect(gone.status).toBe(NO_CONTENT)
      expect((await asAdmin().get(ApiRoutes.remittances.byId(draft.id))).status).toBe(NOT_FOUND)
    })

    it('refuses a connection of another store, an amount that is not whole cents and a field it does not know', async () => {
      const foreign = await createCarrierConnection(owner, { storeId: ctx.storeB.id })
      const other = await asAdmin()
        .post(ApiRoutes.remittances.list)
        .send({ connectionId: foreign.id })
      expect(other.status).toBe(NOT_FOUND)
      const bad = await asAdmin()
        .post(ApiRoutes.remittances.list)
        .send({ connectionId, lines: [{ guideNumber: 'X', reportedCents: 10.5 }] })
      expect(bad.status).toBe(400)
      const stray = await asAdmin()
        .post(ApiRoutes.remittances.list)
        .send({ connectionId, storeId: ctx.storeB.id })
      expect(stray.status).toBe(400)
    })
  })

  describe('confirming', () => {
    it('settles the matching lines, marks the differing ones and freezes the remittance', async () => {
      const ok = await pendingShipment('CF-OK', 1000)
      const bad = await pendingShipment('CF-BAD', 2000)
      const out = await pendingShipment('CF-OUT', 3000)
      const draft = await draftWith([
        { guideNumber: 'CF-OK', reportedCents: 1000 },
        { guideNumber: 'CF-BAD', reportedCents: 1500 },
        { guideNumber: 'CF-OUT', reportedCents: 3000 }
      ])
      await asAdmin()
        .patch(ApiRoutes.remittances.lineById(draft.id, lineOf(draft, 'CF-OUT').id))
        .send({ excluded: true })
      const done = await asAdmin()
        .post(ApiRoutes.remittances.confirm(draft.id))
        .send({ reference: 'LIQ-1', receivedOn: '2026-11-12' })
      expect(done.status).toBe(OK)
      const body = done.body as RemittanceBody & { reference: string; receivedOn: string }
      expect(body.status).toBe(RemittanceStatus.CONFIRMED)
      expect(body.totals).toEqual({
        expectedCents: 3000,
        reportedCents: 2500,
        feeCents: 0,
        differenceCents: -500
      })
      expect(body.reference).toBe('LIQ-1')
      expect(body.receivedOn).toBe('2026-11-12')

      const okRow = await shipmentRow(ok.id)
      expect(okRow.codStatus).toBe(CodStatus.REMITTED)
      expect(okRow.codRemittedCents).toBe(1000)
      expect(okRow.codRemittanceId).toBe(draft.id)
      const badRow = await shipmentRow(bad.id)
      expect(badRow.codStatus).toBe(CodStatus.DISCREPANCY)
      expect(badRow.codRemittedCents).toBe(1500)
      // The line that was left out is not touched
      const outRow = await shipmentRow(out.id)
      expect(outRow.codStatus).toBe(CodStatus.PENDING_REMITTANCE)
      expect(outRow.codRemittanceId).toBeNull()

      // Immutable: no new line, no change, no second confirmation
      const more = await asAdmin()
        .post(ApiRoutes.remittances.lines(draft.id))
        .send({ lines: [{ guideNumber: 'CF-OUT', reportedCents: 3000 }] })
      expect(more.status).toBe(CONFLICT)
      expect(errorCode(more.body)).toBe(ErrorCodes.REMITTANCE_ALREADY_CONFIRMED)
      const again = await asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      expect(again.status).toBe(CONFLICT)
      expect(errorCode(again.body)).toBe(ErrorCodes.REMITTANCE_ALREADY_CONFIRMED)
      expect((await asAdmin().delete(ApiRoutes.remittances.byId(draft.id))).status).toBe(CONFLICT)
    })

    it('keeps totals that do not fit in 32 bits', async () => {
      const guides = Array.from({ length: 22 }, (_, index) => `BIG-${index}`)
      for (const guide of guides) await pendingShipment(guide, 100_000_000)
      const draft = await draftWith(
        guides.map(guideNumber => ({ guideNumber, reportedCents: 100_000_000 }))
      )
      const done = await asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      expect(done.status).toBe(OK)
      expect((done.body as RemittanceBody).totals.reportedCents).toBe(2_200_000_000)
    })

    it('writes the amount the line was held against, so what is owed agrees with the remittance', async () => {
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { remittanceDeductsFee: true }
      })
      const shipment = await pendingShipment('EXP-NET', 1000, {
        codExpectedCents: 1000,
        carrierCostCents: 300
      })
      const draft = await draftWith([{ guideNumber: 'EXP-NET', reportedCents: 600 }])
      await asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { remittanceDeductsFee: false }
      })
      const row = await shipmentRow(shipment.id)
      expect(row.codStatus).toBe(CodStatus.DISCREPANCY)
      expect(row.codExpectedCents).toBe(700)
      expect(row.codRemittedCents).toBe(600)
    })

    it('ends with one confirmation when two overlap', async () => {
      await pendingShipment('RACE-1', 700)
      const draft = await draftWith([{ guideNumber: 'RACE-1', reportedCents: 700 }])
      const results = await Promise.all([
        asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({}),
        asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({}),
        asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      ])
      expect(results.filter(result => result.status === OK)).toHaveLength(1)
      expect(results.filter(result => result.status === CONFLICT)).toHaveLength(2)
      const row = await owner.codRemittance.findUniqueOrThrow({ where: { id: draft.id } })
      expect(row.status).toBe(RemittanceStatus.CONFIRMED)
      expect(Number(row.reportedCents)).toBe(700)
    })

    it('does not settle a shipment that another remittance settled since the draft was made', async () => {
      const shipment = await pendingShipment('TWICE-1', 900)
      const first = await draftWith([{ guideNumber: 'TWICE-1', reportedCents: 900 }])
      const second = await draftWith([{ guideNumber: 'TWICE-1', reportedCents: 900 }])
      expect((await asAdmin().post(ApiRoutes.remittances.confirm(first.id)).send({})).status).toBe(
        OK
      )
      const late = await asAdmin().post(ApiRoutes.remittances.confirm(second.id)).send({})
      expect(late.status).toBe(CONFLICT)
      expect(errorCode(late.body)).toBe(ErrorCodes.REMITTANCE_NOTHING_TO_SETTLE)
      const row = await shipmentRow(shipment.id)
      expect(row.codRemittanceId).toBe(first.id)
      // The draft takes the new state of the shipment into its lines at its next change
      const line = lineOf(second, 'TWICE-1')
      const touched = await asAdmin()
        .patch(ApiRoutes.remittances.lineById(second.id, line.id))
        .send({ note: 'again' })
      expect(lineOf(touched.body as RemittanceBody, 'TWICE-1').outcome).toBe(
        RemittanceLineOutcome.ALREADY_REMITTED
      )
    })

    it('refuses to confirm a remittance with nothing to settle', async () => {
      const draft = await draftWith([{ guideNumber: 'NOTHING-HERE', reportedCents: 100 }])
      const refused = await asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      expect(refused.status).toBe(CONFLICT)
      expect(errorCode(refused.body)).toBe(ErrorCodes.REMITTANCE_NOTHING_TO_SETTLE)
      expect(
        (await owner.codRemittance.findUniqueOrThrow({ where: { id: draft.id } })).status
      ).toBe(RemittanceStatus.DRAFT)
    })

    it('lets a shipment in discrepancy be settled by a later remittance', async () => {
      const shipment = await pendingShipment('LATER-1', 1000)
      const first = await draftWith([{ guideNumber: 'LATER-1', reportedCents: 800 }])
      await asAdmin().post(ApiRoutes.remittances.confirm(first.id)).send({})
      expect((await shipmentRow(shipment.id)).codStatus).toBe(CodStatus.DISCREPANCY)
      const second = await draftWith([{ guideNumber: 'LATER-1', reportedCents: 1000 }])
      expect(lineOf(second, 'LATER-1').outcome).toBe(RemittanceLineOutcome.MATCHED)
      await asAdmin().post(ApiRoutes.remittances.confirm(second.id)).send({})
      const row = await shipmentRow(shipment.id)
      expect(row.codStatus).toBe(CodStatus.REMITTED)
      expect(row.codRemittanceId).toBe(second.id)
    })
  })

  describe('voiding', () => {
    it('returns the shipments to waiting and keeps the remittance as evidence', async () => {
      const a = await pendingShipment('VD-A', 1000)
      const b = await pendingShipment('VD-B', 2000)
      const draft = await draftWith([
        { guideNumber: 'VD-A', reportedCents: 1000 },
        { guideNumber: 'VD-B', reportedCents: 1700 }
      ])
      await asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      const voided = await asAdmin()
        .post(ApiRoutes.remittances.void(draft.id))
        .send({ reason: 'the carrier sent it twice' })
      expect(voided.status).toBe(OK)
      expect((voided.body as { voidReason: string }).voidReason).toBe('the carrier sent it twice')
      expect((voided.body as RemittanceBody).status).toBe(RemittanceStatus.VOIDED)
      for (const id of [a.id, b.id]) {
        const row = await shipmentRow(id)
        expect(row.codStatus).toBe(CodStatus.PENDING_REMITTANCE)
        expect(row.codRemittedCents).toBeNull()
        expect(row.codRemittanceId).toBeNull()
      }
      const again = await asAdmin().post(ApiRoutes.remittances.void(draft.id)).send({})
      expect(again.status).toBe(CONFLICT)
      expect(errorCode(again.body)).toBe(ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION)
      // A draft cannot be voided either
      const fresh = await draftWith([{ guideNumber: 'VD-A', reportedCents: 1000 }])
      expect((await asAdmin().post(ApiRoutes.remittances.void(fresh.id)).send({})).status).toBe(
        CONFLICT
      )
      // The settled shipments can be remitted again by a new remittance
      expect(lineOf(fresh, 'VD-A').outcome).toBe(RemittanceLineOutcome.MATCHED)
    })

    it('refuses to change a voided remittance, with the status error and not the confirmed one', async () => {
      await pendingShipment('VD-EDIT', 100)
      const draft = await draftWith([{ guideNumber: 'VD-EDIT', reportedCents: 100 }])
      await asAdmin().post(ApiRoutes.remittances.confirm(draft.id)).send({})
      await asAdmin().post(ApiRoutes.remittances.void(draft.id)).send({})
      const refused = await asAdmin()
        .post(ApiRoutes.remittances.lines(draft.id))
        .send({ lines: [{ guideNumber: 'VD-EDIT', reportedCents: 1 }] })
      expect(refused.status).toBe(CONFLICT)
      expect(errorCode(refused.body)).toBe(ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION)
    })

    it('leaves a shipment that a later remittance settled alone', async () => {
      const shipment = await pendingShipment('VD-LATE', 1000)
      const first = await draftWith([{ guideNumber: 'VD-LATE', reportedCents: 600 }])
      await asAdmin().post(ApiRoutes.remittances.confirm(first.id)).send({})
      const second = await draftWith([{ guideNumber: 'VD-LATE', reportedCents: 1000 }])
      await asAdmin().post(ApiRoutes.remittances.confirm(second.id)).send({})
      await asAdmin().post(ApiRoutes.remittances.void(first.id)).send({})
      const row = await shipmentRow(shipment.id)
      expect(row.codStatus).toBe(CodStatus.REMITTED)
      expect(row.codRemittanceId).toBe(second.id)
    })
  })

  describe('what is still owed', () => {
    it("answers a zero for a connection that owes nothing and a 404 for one that is not the store's", async () => {
      const quiet = await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'QT' })
      const none = await asAdmin().get(`${ApiRoutes.remittances.pending}?connectionId=${quiet.id}`)
      expect(none.status).toBe(OK)
      expect(none.body).toMatchObject([
        { connectionId: quiet.id, count: 0, totalOwedCents: 0, shipments: [] }
      ])
      const foreign = await createCarrierConnection(owner, { storeId: ctx.storeB.id })
      expect(
        (await asAdmin().get(`${ApiRoutes.remittances.pending}?connectionId=${foreign.id}`)).status
      ).toBe(NOT_FOUND)
    })

    it('lists the pending shipments of a connection with their age and the total owed', async () => {
      const own = await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'PN' })
      await pendingShipment('PN-1', 1000, {
        connectionId: own.id,
        deliveredAt: new Date(Date.now() - 10 * DAY_MS)
      })
      await pendingShipment('PN-2', 500, {
        connectionId: own.id,
        deliveredAt: new Date(Date.now() - 2 * DAY_MS)
      })
      await pendingShipment('PN-3', 900, {
        connectionId: own.id,
        codStatus: CodStatus.DISCREPANCY,
        codRemittedCents: 400
      })
      await pendingShipment('PN-4', 300, { connectionId: own.id, codStatus: CodStatus.REMITTED })
      const all = await asAdmin().get(ApiRoutes.remittances.pending)
      expect(all.status).toBe(OK)
      const group = (
        all.body as {
          connectionId: string
          count: number
          totalOwedCents: number
          shipments: unknown[]
        }[]
      ).find(item => item.connectionId === own.id)
      expect(group).toMatchObject({ count: 3, totalOwedCents: 1000 + 500 + 500, shipments: [] })

      const one = await asAdmin().get(`${ApiRoutes.remittances.pending}?connectionId=${own.id}`)
      const detail = (
        one.body as {
          oldestAgeDays: number
          shipments: { guideNumber: string; owedCents: number; ageDays: number | null }[]
        }[]
      )[0]
      expect(detail?.oldestAgeDays).toBe(10)
      // The oldest first
      expect(detail?.shipments.map(item => item.guideNumber)).toEqual(['PN-1', 'PN-3', 'PN-2'])
      expect(detail?.shipments.find(item => item.guideNumber === 'PN-3')?.owedCents).toBe(500)
    })
  })

  describe('who may', () => {
    it('lets a viewer read but not change, and an agent do neither', async () => {
      const draft = await draftWith([{ guideNumber: 'PERM-1', reportedCents: 1 }])
      const asViewer = () => api(app, ctx.viewerA, ctx.storeA)
      const asAgent = () => api(app, ctx.agentA, ctx.storeA)
      expect((await asViewer().get(ApiRoutes.remittances.byId(draft.id))).status).toBe(OK)
      expect((await asViewer().get(ApiRoutes.remittances.pending)).status).toBe(OK)
      expect((await asViewer().get(ApiRoutes.remittances.list)).status).toBe(OK)
      for (const request of [
        asViewer().post(ApiRoutes.remittances.list).send({ connectionId }),
        asViewer().post(ApiRoutes.remittances.confirm(draft.id)).send({}),
        asViewer().post(ApiRoutes.remittances.void(draft.id)).send({}),
        asViewer().post(ApiRoutes.remittances.lines(draft.id)).send({ lines: [] }),
        asViewer().delete(ApiRoutes.remittances.byId(draft.id)),
        asAgent().get(ApiRoutes.remittances.list),
        asAgent().get(ApiRoutes.remittances.pending)
      ]) {
        expect((await request).status).toBe(FORBIDDEN)
      }
      expect(
        (await owner.codRemittance.findUniqueOrThrow({ where: { id: draft.id } })).status
      ).toBe(RemittanceStatus.DRAFT)
    })

    it('does not show a remittance, or its pending list, to another store', async () => {
      const draft = await draftWith([{ guideNumber: 'OTHER-1', reportedCents: 1 }])
      const asOther = () => api(app, ctx.adminB, ctx.storeB)
      expect((await asOther().get(ApiRoutes.remittances.byId(draft.id))).status).toBe(NOT_FOUND)
      expect((await asOther().post(ApiRoutes.remittances.confirm(draft.id)).send({})).status).toBe(
        NOT_FOUND
      )
      const pending = await asOther().get(ApiRoutes.remittances.pending)
      expect(pending.body).toEqual([])
    })
  })
})
