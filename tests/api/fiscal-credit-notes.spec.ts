import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalConflictReasons,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalRejectionReasons,
  OrderReturnStatus,
  OrderStatus
} from '@platform/core/domain'
import { Events, type FiscalDocumentRejectedPayload } from '@platform/core/events'
import { JobNames, QueueNames, submitFiscalDocumentJobId } from '@platform/core/queues'
import { FiscalDocumentsService } from '@platform/fiscal/runtime'
import { SIMULATOR_PROVIDER_ID, SimulatorDocumentTypes } from '@platform/fiscal/simulator'

import { createOrder } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'
import { inStoreContext } from '../helpers/tenant-context'

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Credit Note Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
}

describe('The credit notes of the fiscal documents (Step 4B.7b)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    documents = app.get(FiscalDocumentsService)
    emitter = app.get(EventEmitter2)
    expect(
      (await api(app, ctx.adminA, ctx.storeA).put(ApiRoutes.fiscal.issuer).send(ISSUER)).status
    ).toBe(OK)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const jobs = () => queueOf(app, QueueNames.HEAVY_PROCESSING).jobs

  // A delivered order of store A with the tax snapshot of Step 4B.3b: 2 x $11.30 with 13 % in the price, $5.65 of shipping
  async function deliveredOrder() {
    const made = await createOrder(owner, { storeId: ctx.storeA.id })
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
    const order = await owner.order.update({
      where: { id: made.id },
      data: {
        status: OrderStatus.DELIVERED,
        subtotalCents: 2260,
        shippingCents: 565,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        deliveredAt: new Date()
      },
      select: { id: true, storeId: true, orderNumber: true }
    })
    return { ...order, itemId: made.itemId }
  }

  const status = (orderId: string, to: OrderStatus) => ({
    storeId: ctx.storeA.id,
    orderId,
    orderNumber: 'N',
    actor: { type: 'system' as const, id: null },
    from: OrderStatus.DELIVERED,
    to,
    notifyCustomer: false
  })

  // The sale, delivered: its document is made and (when `accepted`) accepted by the simulator
  async function sale(accepted: boolean) {
    const order = await deliveredOrder()
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, status(order.id, OrderStatus.DELIVERED))
    const document = await owner.fiscalDocument.findFirstOrThrow({
      where: { orderId: order.id, kind: FiscalDocumentKind.SALE },
      select: { id: true }
    })
    if (accepted) await documents.submit(ctx.orgA.id, document.id)
    return { ...order, documentId: document.id }
  }

  // A return of `units` units of the order, received, and the event the warehouse raises
  async function receivedReturn(order: { id: string; itemId: string }, units: number) {
    const made = await owner.orderReturn.create({
      data: {
        storeId: ctx.storeA.id,
        orderId: order.id,
        type: 'refund',
        reason: 'DEFECTIVE',
        status: OrderReturnStatus.RECEIVED,
        shippingPayer: 'sender',
        createdBy: ctx.adminA.id,
        receivedAt: new Date()
      },
      select: { id: true }
    })
    await owner.orderReturnLine.create({
      data: {
        storeId: ctx.storeA.id,
        returnId: made.id,
        orderItemId: order.itemId,
        quantity: units
      }
    })
    await emitter.emitAsync(Events.RETURN_RECEIVED, {
      storeId: ctx.storeA.id,
      orderId: order.id,
      orderNumber: 'N',
      actor: { type: 'system', id: null },
      returnId: made.id
    })
    return made.id
  }

  // The service is called here by hand, outside a request: it reads in the store (and organization) of the case, as its route does
  const getDocument = (id: string) =>
    inStoreContext(
      app.get(PrismaService, { strict: false }),
      { storeId: ctx.storeA.id, organizationId: ctx.orgA.id },
      () => documents.get(ctx.orgA.id, id)
    )

  const noteOf = (returnId: string) =>
    owner.fiscalDocument.findFirst({ where: { returnId, kind: FiscalDocumentKind.CREDIT_NOTE } })

  describe('a return makes its credit note', () => {
    it('queues a credit note of the units that came back, linked to the sale document, with the amounts of the books', async () => {
      const order = await sale(true)
      const returnId = await receivedReturn(order, 1)
      const note = await noteOf(returnId)
      expect(note).not.toBeNull()
      expect(note?.status).toBe(FiscalDocumentStatus.QUEUED)
      expect(note?.parentDocumentId).toBe(order.documentId)
      expect(note?.orderId).toBe(order.id)
      // One of the two units: half of the 2000 of revenue and the 260 of tax, with the tax in the price
      expect([note?.totalCents, note?.taxCents]).toEqual([1130, 130])
      // The job carries the ids only
      const job = jobs().find(
        entry => entry.opts?.jobId === submitFiscalDocumentJobId(note?.id ?? '', 1)
      )
      expect(job?.name).toBe(JobNames.SUBMIT_FISCAL_DOCUMENT)
      expect(job?.data).toEqual({ organizationId: ctx.orgA.id, documentId: note?.id })
    })

    it('is accepted as a credit note naming the document it cancels, and a repeated event makes no second one', async () => {
      const order = await sale(true)
      const returnId = await receivedReturn(order, 1)
      const note = await noteOf(returnId)
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      const accepted = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })
      expect(accepted.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(accepted.documentType).toBe(SimulatorDocumentTypes.CREDIT_NOTE)
      expect(accepted.externalNumber).toMatch(/^SIM-/)
      await emitter.emitAsync(Events.RETURN_RECEIVED, {
        storeId: ctx.storeA.id,
        orderId: order.id,
        orderNumber: 'N',
        actor: { type: 'system', id: null },
        returnId
      })
      expect(await owner.fiscalDocument.count({ where: { returnId } })).toBe(1)
      // The sale document is untouched
      const original = await owner.fiscalDocument.findUniqueOrThrow({
        where: { id: order.documentId }
      })
      expect(original.status).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('makes one note per return and the parts add up to the goods of the sale to the cent', async () => {
      const order = await sale(true)
      const first = await noteOf(await receivedReturn(order, 1))
      const second = await noteOf(await receivedReturn(order, 1))
      expect((first?.totalCents ?? 0) + (second?.totalCents ?? 0)).toBe(2260)
      expect((first?.taxCents ?? 0) + (second?.taxCents ?? 0)).toBe(260)
    })

    it('makes nothing when the sale has no document (it was never issued) or the organization has no issuer', async () => {
      const order = await deliveredOrder()
      const returnId = await receivedReturn(order, 1)
      expect(await noteOf(returnId)).toBeNull()
      const otherStore = await createOrder(owner, { storeId: ctx.storeB.id })
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
        storeId: ctx.storeB.id,
        orderId: otherStore.id,
        orderNumber: 'X',
        actor: { type: 'system', id: null },
        from: OrderStatus.DELIVERED,
        to: OrderStatus.RETURNED,
        notifyCustomer: false
      })
      expect(await owner.fiscalDocument.count({ where: { orderId: otherStore.id } })).toBe(0)
    })

    it('makes a note of every unit for an order that came back as a whole, and none for one with received returns', async () => {
      const whole = await sale(true)
      // An order that is not returned has no note (the event may be late): the same event makes nothing
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, status(whole.id, OrderStatus.RETURNED))
      expect(
        await owner.fiscalDocument.count({
          where: { orderId: whole.id, kind: FiscalDocumentKind.CREDIT_NOTE }
        })
      ).toBe(0)
      await owner.order.update({ where: { id: whole.id }, data: { status: OrderStatus.RETURNED } })
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, status(whole.id, OrderStatus.RETURNED))
      const note = await owner.fiscalDocument.findFirst({
        where: { orderId: whole.id, kind: FiscalDocumentKind.CREDIT_NOTE }
      })
      expect(note?.returnId).toBeNull()
      expect([note?.totalCents, note?.taxCents]).toEqual([2260, 260])
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, status(whole.id, OrderStatus.RETURNED))
      expect(
        await owner.fiscalDocument.count({
          where: { orderId: whole.id, kind: FiscalDocumentKind.CREDIT_NOTE }
        })
      ).toBe(1)

      const partial = await sale(true)
      await owner.order.update({
        where: { id: partial.id },
        data: { status: OrderStatus.RETURNED }
      })
      await receivedReturn(partial, 1)
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, status(partial.id, OrderStatus.RETURNED))
      expect(
        await owner.fiscalDocument.count({
          where: { orderId: partial.id, kind: FiscalDocumentKind.CREDIT_NOTE, returnId: null }
        })
      ).toBe(0)
    })

    it('is made REJECTED, with the reason and the event, when the units do not fit the sale', async () => {
      const seen: FiscalDocumentRejectedPayload[] = []
      const listener = (payload: FiscalDocumentRejectedPayload): void => {
        seen.push(payload)
      }
      emitter.on(Events.FISCAL_DOCUMENT_REJECTED, listener)
      try {
        const order = await sale(true)
        const returnId = await receivedReturn(order, 3)
        const note = await noteOf(returnId)
        expect(note?.status).toBe(FiscalDocumentStatus.REJECTED)
        expect(note?.rejectionReason).toBe(FiscalRejectionReasons.RETURN_INCONSISTENT)
        expect(seen.map(payload => payload.reason)).toContain(
          FiscalRejectionReasons.RETURN_INCONSISTENT
        )
        // Retried while it still does not fit: refused, and it stays as it is
        const retry = await asAdminA().post(ApiRoutes.fiscal.documents.retry(note?.id ?? ''))
        expect(retry.status).toBe(CONFLICT)
        expect(await getDocument(note?.id ?? '')).toMatchObject({
          status: FiscalDocumentStatus.REJECTED
        })
      } finally {
        emitter.off(Events.FISCAL_DOCUMENT_REJECTED, listener)
      }
    })
  })

  describe('the credit note and its original', () => {
    it('waits for the sale document to be accepted: nothing is claimed, and it goes after', async () => {
      const order = await sale(false)
      const note = await noteOf(await receivedReturn(order, 1))
      await expect(documents.submit(ctx.orgA.id, note?.id ?? '')).rejects.toThrow(
        /not accepted yet/
      )
      const waiting = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })
      expect([waiting.status, waiting.attempts]).toEqual([FiscalDocumentStatus.QUEUED, 0])
      await documents.submit(ctx.orgA.id, order.documentId)
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      expect(await statusOf(note?.id ?? '')).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('does not release a note while the sale document is refused or has no seal: nothing is claimed (Normativa DTE 9.2)', async () => {
      const order = await sale(false)
      const note = await noteOf(await receivedReturn(order, 1))
      // The authority refused the sale document: the note that names it does not go out until it is accepted
      await owner.fiscalDocument.update({
        where: { id: order.documentId },
        data: { status: FiscalDocumentStatus.REJECTED, rejectedAt: new Date() }
      })
      await expect(documents.submit(ctx.orgA.id, note?.id ?? '')).rejects.toThrow(
        /not accepted yet/
      )
      const waiting = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })
      expect([waiting.status, waiting.attempts]).toEqual([FiscalDocumentStatus.QUEUED, 0])
      // The sale document is back in the queue and sent: the note goes after it
      await owner.fiscalDocument.update({
        where: { id: order.documentId },
        data: { status: FiscalDocumentStatus.QUEUED, rejectedAt: null }
      })
      await documents.submit(ctx.orgA.id, order.documentId)
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      expect(await statusOf(note?.id ?? '')).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('takes the receiver of the document it cancels and refuses to edit its own', async () => {
      const order = await sale(false)
      const note = await noteOf(await receivedReturn(order, 1))
      const fix = await asAdminA()
        .patch(ApiRoutes.fiscal.documents.receiver(order.documentId))
        .send({ taxId: '0614-010101-101-1', name: 'Ana Receiver' })
      expect(fix.status).toBe(OK)
      const edit = await asAdminA()
        .patch(ApiRoutes.fiscal.documents.receiver(note?.id ?? ''))
        .send({ taxId: 'OTHER' })
      expect(edit.status).toBe(CONFLICT)
      await documents.submit(ctx.orgA.id, order.documentId)
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      const view = await getDocument(note?.id ?? '')
      expect(view.receiver.taxIdMasked).toBe('********1011')
      // The masks came with the receiver of the document it cancels (the same bytes), not to be calculated again by the night
      const stored = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id ?? '' } })
      expect(stored).toMatchObject({
        receiverNameMasked: 'A***********',
        receiverTaxIdMasked: '********1011'
      })
      expect(stored.receiverMaskedAt).not.toBeNull()
      expect(view.documentType).toBe(SimulatorDocumentTypes.CREDIT_NOTE)
    })

    it('does not let a sale document with a live credit note be voided, and lets it go once the notes are voided', async () => {
      const order = await sale(true)
      const note = await noteOf(await receivedReturn(order, 1))
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      const refused = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(order.documentId))
        .send({ reason: 'wrong customer' })
      expect(refused.status).toBe(CONFLICT)
      expect(await statusOf(order.documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(
        (
          await asAdminA()
            .post(ApiRoutes.fiscal.documents.void(note?.id ?? ''))
            .send({ reason: 'made by mistake' })
        ).status
      ).toBe(OK)
      expect(
        (
          await asAdminA()
            .post(ApiRoutes.fiscal.documents.void(order.documentId))
            .send({ reason: 'wrong customer' })
        ).status
      ).toBe(OK)
    })

    it('refuses a credit note whose original was voided, and a person retries it once the sale is replaced', async () => {
      const order = await sale(true)
      const note = await noteOf(await receivedReturn(order, 1))
      // The sale document is voided while the note is still on its way (the route refuses it; this is the race it cannot see)
      await owner.fiscalDocument.update({
        where: { id: order.documentId },
        data: { status: FiscalDocumentStatus.VOIDED, voidedAt: new Date(), voidReason: 'race' }
      })
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      const refused = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })
      expect(refused.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(refused.rejectionReason).toBe(FiscalRejectionReasons.ORIGINAL_VOIDED)
      // Nothing was sent: the attempt is given back
      expect(refused.attempts).toBe(0)
      // No sale document is live: nothing to retry against yet
      expect((await asAdminA().post(ApiRoutes.fiscal.documents.retry(note?.id ?? ''))).status).toBe(
        CONFLICT
      )
      const replaced = await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))
      expect(replaced.status).toBe(OK)
      const newId = (replaced.body as { data: { id: string } }).data.id
      expect((await asAdminA().post(ApiRoutes.fiscal.documents.retry(note?.id ?? ''))).status).toBe(
        OK
      )
      const retried = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })
      expect([retried.status, retried.parentDocumentId]).toEqual([
        FiscalDocumentStatus.QUEUED,
        newId
      ])
    })

    it('does not make a credit note against a sale document that was voided', async () => {
      const order = await sale(true)
      expect(
        (
          await asAdminA()
            .post(ApiRoutes.fiscal.documents.void(order.documentId))
            .send({ reason: 'wrong customer' })
        ).status
      ).toBe(OK)
      expect(await noteOf(await receivedReturn(order, 1))).toBeNull()
    })

    it('does not let a note that is only waiting, or was refused, keep the sale from being voided', async () => {
      const order = await sale(true)
      const waiting = await noteOf(await receivedReturn(order, 1))
      expect(waiting?.status).toBe(FiscalDocumentStatus.QUEUED)
      const refused = await noteOf(await receivedReturn(order, 1))
      await owner.fiscalDocument.update({
        where: { id: refused?.id },
        data: { status: FiscalDocumentStatus.REJECTED, rejectionReason: 'x' }
      })
      expect(
        (
          await asAdminA()
            .post(ApiRoutes.fiscal.documents.void(order.documentId))
            .send({ reason: 'wrong customer' })
        ).status
      ).toBe(OK)
    })
  })

  describe('the replacement of a voided document', () => {
    it('makes the note of a return that was received while the sale had no live document', async () => {
      const order = await sale(true)
      await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(order.documentId))
        .send({ reason: 'redo' })
      const returnId = await receivedReturn(order, 1)
      expect(await noteOf(returnId)).toBeNull()
      const replaced = await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))
      expect(replaced.status).toBe(OK)
      const newId = (replaced.body as { data: { id: string } }).data.id
      const note = await noteOf(returnId)
      expect(note?.parentDocumentId).toBe(newId)
      expect(note?.status).toBe(FiscalDocumentStatus.QUEUED)
    })

    it('moves the notes that never left core to the replacement, and refuses to replace a document twice even when its replacement was voided', async () => {
      const order = await sale(true)
      const waiting = await noteOf(await receivedReturn(order, 1))
      await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(order.documentId))
        .send({ reason: 'redo' })
      const replaced = await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))
      const newId = (replaced.body as { data: { id: string } }).data.id
      const moved = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: waiting?.id } })
      expect(moved.parentDocumentId).toBe(newId)
      // Moved, not made again: one note for the return, and it is sent with the replacement
      expect(await owner.fiscalDocument.count({ where: { returnId: waiting?.returnId } })).toBe(1)
      const queued = jobs().some(
        job => job.opts?.jobId === submitFiscalDocumentJobId(waiting?.id ?? '', 1)
      )
      expect(queued).toBe(true)
      await documents.submit(ctx.orgA.id, newId)
      // The note never left core, so it does not keep the replacement from being voided
      const voidedAgain = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(newId))
        .send({ reason: 'again' })
      expect(voidedAgain.status).toBe(OK)
      // The original has its replacement, voided or not: it is replaced once
      const second = await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))
      expect(second.status).toBe(CONFLICT)
      expect(
        (second.body as { error: { metadata?: { reason?: string } } }).error.metadata?.reason
      ).toBe(FiscalConflictReasons.ALREADY_REPLACED)
    })

    it('does not let a note that was sent and not answered keep going out of the way: it blocks the void', async () => {
      const order = await sale(true)
      const sent = await noteOf(await receivedReturn(order, 1))
      // Back in the queue with an attempt counted: the authority may have it
      await owner.fiscalDocument.update({ where: { id: sent?.id }, data: { attempts: 1 } })
      const blocked = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(order.documentId))
        .send({ reason: 'wrong customer' })
      expect(blocked.status).toBe(CONFLICT)
      expect(
        (blocked.body as { error: { metadata?: { reason?: string } } }).error.metadata?.reason
      ).toBe(FiscalConflictReasons.HAS_CREDIT_NOTES)
      // A retry asks the authority and settles it (the simulator knows nothing of it: it is sent again and accepted)
      expect((await asAdminA().post(ApiRoutes.fiscal.documents.retry(sent?.id ?? ''))).status).toBe(
        OK
      )
      await documents.submit(ctx.orgA.id, sent?.id ?? '')
      expect(await statusOf(sent?.id ?? '')).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('makes the sale document again with a new number, keeps the receiver, and makes the voided credit notes again against it', async () => {
      const order = await sale(true)
      await asAdminA()
        .patch(ApiRoutes.fiscal.documents.receiver(order.documentId))
        .send({ taxId: 'KEPT-TAX-ID', name: 'Kept Name' })
      const note = await noteOf(await receivedReturn(order, 1))
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(note?.id ?? ''))
        .send({ reason: 'redo' })
      await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(order.documentId))
        .send({ reason: 'redo' })

      const replaced = await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))
      expect(replaced.status).toBe(OK)
      const view = (
        replaced.body as {
          data: { id: string; replacesDocumentId: string; status: string; kind: string }
        }
      ).data
      expect(view).toMatchObject({
        replacesDocumentId: order.documentId,
        status: FiscalDocumentStatus.QUEUED,
        kind: FiscalDocumentKind.SALE
      })
      // The voided document names its replacement and stops offering to make it again
      const voidedView = (await asAdminA().get(ApiRoutes.fiscal.documents.byId(order.documentId)))
        .body as {
        data: { replacedByDocumentId: string | null; allowedActions: { replace: boolean } }
      }
      expect(voidedView.data.replacedByDocumentId).toBe(view.id)
      expect(voidedView.data.allowedActions.replace).toBe(false)
      const fresh = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: view.id } })
      const old = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: order.documentId } })
      expect(fresh.sequenceNumber).toBeGreaterThan(old.sequenceNumber)
      expect(Buffer.from(fresh.receiverEncrypted).equals(Buffer.from(old.receiverEncrypted))).toBe(
        true
      )
      // The note is made again, naming the new document, and waits for it
      const again = await owner.fiscalDocument.findFirstOrThrow({
        where: { parentDocumentId: view.id, kind: FiscalDocumentKind.CREDIT_NOTE }
      })
      expect(again.returnId).toBe(note?.returnId)
      expect(again.status).toBe(FiscalDocumentStatus.QUEUED)
      await expect(documents.submit(ctx.orgA.id, again.id)).rejects.toThrow(/not accepted yet/)
      await documents.submit(ctx.orgA.id, view.id)
      await documents.submit(ctx.orgA.id, again.id)
      expect(await statusOf(again.id)).toBe(FiscalDocumentStatus.ACCEPTED)
      await waitForAuditEntries(owner, {
        action: AuditAction.FISCAL_DOCUMENT_REPLACED,
        userId: ctx.adminA.id
      })
    })

    it('replaces a document once, and only a voided sale document', async () => {
      const order = await sale(true)
      const live = await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))
      expect(live.status).toBe(CONFLICT)
      await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(order.documentId))
        .send({ reason: 'redo' })
      expect(
        (await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))).status
      ).toBe(OK)
      const twice = await asAdminA().post(ApiRoutes.fiscal.documents.replace(order.documentId))
      expect(twice.status).toBe(CONFLICT)
    })

    it('is for FISCAL_MANAGE, and a document of another organization answers 404', async () => {
      const order = await sale(true)
      await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(order.documentId))
        .send({ reason: 'redo' })
      const reader = await actorWithPermissions(owner, app, {
        prefix,
        name: 'credit-note-reader',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.FISCAL_VIEW]
      })
      expect(
        (
          await api(app, reader, ctx.storeA).post(
            ApiRoutes.fiscal.documents.replace(order.documentId)
          )
        ).status
      ).toBe(FORBIDDEN)
      expect(
        (
          await api(app, ctx.adminB, ctx.storeB).post(
            ApiRoutes.fiscal.documents.replace(order.documentId)
          )
        ).status
      ).toBe(NOT_FOUND)
    })
  })

  describe('what the database keeps', () => {
    it('refuses a second live credit note for a return, a credit note with no original and a sale document that replaces one the authority does not have', async () => {
      const order = await sale(true)
      const note = await noteOf(await receivedReturn(order, 1))
      const copy = (overrides: Record<string, unknown>) => {
        // The row of the note without the columns the database fills in
        const rest: Record<string, unknown> = { ...note }
        for (const column of ['id', 'createdAt', 'updatedAt']) delete rest[column]
        return owner.fiscalDocument.create({
          data: { ...rest, sequenceNumber: 2_000_000, ...overrides } as never
        })
      }
      await expect(copy({})).rejects.toThrow()
      await expect(copy({ sequenceNumber: 2_000_001, parentDocumentId: null })).rejects.toThrow()
      // A sale document replaces a document the authority has (accepted, or voided); one that is only queued is not replaced
      const waiting = await sale(false)
      await expect(
        copy({
          sequenceNumber: 2_000_002,
          kind: FiscalDocumentKind.SALE,
          orderId: waiting.id,
          returnId: null,
          parentDocumentId: null,
          replacesDocumentId: waiting.documentId
        })
      ).rejects.toThrow()
      // The replacement of an accepted sale document is the one made first (Step 4B.7c-5b): once, and not a third live document
      const made = await copy({
        sequenceNumber: 2_000_003,
        kind: FiscalDocumentKind.SALE,
        returnId: null,
        parentDocumentId: null,
        replacesDocumentId: order.documentId
      })
      await expect(
        copy({
          sequenceNumber: 2_000_004,
          kind: FiscalDocumentKind.SALE,
          returnId: null,
          parentDocumentId: null,
          replacesDocumentId: order.documentId
        })
      ).rejects.toThrow()
      await expect(
        copy({
          sequenceNumber: 2_000_005,
          kind: FiscalDocumentKind.SALE,
          returnId: null,
          parentDocumentId: null,
          replacesDocumentId: made.id
        })
      ).rejects.toThrow()
    })

    it('never changes an accepted credit note', async () => {
      const order = await sale(true)
      const note = await noteOf(await receivedReturn(order, 1))
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      await expect(
        owner.fiscalDocument.update({ where: { id: note?.id }, data: { returnId: null } })
      ).rejects.toThrow()
      await expect(
        owner.fiscalDocument.update({ where: { id: note?.id }, data: { totalCents: 1 } })
      ).rejects.toThrow()
    })
  })

  async function statusOf(documentId: string): Promise<string> {
    return (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })).status
  }
})
