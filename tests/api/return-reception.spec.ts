import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { type Permission, Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  OrderReturnCondition,
  ReceptionBatchStatus,
  ReceptionItemOutcome,
  ReceptionLimits,
  ReceptionScanResults,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createCarrierConnection, createShipment } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'
import { type CreatedBody, ordersKit, type OrdersKit } from '../helpers/orders'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ItemBody {
  id: string
  shipmentId: string
  guideNumber: string | null
  reason: string
  condition: string
  note: string | null
  lines: unknown[]
  flagCustomer: boolean
  flagReason: string | null
  outcome: string | null
  errorCode: string | null
  returnId: string | null
  flagApplied: boolean
  customerIsCaution: boolean
  orderItems: { id: string; quantity: number }[]
}
interface BatchBody {
  id: string
  status: string
  completedAt: string | null
  counts: { total: number; received: number; failed: number; pending: number }
  items: ItemBody[]
}
interface ScanBody {
  result: string
  item?: ItemBody
  candidates?: { shipmentId: string }[]
}

// The reception of the packages that come back by scanner (Step 4.12 PR R2, TDD_17 §4.16)
describe('Return reception by scanner', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  let viewer: Actor
  let manager: Actor
  let managerAndFlagger: Actor

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
    const grant = (name: string, permissions: Permission[]) =>
      actorWithPermissions(owner, app, {
        prefix,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        name,
        permissions
      })
    viewer = await grant('receptionViewer', [Permissions.RETURNS_VIEW])
    manager = await grant('receptionManager', [
      Permissions.RETURNS_VIEW,
      Permissions.RETURNS_MANAGE
    ])
    managerAndFlagger = await grant('receptionFlagger', [
      Permissions.RETURNS_VIEW,
      Permissions.RETURNS_MANAGE,
      Permissions.CUSTOMERS_FLAG_CAUTION
    ])
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const as = (actor: Actor) => api(app, actor, ctx.storeA)

  async function newBatch(actor: Actor = ctx.adminA): Promise<string> {
    const response = await as(actor).post(ApiRoutes.returns.reception.batches)
    expect(response.status).toBe(CREATED)
    return (response.body as BatchBody).id
  }
  const scan = (batchId: string, body: Record<string, unknown>, actor: Actor = ctx.adminA) =>
    as(actor).post(ApiRoutes.returns.reception.scan(batchId)).send(body)
  const read = async (batchId: string) =>
    (await asAdmin().get(ApiRoutes.returns.reception.batchById(batchId))).body as BatchBody
  const complete = (batchId: string, actor: Actor = ctx.adminA) =>
    as(actor).post(ApiRoutes.returns.reception.complete(batchId))
  const orderOf = (id: string) => owner.order.findUniqueOrThrow({ where: { id } })

  // A shipped order of 4 units with a guide in the given status
  async function shipped(options: { status?: ShipmentStatus; guideNumber?: string } = {}) {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 4 }] })
    const created = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)
    const order = (created.body as CreatedBody).order
    for (const next of ['CONFIRMED', 'SHIPPED']) {
      await kit.asAdmin().post(ApiRoutes.orders.status(order.id)).send({ status: next })
    }
    const connection = await createCarrierConnection(owner, {
      storeId: ctx.storeA.id,
      prefix: `R${randomUUID()
        .slice(0, 4)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '0')}`
    })
    const guideNumber = options.guideNumber ?? `G-${randomUUID()}`
    const shipment = await owner.shipment.create({
      data: {
        storeId: ctx.storeA.id,
        orderId: order.id,
        connectionId: connection.id,
        serviceCode: connection.serviceCode,
        shippingPayer: ShippingPayer.SENDER,
        currency: 'USD',
        status: options.status ?? ShipmentStatus.RETURNING,
        guideNumber,
        idempotencyKey: `reception-${randomUUID()}`,
        createdBy: 'system'
      },
      select: { id: true }
    })
    const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    const row = await orderOf(order.id)
    return {
      order,
      product,
      guideNumber,
      shipmentId: shipment.id,
      itemId: item.id,
      customerId: row.customerId
    }
  }

  describe('the batch', () => {
    it('is created as an empty draft, listed and read back', async () => {
      const batchId = await newBatch()

      const read1 = await asAdmin().get(ApiRoutes.returns.reception.batchById(batchId))
      expect(read1.status).toBe(OK)
      expect(read1.body).toMatchObject({
        id: batchId,
        status: ReceptionBatchStatus.DRAFT,
        completedAt: null,
        counts: { total: 0, received: 0, failed: 0, pending: 0 },
        items: []
      })
      const list = await asAdmin().get(ApiRoutes.returns.reception.batches)
      expect(list.status).toBe(OK)
      expect((list.body as BatchBody[]).map(row => row.id)).toContain(batchId)
      const drafts = await asAdmin().get(
        `${ApiRoutes.returns.reception.batches}?status=${ReceptionBatchStatus.COMPLETED}`
      )
      expect((drafts.body as BatchBody[]).map(row => row.id)).not.toContain(batchId)
      expect(
        (await asAdmin().get(`${ApiRoutes.returns.reception.batches}?status=nonsense`)).status
      ).toBe(BAD_REQUEST)
    })

    it('is read with returns:view and changed only with returns:manage', async () => {
      const batchId = await newBatch(manager)
      expect((await as(viewer).get(ApiRoutes.returns.reception.batchById(batchId))).status).toBe(OK)
      expect((await as(viewer).get(ApiRoutes.returns.reception.batches)).status).toBe(OK)
      expect((await as(viewer).post(ApiRoutes.returns.reception.batches)).status).toBe(FORBIDDEN)
      expect((await scan(batchId, { code: 'x' }, viewer)).status).toBe(FORBIDDEN)
      expect((await complete(batchId, viewer)).status).toBe(FORBIDDEN)
      expect(
        (
          await as(viewer)
            .patch(ApiRoutes.returns.reception.itemById(batchId, randomUUID()))
            .send({ note: 'x' })
        ).status
      ).toBe(FORBIDDEN)
      expect(
        (await as(viewer).delete(ApiRoutes.returns.reception.itemById(batchId, randomUUID())))
          .status
      ).toBe(FORBIDDEN)
    })

    it('answers 404 for a batch that does not exist', async () => {
      const missing = randomUUID()
      expect((await asAdmin().get(ApiRoutes.returns.reception.batchById(missing))).status).toBe(
        NOT_FOUND
      )
      expect((await scan(missing, { code: 'x' })).status).toBe(NOT_FOUND)
      expect((await complete(missing)).status).toBe(NOT_FOUND)
    })
  })

  describe('scanning a code', () => {
    it('finds the shipment ignoring the case and the blanks, and adds it with the defaults', async () => {
      const { guideNumber, shipmentId, order } = await shipped({ guideNumber: 'Gd 77 Ab-1' })
      const batchId = await newBatch()

      const response = await scan(batchId, { code: '  gD77   aB-1 ' })

      expect(response.status).toBe(OK)
      const body = response.body as ScanBody
      expect(body.result).toBe(ReceptionScanResults.ADDED)
      expect(body.item).toMatchObject({
        shipmentId,
        guideNumber,
        reason: 'DELIVERY_FAILED',
        condition: OrderReturnCondition.RESELLABLE,
        note: null,
        lines: [],
        flagCustomer: false,
        flagReason: null,
        outcome: null,
        customerIsCaution: false
      })
      expect(body.item?.orderItems).toHaveLength(1)
      expect((await read(batchId)).counts).toEqual({
        total: 1,
        received: 0,
        failed: 0,
        pending: 1
      })
      // A scan changes nothing about the order or the stock until the batch is completed
      expect((await orderOf(order.id)).status).toBe('SHIPPED')
    })

    it('says nothing matched, with no side effect, for an unknown code and for a guide of another store', async () => {
      const batchId = await newBatch()
      const unknown = await scan(batchId, { code: `nope-${randomUUID()}` })
      expect(unknown.status).toBe(OK)
      expect(unknown.body).toEqual({ result: ReceptionScanResults.NOT_FOUND })

      // A guide of another store answers to nothing here, even spelled the same
      const other = await createShipment(owner, {
        storeId: ctx.storeB.id,
        status: ShipmentStatus.RETURNING
      })
      const foreignGuide = (await owner.shipment.findUniqueOrThrow({ where: { id: other.id } }))
        .guideNumber as string
      const foreign = await scan(batchId, { code: foreignGuide })
      expect(foreign.body).toEqual({ result: ReceptionScanResults.NOT_FOUND })
      expect((await read(batchId)).items).toHaveLength(0)
    })

    it('asks which one when two shipments answer to the code, and takes the one that is picked', async () => {
      const first = await shipped({ guideNumber: `SHARED-${randomUUID()}` })
      const second = await shipped({ guideNumber: first.guideNumber })
      const batchId = await newBatch()

      const asked = await scan(batchId, { code: first.guideNumber })
      const answer = asked.body as ScanBody
      expect(answer.result).toBe(ReceptionScanResults.AMBIGUOUS)
      expect(answer.candidates?.map(candidate => candidate.shipmentId).sort()).toEqual(
        [first.shipmentId, second.shipmentId].sort()
      )
      expect((await read(batchId)).items).toHaveLength(0)

      const picked = await scan(batchId, { code: first.guideNumber, shipmentId: second.shipmentId })
      expect((picked.body as ScanBody).item?.shipmentId).toBe(second.shipmentId)
      // A shipment that does not answer to the code is not accepted because it was named
      const other = await shipped()
      expect(
        (await scan(batchId, { code: first.guideNumber, shipmentId: other.shipmentId })).body
      ).toEqual({ result: ReceptionScanResults.NOT_FOUND })
    })

    it('refuses the same shipment twice in a batch', async () => {
      const { guideNumber } = await shipped()
      const batchId = await newBatch()
      await scan(batchId, { code: guideNumber })

      const again = await scan(batchId, { code: guideNumber })

      expect(again.status).toBe(CONFLICT)
      expect(again.body).toMatchObject({
        error: { code: ErrorCodes.RECEPTION_DUPLICATE_SCAN }
      })
    })

    it.each([ShipmentStatus.LABEL_CREATED, ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED])(
      'refuses a shipment that is %s: no package comes back from it',
      async status => {
        const { guideNumber } = await shipped({ status })
        const batchId = await newBatch()

        const response = await scan(batchId, { code: guideNumber })

        expect(response.status).toBe(CONFLICT)
        expect(response.body).toMatchObject({
          error: { code: ErrorCodes.RECEPTION_SHIPMENT_NOT_ELIGIBLE }
        })
        expect((await read(batchId)).items).toHaveLength(0)
      }
    )

    it('refuses the guide of a return leg: its package is received through its return', async () => {
      const { guideNumber, shipmentId } = await shipped()
      await owner.shipment
        .update({ where: { id: shipmentId }, data: { kind: 'return' } })
        .catch(() => undefined)
      const batchId = await newBatch()

      const response = await scan(batchId, { code: guideNumber })

      // Either the database refuses to make a return-kind guide without its return, or the scan refuses it
      const stored = await owner.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
      if (stored.kind === 'return') {
        expect(response.status).toBe(CONFLICT)
        expect((response.body as { error: { code: string } }).error.code).toBe(
          ErrorCodes.RECEPTION_SHIPMENT_NOT_ELIGIBLE
        )
      } else {
        expect(response.status).toBe(OK)
      }
    })

    it('refuses a body that is not a code and one with a field it does not know', async () => {
      const batchId = await newBatch()
      expect((await scan(batchId, { code: '' })).status).toBe(BAD_REQUEST)
      expect(
        (await scan(batchId, { code: 'x'.repeat(ReceptionLimits.CODE_MAX_LENGTH + 1) })).status
      ).toBe(BAD_REQUEST)
      expect((await scan(batchId, { code: 'x', storeId: ctx.storeB.id })).status).toBe(BAD_REQUEST)
      expect((await scan(batchId, { code: 'x', shipmentId: 'not-a-uuid' })).status).toBe(
        BAD_REQUEST
      )
    })
  })

  describe('deciding about a package', () => {
    async function withItem() {
      const made = await shipped()
      const batchId = await newBatch()
      const item = ((await scan(batchId, { code: made.guideNumber })).body as ScanBody)
        .item as ItemBody
      const patch = (body: Record<string, unknown>, actor: Actor = ctx.adminA) =>
        as(actor).patch(ApiRoutes.returns.reception.itemById(batchId, item.id)).send(body)
      return { ...made, batchId, item, patch }
    }

    it('takes a reason, a condition, a note and the lines of a partial package', async () => {
      const { patch, itemId } = await withItem()

      const response = await patch({
        reason: 'REFUSED_BY_CUSTOMER',
        condition: OrderReturnCondition.DEFECTIVE,
        note: 'The customer did not want it',
        lines: [{ orderItemId: itemId, quantity: 2, condition: OrderReturnCondition.RESELLABLE }]
      })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        reason: 'REFUSED_BY_CUSTOMER',
        condition: OrderReturnCondition.DEFECTIVE,
        note: 'The customer did not want it',
        lines: [{ orderItemId: itemId, quantity: 2, condition: OrderReturnCondition.RESELLABLE }]
      })
      expect(((await patch({ note: null })).body as ItemBody).note).toBeNull()
    })

    it('refuses what is not a decision: nothing to change, an unknown reason, a line of another order', async () => {
      const { patch, itemId } = await withItem()
      const other = await shipped()
      expect((await patch({})).status).toBe(BAD_REQUEST)
      expect((await patch({ reason: 'NOT_A_REASON' })).status).toBe(BAD_REQUEST)
      expect((await patch({ storeId: ctx.storeB.id })).status).toBe(BAD_REQUEST)
      expect(
        (
          await patch({
            lines: [
              { orderItemId: other.itemId, quantity: 1, condition: OrderReturnCondition.RESELLABLE }
            ]
          })
        ).status
      ).toBe(BAD_REQUEST)
      expect(
        (
          await patch({
            lines: [
              { orderItemId: itemId, quantity: 1, condition: OrderReturnCondition.RESELLABLE },
              { orderItemId: itemId, quantity: 1, condition: OrderReturnCondition.DAMAGED }
            ]
          })
        ).status
      ).toBe(BAD_REQUEST)
    })

    it('flags the customer only for who may flag, and asks for a reason or a note', async () => {
      const { patch, batchId, item } = await withItem()

      // returns:manage alone does not decide that a person is flagged
      const denied = await as(manager)
        .patch(ApiRoutes.returns.reception.itemById(batchId, item.id))
        .send({ flagCustomer: true, flagReason: 'Refused twice' })
      expect(denied.status).toBe(FORBIDDEN)

      // With a flagging permission it still needs something to say
      const bare = await as(managerAndFlagger)
        .patch(ApiRoutes.returns.reception.itemById(batchId, item.id))
        .send({ flagCustomer: true })
      expect(bare.status).toBe(BAD_REQUEST)

      const ok = await as(managerAndFlagger)
        .patch(ApiRoutes.returns.reception.itemById(batchId, item.id))
        .send({ flagCustomer: true, flagReason: 'Refused twice' })
      expect(ok.status).toBe(OK)
      expect(ok.body).toMatchObject({ flagCustomer: true, flagReason: 'Refused twice' })

      // The reason of a flag is read by who may flag or read customers, and not by the rest
      const seenByManager = await as(manager).get(ApiRoutes.returns.reception.batchById(batchId))
      expect((seenByManager.body as BatchBody).items[0]?.flagCustomer).toBe(true)
      expect((seenByManager.body as BatchBody).items[0]?.flagReason).toBeNull()
      const seenByFlagger = await as(managerAndFlagger).get(
        ApiRoutes.returns.reception.batchById(batchId)
      )
      expect((seenByFlagger.body as BatchBody).items[0]?.flagReason).toBe('Refused twice')

      // Turning the flag off drops its reason
      const off = await patch({ flagCustomer: false })
      expect(off.body).toMatchObject({ flagCustomer: false, flagReason: null })
    })

    it('takes the reason of the flag from the note when none is written', async () => {
      const { batchId, item, customerId } = await withItem()
      await as(managerAndFlagger)
        .patch(ApiRoutes.returns.reception.itemById(batchId, item.id))
        .send({ note: 'Said it was a gift\nfor someone else', flagCustomer: true })

      await complete(batchId, managerAndFlagger)

      const row = await owner.customer.findUniqueOrThrow({ where: { id: customerId } })
      expect(row).toMatchObject({
        isCaution: true,
        cautionReason: 'Said it was a gift for someone else',
        cautionSetBy: managerAndFlagger.id
      })
    })

    it('preselects the flag on a refusal when the store asks for it, for who may flag', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { preferences: { returns: { preselectCautionOnRefusal: true } } }
      })
      try {
        const { batchId, item } = await withItem()
        const edit = (actor: Actor, body: Record<string, unknown>) =>
          as(actor).patch(ApiRoutes.returns.reception.itemById(batchId, item.id)).send(body)

        // Someone who may not flag gets no preselection, and no error for it
        const quiet = await edit(manager, { reason: 'REFUSED_BY_CUSTOMER', note: 'No' })
        expect(quiet.status).toBe(OK)
        expect((quiet.body as ItemBody).flagCustomer).toBe(false)
        await edit(manager, { reason: 'OTHER' })

        const picked = await edit(managerAndFlagger, { reason: 'REFUSED_BY_CUSTOMER', note: 'No' })
        expect((picked.body as ItemBody).flagCustomer).toBe(true)
        // An explicit choice wins over the preselection
        await edit(managerAndFlagger, { reason: 'OTHER' })
        const explicit = await edit(managerAndFlagger, {
          reason: 'REFUSED_BY_CUSTOMER',
          flagCustomer: false
        })
        expect((explicit.body as ItemBody).flagCustomer).toBe(false)
      } finally {
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { preferences: {} }
        })
      }
    })

    it('removes a package that was not received, and 404 for one that is not in the batch', async () => {
      const { batchId, item } = await withItem()
      const removed = await asAdmin().delete(ApiRoutes.returns.reception.itemById(batchId, item.id))
      expect(removed.status).toBe(NO_CONTENT)
      expect((await read(batchId)).items).toHaveLength(0)
      expect(
        (await asAdmin().delete(ApiRoutes.returns.reception.itemById(batchId, item.id))).status
      ).toBe(NOT_FOUND)
    })
  })

  describe('completing the batch', () => {
    it('receives each package in its own transaction: the return, the stock, the shipment and the order', async () => {
      const a = await shipped()
      const b = await shipped({ status: ShipmentStatus.IN_TRANSIT })
      const batchId = await newBatch()
      await scan(batchId, { code: a.guideNumber })
      await scan(batchId, { code: b.guideNumber })

      const response = await complete(batchId)

      expect(response.status).toBe(OK)
      const body = response.body as BatchBody
      expect(body.status).toBe(ReceptionBatchStatus.COMPLETED)
      expect(body.completedAt).not.toBeNull()
      expect(body.counts).toEqual({ total: 2, received: 2, failed: 0, pending: 0 })
      for (const made of [a, b]) {
        expect((await orderOf(made.order.id)).status).toBe('RETURNED')
        expect(await kit.level(made.product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 10 })
        expect(
          (await owner.shipment.findUniqueOrThrow({ where: { id: made.shipmentId } })).status
        ).toBe(ShipmentStatus.RETURNED)
      }
      for (const item of body.items) {
        expect(item).toMatchObject({ outcome: ReceptionItemOutcome.RECEIVED, errorCode: null })
        expect(
          await owner.orderReturn.findUniqueOrThrow({ where: { id: item.returnId ?? '' } })
        ).toMatchObject({ reason: 'DELIVERY_FAILED', status: 'completed' })
      }
      const audit = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: batchId,
        action: AuditAction.RETURN_RECEPTION_BATCH_COMPLETED
      })
      expect(audit[0]?.metadata).toMatchObject({ received: 2, failed: 0, flagged: 0 })
      // Nobody asked for a flag
      expect(
        (await owner.customer.findUniqueOrThrow({ where: { id: a.customerId } })).isCaution
      ).toBe(false)
    })

    it('uses the condition and the lines of the package: a defective one leaves the stock', async () => {
      const made = await shipped()
      const batchId = await newBatch()
      const item = ((await scan(batchId, { code: made.guideNumber })).body as ScanBody)
        .item as ItemBody
      await asAdmin()
        .patch(ApiRoutes.returns.reception.itemById(batchId, item.id))
        .send({
          reason: 'REFUSED_BY_CUSTOMER',
          lines: [
            { orderItemId: made.itemId, quantity: 1, condition: OrderReturnCondition.DAMAGED }
          ]
        })

      await complete(batchId)

      // The 4 units left the shelf with the order; the damaged one came back and left again, so none is put back
      expect(await kit.level(made.product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
      expect((await orderOf(made.order.id)).status).toBe('SHIPPED')
      const row = await owner.orderReturn.findFirstOrThrow({
        where: { orderId: made.order.id },
        include: { lines: true }
      })
      expect(row.reason).toBe('REFUSED_BY_CUSTOMER')
      expect(row.lines[0]).toMatchObject({ quantity: 1, condition: 'damaged' })
    })

    it('does not roll the others back when one fails, keeps it for a retry, and flags only what was asked', async () => {
      const good = await shipped()
      const bad = await shipped()
      const batchId = await newBatch()
      const goodItem = ((await scan(batchId, { code: good.guideNumber })).body as ScanBody)
        .item as ItemBody
      const badItem = ((await scan(batchId, { code: bad.guideNumber })).body as ScanBody)
        .item as ItemBody
      await as(managerAndFlagger)
        .patch(ApiRoutes.returns.reception.itemById(batchId, goodItem.id))
        .send({ flagCustomer: true, flagReason: 'Refused two packages in a row' })
      // More units than were sent: the returns service refuses it, and the batch goes on
      await asAdmin()
        .patch(ApiRoutes.returns.reception.itemById(batchId, badItem.id))
        .send({
          lines: [
            { orderItemId: bad.itemId, quantity: 99, condition: OrderReturnCondition.RESELLABLE }
          ]
        })

      const first = await complete(batchId, managerAndFlagger)

      expect(first.status).toBe(OK)
      const partial = first.body as BatchBody
      expect(partial.status).toBe(ReceptionBatchStatus.COMPLETED_WITH_ERRORS)
      expect(partial.counts).toEqual({ total: 2, received: 1, failed: 1, pending: 0 })
      const failed = partial.items.find(item => item.id === badItem.id)
      expect(failed).toMatchObject({
        outcome: ReceptionItemOutcome.FAILED,
        errorCode: ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED,
        returnId: null
      })
      expect((await orderOf(good.order.id)).status).toBe('RETURNED')
      expect((await orderOf(bad.order.id)).status).toBe('SHIPPED')
      expect(await owner.orderReturn.count({ where: { orderId: bad.order.id } })).toBe(0)
      const flagged = await owner.customer.findUniqueOrThrow({ where: { id: good.customerId } })
      expect(flagged).toMatchObject({
        isCaution: true,
        cautionReason: 'Refused two packages in a row',
        cautionSetBy: managerAndFlagger.id
      })
      expect(
        (await owner.customer.findUniqueOrThrow({ where: { id: bad.customerId } })).isCaution
      ).toBe(false)

      // The failed package can be fixed (a received one cannot be changed) and the batch retried
      const lockedAgain = await asAdmin()
        .patch(ApiRoutes.returns.reception.itemById(batchId, goodItem.id))
        .send({ note: 'late' })
      expect(lockedAgain.status).toBe(CONFLICT)
      await asAdmin()
        .patch(ApiRoutes.returns.reception.itemById(batchId, badItem.id))
        .send({ lines: [] })
      const retry = await complete(batchId)
      const done = retry.body as BatchBody
      expect(done.status).toBe(ReceptionBatchStatus.COMPLETED)
      expect(done.counts).toEqual({ total: 2, received: 2, failed: 0, pending: 0 })
      expect((await orderOf(bad.order.id)).status).toBe('RETURNED')
      // The first package was not received a second time
      expect(await owner.orderReturn.count({ where: { orderId: good.order.id } })).toBe(1)
      expect(await kit.level(good.product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 10 })
    })

    it('does not put the reason of the flag in the audit entries', async () => {
      const made = await shipped()
      const batchId = await newBatch()
      const item = ((await scan(batchId, { code: made.guideNumber })).body as ScanBody)
        .item as ItemBody
      await as(managerAndFlagger)
        .patch(ApiRoutes.returns.reception.itemById(batchId, item.id))
        .send({ flagCustomer: true, flagReason: 'Threatened the courier' })
      await complete(batchId, managerAndFlagger)

      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: batchId,
        action: AuditAction.RETURN_RECEPTION_BATCH_COMPLETED
      })
      expect(JSON.stringify(entries)).not.toContain('Threatened')
      const flagEntries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: made.customerId,
        action: AuditAction.CUSTOMER_CAUTION_SET
      })
      expect(JSON.stringify(flagEntries)).not.toContain('Threatened')
    })

    it('does not let someone who may not flag carry out a flag another member decided', async () => {
      const made = await shipped()
      const batchId = await newBatch()
      const item = ((await scan(batchId, { code: made.guideNumber })).body as ScanBody)
        .item as ItemBody
      await as(managerAndFlagger)
        .patch(ApiRoutes.returns.reception.itemById(batchId, item.id))
        .send({ flagCustomer: true, flagReason: 'Refused' })

      const denied = await complete(batchId, manager)

      expect(denied.status).toBe(FORBIDDEN)
      // Nothing was received and the batch is still a draft
      expect((await read(batchId)).status).toBe(ReceptionBatchStatus.DRAFT)
      expect((await orderOf(made.order.id)).status).toBe('SHIPPED')
    })

    it('refuses an empty batch, a completed one, and one that another run is completing', async () => {
      const empty = await newBatch()
      expect((await complete(empty)).body).toMatchObject({
        error: { code: ErrorCodes.RECEPTION_BATCH_EMPTY }
      })

      const made = await shipped()
      const batchId = await newBatch()
      await scan(batchId, { code: made.guideNumber })
      await complete(batchId)
      const closed = await complete(batchId)
      expect(closed.status).toBe(CONFLICT)
      expect(closed.body).toMatchObject({ error: { code: ErrorCodes.RECEPTION_BATCH_CLOSED } })
      const late = await scan(batchId, { code: made.guideNumber })
      expect(late.body).toMatchObject({ error: { code: ErrorCodes.RECEPTION_BATCH_CLOSED } })
      expect(
        (await asAdmin().delete(ApiRoutes.returns.reception.itemById(batchId, randomUUID()))).status
      ).toBe(CONFLICT)

      const busy = await shipped()
      const running = await newBatch()
      await scan(running, { code: busy.guideNumber })
      await owner.returnReceptionBatch.update({
        where: { id: running },
        data: { status: ReceptionBatchStatus.PROCESSING, processingStartedAt: new Date() }
      })
      const blocked = await complete(running)
      expect(blocked.status).toBe(CONFLICT)
      expect(blocked.body).toMatchObject({
        error: { code: ErrorCodes.RECEPTION_BATCH_PROCESSING }
      })
      expect((await scan(running, { code: busy.guideNumber })).status).toBe(CONFLICT)
      // A run that died long ago does not hold the batch for ever
      await owner.returnReceptionBatch.update({
        where: { id: running },
        data: {
          processingStartedAt: new Date(Date.now() - ReceptionLimits.PROCESSING_STALE_MS - 1000)
        }
      })
      const taken = await complete(running)
      expect(taken.status).toBe(OK)
      expect((taken.body as BatchBody).status).toBe(ReceptionBatchStatus.COMPLETED)
    })

    it('refuses a package that already came back, in another batch', async () => {
      const made = await shipped()
      const first = await newBatch()
      await scan(first, { code: made.guideNumber })
      await complete(first)
      const second = await newBatch()

      const response = await scan(second, { code: made.guideNumber })

      // The order is RETURNED now: the package says it already came back, not that nothing comes back from it
      expect(response.status).toBe(CONFLICT)
      expect(response.body).toMatchObject({
        error: { code: ErrorCodes.RECEPTION_ALREADY_RECEIVED }
      })
      expect((await read(second)).items).toHaveLength(0)
    })

    it('fails the package, not the batch, when the same shipment is in two drafts and one is completed first', async () => {
      const made = await shipped()
      const one = await newBatch()
      const two = await newBatch()
      await scan(one, { code: made.guideNumber })
      await scan(two, { code: made.guideNumber })
      await complete(one)

      const response = await complete(two)

      expect(response.status).toBe(OK)
      const body = response.body as BatchBody
      expect(body.status).toBe(ReceptionBatchStatus.COMPLETED_WITH_ERRORS)
      expect(body.items[0]).toMatchObject({
        outcome: ReceptionItemOutcome.FAILED,
        errorCode: ErrorCodes.RECEPTION_ALREADY_RECEIVED
      })
      expect(await owner.orderReturn.count({ where: { orderId: made.order.id } })).toBe(1)
    })
  })

  it('keeps a database that refuses a received package with no return and a failed one with no code', async () => {
    const made = await shipped()
    const batchId = await newBatch()
    await scan(batchId, { code: made.guideNumber })
    const row = await owner.returnReceptionItem.findFirstOrThrow({ where: { batchId } })
    await expect(
      owner.returnReceptionItem.update({
        where: { id: row.id },
        data: { outcome: ReceptionItemOutcome.RECEIVED }
      })
    ).rejects.toThrow(/chk_return_reception_items_result/)
    await expect(
      owner.returnReceptionItem.update({
        where: { id: row.id },
        data: { outcome: ReceptionItemOutcome.FAILED }
      })
    ).rejects.toThrow(/chk_return_reception_items_result/)
    await expect(
      owner.returnReceptionItem.update({ where: { id: row.id }, data: { flagReason: 'x' } })
    ).rejects.toThrow(/chk_return_reception_items_flag/)
    await expect(
      owner.returnReceptionBatch.update({
        where: { id: batchId },
        data: { status: ReceptionBatchStatus.PROCESSING }
      })
    ).rejects.toThrow(/chk_return_reception_batches_claim/)
  })
})
