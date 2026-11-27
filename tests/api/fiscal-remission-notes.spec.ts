import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { isUniqueViolationOf, PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIndexNames,
  FiscalIssueOn,
  OrderStatus,
  ShipmentStatus
} from '@platform/core/domain'
import { Events, type FiscalRemissionVoidDeadlinePayload } from '@platform/core/events'
import { JobNames, QueueNames, submitFiscalDocumentJobId } from '@platform/core/queues'
import { FiscalDocumentsService, FiscalProviderRegistry } from '@platform/fiscal/runtime'
import { SIMULATOR_PROVIDER_ID, SimulatorDocumentTypes } from '@platform/fiscal/simulator'

import { FiscalListener } from '../../apps/api/src/modules/fiscal/fiscal.listener'
import { createOrder, createShipment } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'
import { inStoreContext } from '../helpers/tenant-context'

const OK = 200
const NOT_FOUND = 404
const CONFLICT = 409

const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Remission Note Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
}

// Every case makes its own order and guide, and every document it reads is looked up by the guide it made, so the cases share no row and
// can run in any order. The issuer is the one setting the cases that change it put back (`issueOn`).
describe('The remission note of a dispatch (D3b-2)', () => {
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

  const jobs = () => queueOf(app, QueueNames.HEAVY_PROCESSING).jobs

  // A note written as the owner, with the columns the database asks for and a number of the series of its own (one counter for the file, so
  // no two inserts share one and a refusal is never about the number)
  let sequence = 1_900_000_000 + Math.floor(Math.random() * 50_000_000)
  const rawNote = (over: { orderId: string; kind: string; shipmentId?: string }) => ({
    organizationId: ctx.orgA.id,
    storeId: ctx.storeA.id,
    sequenceNumber: (sequence += 1),
    documentType: 'pending',
    status: 'queued',
    providerId: SIMULATOR_PROVIDER_ID,
    environment: 'sandbox',
    issuerSnapshot: {},
    linesSnapshot: { lines: [] },
    receiverEncrypted: Buffer.from('x'),
    totalCents: 1,
    taxCents: 0,
    ...over
  })

  // An order of store A on its way, with the tax snapshot of Step 4B.3b: 2 x $11.30 with 13 % in the price, $5.65 of shipping
  async function dispatchedOrder() {
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
    return owner.order.update({
      where: { id: made.id },
      data: {
        status: OrderStatus.SHIPPED,
        subtotalCents: 2260,
        shippingCents: 565,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        shippedAt: new Date()
      },
      select: { id: true, storeId: true, orderNumber: true }
    })
  }

  // A guide of the order, and the event the platform raises when it is made
  async function guide(orderId: string, over: { status?: ShipmentStatus } = {}) {
    const shipment = await createShipment(owner, {
      storeId: ctx.storeA.id,
      orderId,
      ...(over.status === undefined ? {} : { status: over.status })
    })
    return shipment
  }
  const created = (shipment: { id: string; orderId: string; connectionId: string }) =>
    emitter.emitAsync(Events.SHIPMENT_CREATED, {
      storeId: ctx.storeA.id,
      shipmentId: shipment.id,
      orderId: shipment.orderId,
      orderNumber: 'N',
      connectionId: shipment.connectionId,
      actor: { type: 'system' as const, id: null }
    })
  const noteOf = (shipmentId: string) =>
    owner.fiscalDocument.findMany({
      where: { shipmentId, kind: FiscalDocumentKind.REMISSION_NOTE }
    })
  const setIssueOn = (issueOn: FiscalIssueOn) =>
    owner.fiscalIssuer.update({ where: { organizationId: ctx.orgA.id }, data: { issueOn } })

  it('is made when a guide is made, with the order of the guide, no entry of the books, and a job that carries the ids only', async () => {
    const order = await dispatchedOrder()
    const shipment = await guide(order.id)
    await created(shipment)
    const [note, ...others] = await noteOf(shipment.id)
    expect(others).toEqual([])
    expect(note?.status).toBe(FiscalDocumentStatus.QUEUED)
    expect(note?.orderId).toBe(order.id)
    expect(note?.storeId).toBe(ctx.storeA.id)
    // It is no sale: no entry of the books, no return, no parent, nothing replaced
    expect([
      note?.journalEntryId,
      note?.returnId,
      note?.parentDocumentId,
      note?.replacesDocumentId
    ]).toEqual([null, null, null, null])
    expect([note?.totalCents, note?.taxCents]).toEqual([2825, 325])
    const job = jobs().find(
      entry => entry.opts?.jobId === submitFiscalDocumentJobId(note?.id ?? '', 1)
    )
    expect(job?.name).toBe(JobNames.SUBMIT_FISCAL_DOCUMENT)
    expect(job?.data).toEqual({ organizationId: ctx.orgA.id, documentId: note?.id })
  })

  it('is made once for a guide, however many times the event comes, and once for the new guide of an order whose first guide was cancelled', async () => {
    const order = await dispatchedOrder()
    const first = await guide(order.id)
    // The same event twice is the same note
    await created(first)
    await created(first)
    expect(await noteOf(first.id)).toHaveLength(1)
    // The index of the live note of a guide is what holds it, whoever races
    await expect(
      owner.fiscalDocument.create({
        data: rawNote({
          orderId: order.id,
          kind: FiscalDocumentKind.REMISSION_NOTE,
          shipmentId: first.id
        })
      })
    ).rejects.toThrow(/Unique constraint failed|uq_fiscal_documents_live_remission_of_shipment/)
    // A new guide of the same order (the first one was cancelled: only one guide of an order and warehouse is active) has a note of its own,
    // and the note of the cancelled one stays: voiding it is the person's
    await owner.shipment.update({
      where: { id: first.id },
      data: { status: ShipmentStatus.CANCELLED }
    })
    const second = await guide(order.id)
    await created(second)
    expect(await noteOf(second.id)).toHaveLength(1)
    expect(await owner.fiscalDocument.count({ where: { orderId: order.id } })).toBe(2)
  })

  it('is not made when the issuer makes the sale document at the dispatch (it backs the goods itself)', async () => {
    await setIssueOn(FiscalIssueOn.SHIPPED)
    try {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      expect(await noteOf(shipment.id)).toEqual([])
    } finally {
      await setIssueOn(FiscalIssueOn.DELIVERED)
    }
    // The same event with the issuer on delivery makes the note: the absence above was the setting, nothing else
    const control = await dispatchedOrder()
    const guideOfControl = await guide(control.id)
    await created(guideOfControl)
    expect(await noteOf(guideOfControl.id)).toHaveLength(1)
  })

  it('is not made for a guide that backs nothing (one that failed or was cancelled), nor for an order with no tax snapshot', async () => {
    const order = await dispatchedOrder()
    for (const status of [ShipmentStatus.FAILED, ShipmentStatus.CANCELLED]) {
      const shipment = await guide(order.id, { status })
      await created(shipment)
      expect(await noteOf(shipment.id)).toEqual([])
    }
    // The same order, with a guide that backs goods: the note is made, so the absence above was the state of the guides
    const live = await guide(order.id)
    await created(live)
    expect(await noteOf(live.id)).toHaveLength(1)
    // An order that predates the tax snapshot has no note, and its guide would have one with the snapshot
    const untaxedOrder = await dispatchedOrder()
    // The two columns of the snapshot are null together (the database checks the pair)
    await owner.order.update({
      where: { id: untaxedOrder.id },
      data: { taxCents: null, pricesIncludeTax: null }
    })
    const untaxed = await guide(untaxedOrder.id)
    await created(untaxed)
    expect(await noteOf(untaxed.id)).toEqual([])
    expect(await owner.fiscalDocument.count({ where: { orderId: untaxedOrder.id } })).toBe(0)
  })

  it('is accepted as a remission note, with no sale document made by it, and leaves the sale document to the delivery', async () => {
    const order = await dispatchedOrder()
    const shipment = await guide(order.id)
    await created(shipment)
    const [note] = await noteOf(shipment.id)
    await documents.submit(ctx.orgA.id, note?.id ?? '')
    const accepted = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })
    expect(accepted.status).toBe(FiscalDocumentStatus.ACCEPTED)
    expect(accepted.documentType).toBe(SimulatorDocumentTypes.REMISSION_NOTE)
    expect(accepted.journalEntryId).toBeNull()
    // Nothing of the sale: the order is only dispatched, and no sale document exists
    expect(
      await owner.fiscalDocument.count({
        where: { orderId: order.id, kind: FiscalDocumentKind.SALE }
      })
    ).toBe(0)
  })

  it('is read with the guide it backs, and offers to complete its receiver while it was never sent but never to replace it', async () => {
    const order = await dispatchedOrder()
    const shipment = await guide(order.id)
    await created(shipment)
    const [note] = await noteOf(shipment.id)
    const view = await inStoreContext(
      app.get(PrismaService, { strict: false }),
      { storeId: ctx.storeA.id, organizationId: ctx.orgA.id },
      () => documents.get(ctx.orgA.id, note?.id ?? '')
    )
    expect(view).toMatchObject({
      kind: FiscalDocumentKind.REMISSION_NOTE,
      shipmentId: shipment.id,
      allowedActions: { editReceiver: true, replace: false }
    })
  })

  it('takes the loss of a race on the index of the live note as a duplicate: a warning, never an error (D3b-3)', async () => {
    // The error the database really gives when a second live note of the guide is written, as the listener receives it
    const order = await dispatchedOrder()
    const other = await guide(order.id)
    await created(other)
    const real: unknown = await owner.fiscalDocument
      .create({
        data: rawNote({
          orderId: order.id,
          kind: FiscalDocumentKind.REMISSION_NOTE,
          shipmentId: other.id
        })
      })
      .catch((error: unknown) => error)
    expect(isUniqueViolationOf(real, FiscalIndexNames.LIVE_REMISSION_OF_SHIPMENT)).toBe(true)

    const shipment = await guide((await dispatchedOrder()).id)
    const listener = app.get(FiscalListener)
    const warn = jest.spyOn(listener['logger'], 'warn')
    const error = jest.spyOn(listener['logger'], 'error')
    const make = jest.spyOn(documents, 'createRemissionForShipment')
    try {
      make.mockRejectedValueOnce(real)
      await created(shipment)
      expect(warn).toHaveBeenCalledWith(
        { shipmentId: shipment.id },
        'the remission note of a guide was made by another replica'
      )
      expect(error).not.toHaveBeenCalled()
      // Another unique rule of the table is a fault, said as one
      make.mockRejectedValueOnce(
        Object.assign(
          new Error(
            'Unique constraint failed on `fiscal_documents_organization_id_sequence_number_key`'
          ),
          {
            code: 'P2002'
          }
        )
      )
      await created(shipment)
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      make.mockRestore()
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it('is not made for an order that has its sale document already (it backs the goods itself)', async () => {
    const order = await dispatchedOrder()
    await owner.fiscalDocument.create({
      data: rawNote({ orderId: order.id, kind: FiscalDocumentKind.SALE })
    })
    const shipment = await guide(order.id)
    await created(shipment)
    expect(await noteOf(shipment.id)).toEqual([])
  })

  describe('made again after it was voided (D3b-3)', () => {
    const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
    const voidNote = (id: string) =>
      owner.fiscalDocument.update({
        where: { id },
        data: {
          status: FiscalDocumentStatus.VOIDED,
          voidedAt: new Date(),
          voidReason: 'wrong data'
        }
      })

    it('makes a new note for the same guide, with the receiver of the voided one, and refuses a second one while the first is alive', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [first] = await noteOf(shipment.id)
      await voidNote(first?.id ?? '')
      const view = await inStoreContext(
        app.get(PrismaService, { strict: false }),
        { storeId: ctx.storeA.id, organizationId: ctx.orgA.id },
        () => documents.get(ctx.orgA.id, first?.id ?? '')
      )
      expect(view.allowedActions.replace).toBe(true)
      const made = await asAdmin().post(ApiRoutes.fiscal.documents.replace(first?.id ?? ''))
      expect(made.status).toBe(OK)
      const again = await owner.fiscalDocument.findUniqueOrThrow({
        where: { id: (made.body as { data: { id: string } }).data.id }
      })
      expect(again).toMatchObject({
        kind: FiscalDocumentKind.REMISSION_NOTE,
        shipmentId: shipment.id,
        orderId: order.id,
        status: FiscalDocumentStatus.QUEUED,
        replacesDocumentId: null,
        journalEntryId: null
      })
      expect(again.sequenceNumber).toBeGreaterThan(first?.sequenceNumber ?? 0)
      expect(
        Buffer.from(again.receiverEncrypted).equals(Buffer.from(first?.receiverEncrypted ?? []))
      ).toBe(true)
      // Queued for the authority like any other document
      expect(
        jobs().some(entry => entry.opts?.jobId === submitFiscalDocumentJobId(again.id, 1))
      ).toBe(true)
      // The guide has a live note now: the voided one cannot be made again a second time
      const second = await asAdmin().post(ApiRoutes.fiscal.documents.replace(first?.id ?? ''))
      expect(second.status).toBe(CONFLICT)
      expect(JSON.stringify(second.body)).toContain('remission_already_replaced')
      expect(await noteOf(shipment.id)).toHaveLength(2)
    })

    it('refuses it when the goods no longer travel (the guide was cancelled), when the issuer no longer makes the note, and for a note that is not voided', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [note] = await noteOf(shipment.id)
      // Not voided
      const alive = await asAdmin().post(ApiRoutes.fiscal.documents.replace(note?.id ?? ''))
      expect(alive.status).toBe(CONFLICT)
      await voidNote(note?.id ?? '')
      await owner.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      const cancelled = await asAdmin().post(ApiRoutes.fiscal.documents.replace(note?.id ?? ''))
      expect(cancelled.status).toBe(CONFLICT)
      expect(JSON.stringify(cancelled.body)).toContain('note_guide_not_active')
      // The guide is on its way again in this test, and the issuer makes the sale document at the dispatch: nothing for a note to back
      await owner.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.IN_TRANSIT }
      })
      await setIssueOn(FiscalIssueOn.SHIPPED)
      try {
        const shipped = await asAdmin().post(ApiRoutes.fiscal.documents.replace(note?.id ?? ''))
        expect(shipped.status).toBe(CONFLICT)
        expect(JSON.stringify(shipped.body)).toContain('note_guide_not_active')
      } finally {
        await setIssueOn(FiscalIssueOn.DELIVERED)
      }
      // The control: the same request with the goods on their way and the issuer on delivery makes the note
      const control = await asAdmin().post(ApiRoutes.fiscal.documents.replace(note?.id ?? ''))
      expect(control.status).toBe(OK)
    })

    it('refuses it once the order has its sale document', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [note] = await noteOf(shipment.id)
      await voidNote(note?.id ?? '')
      await owner.fiscalDocument.create({
        data: rawNote({ orderId: order.id, kind: FiscalDocumentKind.SALE })
      })
      const made = await asAdmin().post(ApiRoutes.fiscal.documents.replace(note?.id ?? ''))
      expect(made.status).toBe(CONFLICT)
      expect(JSON.stringify(made.body)).toContain('note_guide_not_active')
      expect(await noteOf(shipment.id)).toHaveLength(1)
    })

    it('never reaches a note of another organization', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [note] = await noteOf(shipment.id)
      await voidNote(note?.id ?? '')
      const other = await api(app, ctx.adminB, ctx.storeB).post(
        ApiRoutes.fiscal.documents.replace(note?.id ?? '')
      )
      expect(other.status).toBe(NOT_FOUND)
      expect(await noteOf(shipment.id)).toHaveLength(1)
    })
  })

  describe('a guide that is cancelled while its note is accepted (D3b-3)', () => {
    const told = async (shipmentId: string, noteId: string) => {
      const seen: FiscalRemissionVoidDeadlinePayload[] = []
      const listener = (payload: FiscalRemissionVoidDeadlinePayload): void => {
        seen.push(payload)
      }
      emitter.on(Events.FISCAL_REMISSION_VOID_DEADLINE, listener)
      try {
        const count = await documents.announceNotesOfCancelledGuide(ctx.orgA.id, shipmentId)
        await new Promise(resolve => setImmediate(resolve))
        return { count, seen: seen.filter(payload => payload.documentId === noteId) }
      } finally {
        emitter.off(Events.FISCAL_REMISSION_VOID_DEADLINE, listener)
      }
    }

    it('tells the last day to void an accepted note, once for each call, and tells nothing for a note that is not accepted or a guide that was not cancelled', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [note] = await noteOf(shipment.id)
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      // The guide is on its way: nothing to tell
      expect((await told(shipment.id, note?.id ?? '')).count).toBe(0)
      await owner.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      const first = await told(shipment.id, note?.id ?? '')
      expect(first.count).toBe(1)
      expect(first.seen).toHaveLength(1)
      expect(first.seen[0]).toMatchObject({
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        orderId: order.id,
        shipmentId: shipment.id
      })
      // The window is ahead of now: the last instant to void is in the future
      expect(new Date(first.seen[0]?.deadline ?? 0).getTime()).toBeGreaterThan(Date.now())
      // Another organization asks for the same guide and learns nothing
      expect(await documents.announceNotesOfCancelledGuide(ctx.orgB.id, shipment.id)).toBe(0)
    })

    it('is told by the event of the cancelled guide, as the platform raises it', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [note] = await noteOf(shipment.id)
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      await owner.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      const seen: FiscalRemissionVoidDeadlinePayload[] = []
      const listener = (payload: FiscalRemissionVoidDeadlinePayload): void => {
        seen.push(payload)
      }
      emitter.on(Events.FISCAL_REMISSION_VOID_DEADLINE, listener)
      try {
        await emitter.emitAsync(Events.SHIPMENT_CANCELLED, {
          storeId: ctx.storeA.id,
          shipmentId: shipment.id,
          orderId: order.id,
          orderNumber: 'N',
          connectionId: shipment.connectionId,
          actor: { type: 'system' as const, id: null }
        })
        await new Promise(resolve => setImmediate(resolve))
      } finally {
        emitter.off(Events.FISCAL_REMISSION_VOID_DEADLINE, listener)
      }
      expect(seen.filter(payload => payload.documentId === note?.id)).toHaveLength(1)
    })

    it('tells nothing for a note that was never accepted, and the note stays alive (a person voids it)', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [note] = await noteOf(shipment.id)
      await owner.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      expect((await told(shipment.id, note?.id ?? '')).count).toBe(0)
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })).status
      ).toBe(FiscalDocumentStatus.QUEUED)
    })
  })

  describe('a sale document that follows its notes (D3b-3)', () => {
    // What the provider is asked to build: the sale is made and sent after the notes, and the provider is shown which notes it may name
    async function followedBy(saleId: string): Promise<string[]> {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is not registered')
      const build = jest.spyOn(provider, 'build')
      try {
        // What happens after the build is the business of other specs: only the offer to the provider is read here
        await documents.submit(ctx.orgA.id, saleId).catch(() => undefined)
        const input = build.mock.calls[0]?.[0]
        expect(input?.kind).toBe(FiscalDocumentKind.SALE)
        return (input?.follows ?? []).map(item => item.externalNumber)
      } finally {
        build.mockRestore()
      }
    }
    const acceptedNote = async (orderId: string) => {
      const shipment = await guide(orderId)
      await created(shipment)
      const [note] = await noteOf(shipment.id)
      await documents.submit(ctx.orgA.id, note?.id ?? '')
      // Only one guide of an order and warehouse is active: the note of this one stays accepted after it is cancelled, as the notes of
      // cancelled guides do (a person voids them), and the next guide of the order can be made
      await owner.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      return owner.fiscalDocument.findUniqueOrThrow({ where: { id: note?.id } })
    }

    it('offers the accepted notes of its order, and not a voided one, nor one of another order', async () => {
      const order = await dispatchedOrder()
      const alive = await acceptedNote(order.id)
      const voided = await acceptedNote(order.id)
      await owner.fiscalDocument.update({
        where: { id: voided.id },
        data: {
          status: FiscalDocumentStatus.VOIDED,
          voidedAt: new Date(),
          voidReason: 'wrong data'
        }
      })
      // A note of another order is never offered
      const other = await dispatchedOrder()
      await acceptedNote(other.id)
      const saleId = await documents.createForOrder(ctx.orgA.id, order.id, FiscalIssueOn.DELIVERED)
      expect(saleId).not.toBeNull()
      expect(await followedBy(saleId ?? '')).toEqual([alive.externalNumber])
    })

    it('offers none for the document of an order that has no note', async () => {
      const order = await dispatchedOrder()
      const saleId = await documents.createForOrder(ctx.orgA.id, order.id, FiscalIssueOn.DELIVERED)
      expect(await followedBy(saleId ?? '')).toEqual([])
    })
  })

  describe('the database', () => {
    it('refuses a note that names the guide of another store, of another order, no guide at all, and a guide on any other kind', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const foreign = await createShipment(owner, { storeId: ctx.storeB.id })
      const own = await createShipment(owner, { storeId: ctx.storeA.id, orderId: order.id })
      // The control: the same insert with its own guide and its own order is accepted, so every refusal below is about what it says
      const control = await owner.fiscalDocument.create({
        data: rawNote({ orderId: order.id, kind: 'remission_note', shipmentId: own.id }),
        select: { id: true }
      })
      expect(control.id).toBeTruthy()
      const other = await createOrder(owner, { storeId: ctx.storeA.id })
      const spare = await createShipment(owner, { storeId: ctx.storeA.id, orderId: other.id })
      // The foreign key is (store, guide): the guide of store B is not store A's
      await expect(
        owner.fiscalDocument.create({
          data: rawNote({ orderId: order.id, kind: 'remission_note', shipmentId: foreign.id })
        })
      ).rejects.toThrow(
        // The scope of the document answers first (a trigger before the insert); the foreign key is the floor under it
        /the guide of a remission note belongs|fiscal_documents_store_id_shipment_id_fkey|Foreign key constraint/i
      )
      // The guide is one of the order of the note: the guide of another order of the same store is refused by the scope of the document
      await expect(
        owner.fiscalDocument.create({
          data: rawNote({ orderId: order.id, kind: 'remission_note', shipmentId: spare.id })
        })
      ).rejects.toThrow(/the guide of a remission note belongs|integrity_constraint_violation/i)
      // A remission note names its guide, and nothing else does
      await expect(
        owner.fiscalDocument.create({
          data: rawNote({ orderId: order.id, kind: 'remission_note' })
        })
      ).rejects.toThrow(/chk_fiscal_documents_shipment_only_remission|check constraint/i)
      await expect(
        owner.fiscalDocument.create({
          data: rawNote({ orderId: other.id, kind: 'sale', shipmentId: spare.id })
        })
      ).rejects.toThrow(/chk_fiscal_documents_shipment_only_remission|check constraint/i)
    })

    it('has the composite foreign key to the guide, restricting its deletion (the scope trigger answers first, so only the catalog proves it)', async () => {
      const rows = await owner.$queryRaw<{ columns: number; onDelete: string }[]>`
        SELECT array_length(conkey, 1) AS "columns", confdeltype::text AS "onDelete"
        FROM pg_constraint
        WHERE conname = 'fiscal_documents_store_id_shipment_id_fkey'
          AND conrelid = 'fiscal_documents'::regclass
          AND confrelid = 'shipments'::regclass`
      // Two columns (the store and the guide) and RESTRICT ('r'): the guide of a note can never be deleted
      expect(rows).toEqual([{ columns: 2, onDelete: 'r' }])
    })

    it('leaves room for the note of a guide again once the one before was voided', async () => {
      const order = await dispatchedOrder()
      const shipment = await guide(order.id)
      await created(shipment)
      const [first] = await noteOf(shipment.id)
      await owner.fiscalDocument.update({
        where: { id: first?.id },
        data: { status: 'voided', voidedAt: new Date(), voidReason: 'The guide was made again' }
      })
      const again = await owner.fiscalDocument.create({
        data: rawNote({
          orderId: order.id,
          kind: 'remission_note',
          shipmentId: shipment.id
        }),
        select: { id: true }
      })
      expect(again.id).not.toBe(first?.id)
      expect(await noteOf(shipment.id)).toHaveLength(2)
    })
  })
})
