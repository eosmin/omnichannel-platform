import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { JobContext, PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FinanceEventKind,
  FinanceSourceType,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEntryMismatchField,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalSweepKind,
  FiscalSweepLimits,
  InventoryMovementType,
  OrderReturnStatus,
  OrderStatus
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events, type FiscalEntryMismatchPayload } from '@platform/core/events'
import { FinancePostingService } from '@platform/core/finance-ledger'
import { submitFiscalDocumentJobId } from '@platform/core/queues'
import {
  type FiscalFindingsPage,
  FiscalContingencyService,
  FiscalDocumentsService,
  FiscalSweepService
} from '@platform/fiscal/runtime'
import { SIMULATOR_PROVIDER_ID } from '@platform/fiscal/simulator'

import { FiscalReconciler } from '../../apps/worker/src/finance/fiscal-reconciler.service'
import { createCarrierConnection, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'
import { onWorkerDatabase } from '../helpers/worker-db'

const OK = 200
const BAD_REQUEST = 400
const CREATED = 201
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Sweep Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
}

// The daily check of the fiscal documents (TDD_18 §8.3, §11, Step 4B.8b-2b): what the lifecycle lost is found and asked for through the
// lifecycle and the queue, once whatever the number of nights; a document that disagrees with its entry is told and never corrected.
describe('The check of the fiscal documents', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sweep: FiscalSweepService
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2
  let posting: FinancePostingService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], onWorkerDatabase())
    ctx = await seedTestContext(owner, app, prefix)
    sweep = app.get(FiscalSweepService)
    documents = app.get(FiscalDocumentsService)
    emitter = app.get(EventEmitter2)
    posting = app.get(FinancePostingService)
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const logger = {
    setContext: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined
  } as unknown as PinoLogger

  function reconciler(): {
    reconciler: FiscalReconciler
    heavy: CapturedQueue
    gauge: { labels: Record<string, string>; value: number }[]
  } {
    const heavy = new CapturedQueue()
    const gauge: { labels: Record<string, string>; value: number }[] = []
    return {
      heavy,
      gauge,
      reconciler: new FiscalReconciler(
        app.get(PrismaService),
        sweep,
        documents,
        app.get(FiscalContingencyService),
        heavy as never,
        {
          set: (labels: Record<string, string>, value: number) => gauge.push({ labels, value })
        } as never,
        app.get(DomainEvents),
        logger,
        app.get(JobContext)
      )
    }
  }

  // A delivered order of store A: 2 x $11.30 with 13 % in the price, $5.65 of shipping, what left for it costing $4.00 a unit
  async function deliveredOrder(
    input: { deliveredAt?: Date } = {}
  ): Promise<{ id: string; itemId: string; storeId: string; orderNumber: string }> {
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
    const connection = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    const order = await owner.order.update({
      where: { id: made.id },
      data: {
        status: OrderStatus.DELIVERED,
        subtotalCents: 2260,
        shippingCents: 565,
        discountCents: 0,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        paymentMethod: 'CASH_ON_DELIVERY',
        paymentStatus: 'PENDING',
        carrierConnectionId: connection.id,
        shippedAt: input.deliveredAt ?? new Date(),
        deliveredAt: input.deliveredAt ?? new Date()
      },
      select: { id: true, storeId: true, orderNumber: true }
    })
    const item = await owner.orderItem.findFirstOrThrow({
      where: { orderId: made.id },
      select: { productId: true }
    })
    await owner.inventoryMovement.create({
      data: {
        storeId: ctx.storeA.id,
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
    return { ...order, itemId: made.itemId }
  }

  // The sale is delivered and the listener makes its document: the first one is the go-live of the issuer
  async function documentedSale() {
    const order = await deliveredOrder()
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
      storeId: order.storeId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      actor: { type: 'system', id: null },
      from: OrderStatus.SHIPPED,
      to: OrderStatus.DELIVERED,
      notifyCustomer: false
    })
    const document = await owner.fiscalDocument.findFirstOrThrow({
      where: { orderId: order.id, kind: FiscalDocumentKind.SALE },
      select: { id: true }
    })
    return { ...order, documentId: document.id }
  }

  const idsOf = async (kind: FiscalSweepKind, organizationId = ctx.orgA.id): Promise<string[]> =>
    (await sweep.find(organizationId, kind)).data.map(item => item.id)
  const ageDocument = (documentId: string, hours: number): Promise<number> =>
    owner.$executeRaw`UPDATE fiscal_documents SET updated_at = ${new Date(Date.now() - hours * HOUR_MS)} WHERE id = ${documentId}`

  let firstSale: Awaited<ReturnType<typeof documentedSale>>

  it('finds nothing for an organization that issues no documents, and nothing before the first one', async () => {
    const orphan = await deliveredOrder()
    for (const kind of Object.values(FiscalSweepKind)) {
      expect(await idsOf(kind)).toEqual([])
    }
    const run = reconciler()
    const report = await run.reconciler.reconcile(ctx.orgA.id)
    expect(report.queued).toBe(0)
    expect(run.heavy.jobs).toEqual([])
    // The gauges say zero: an organization with no issuer has nothing to find
    expect(run.gauge.every(point => point.value === 0)).toBe(true)

    // An issuer with no document yet is the same: the first document is the go-live, no history is documented behind it
    const put = await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)
    expect(put.status).toBe(OK)
    expect(await idsOf(FiscalSweepKind.SALE_WITHOUT_DOCUMENT)).toEqual([])
    expect(await owner.fiscalDocument.count({ where: { orderId: orphan.id } })).toBe(0)
  })

  describe('a sale with no document', () => {
    it('is found when it was recognized after the first document, and never before it', async () => {
      firstSale = await documentedSale()
      const lost = await deliveredOrder()
      const history = await deliveredOrder({ deliveredAt: new Date(Date.now() - 2 * DAY_MS) })

      const found = await idsOf(FiscalSweepKind.SALE_WITHOUT_DOCUMENT)
      expect(found).toContain(lost.id)
      expect(found).not.toContain(history.id)
      expect(found).not.toContain(firstSale.id)
      // The dry run says the same, and changes nothing
      expect(await owner.fiscalDocument.count({ where: { orderId: lost.id } })).toBe(0)
    })

    it('is made by the lifecycle and queued as one submission, once whatever the number of nights', async () => {
      const lost = await deliveredOrder()
      const run = reconciler()
      const first = await run.reconciler.reconcile(ctx.orgA.id)
      expect(first.queued).toBeGreaterThanOrEqual(1)
      const made = await owner.fiscalDocument.findMany({
        where: { orderId: lost.id, kind: FiscalDocumentKind.SALE }
      })
      expect(made).toHaveLength(1)
      expect(made[0]?.status).toBe(FiscalDocumentStatus.QUEUED)
      const job = run.heavy.jobs.find(
        entry => entry.opts?.jobId === submitFiscalDocumentJobId(made[0]?.id ?? '', 1)
      )
      // The job carries the ids only: the sweep never submits a document itself
      expect(job?.data).toEqual({ organizationId: ctx.orgA.id, documentId: made[0]?.id })
      expect(made[0]?.issuedAt).toBeNull()

      const second = await run.reconciler.reconcile(ctx.orgA.id)
      expect(second.found[FiscalSweepKind.SALE_WITHOUT_DOCUMENT]).toBe(0)
      expect(
        await owner.fiscalDocument.count({
          where: { orderId: lost.id, kind: FiscalDocumentKind.SALE }
        })
      ).toBe(1)
      // The gauge of the kind went back to zero
      const last = run.gauge
        .filter(point => point.labels.kind === FiscalSweepKind.SALE_WITHOUT_DOCUMENT)
        .at(-1)
      expect(last?.value).toBe(0)
    })

    it('goes on to the next pages of findings, so what sits first cannot starve what sits behind', async () => {
      const lost = [await deliveredOrder(), await deliveredOrder(), await deliveredOrder()]
      const original = sweep.find.bind(sweep)
      const spy = jest
        .spyOn(sweep, 'find')
        .mockImplementation((organizationId, kind, options) =>
          original(organizationId, kind, { ...options, limit: 1 })
        )
      try {
        const run = reconciler()
        await run.reconciler.reconcile(ctx.orgA.id)
      } finally {
        spy.mockRestore()
      }
      for (const order of lost) {
        expect(
          await owner.fiscalDocument.count({
            where: { orderId: order.id, kind: FiscalDocumentKind.SALE }
          })
        ).toBe(1)
      }
    })

    it('rejects the night when the queue is down, after it went through every finding', async () => {
      const lost = await deliveredOrder()
      const broken = {
        getJob: () => Promise.reject(new Error('redis is down')),
        add: () => Promise.reject(new Error('redis is down'))
      }
      const down = new FiscalReconciler(
        app.get(PrismaService),
        sweep,
        documents,
        app.get(FiscalContingencyService),
        broken as never,
        { set: () => undefined } as never,
        app.get(DomainEvents),
        logger,
        app.get(JobContext)
      )
      await expect(down.reconcile(ctx.orgA.id)).rejects.toThrow('could not be acted on')
      // The document was made (one row, whatever the retries) and waits as QUEUED: once it is left for an hour the next night asks for its job
      expect(
        await owner.fiscalDocument.count({
          where: { orderId: lost.id, kind: FiscalDocumentKind.SALE }
        })
      ).toBe(1)
    })

    it('does not look behind a document of the sandbox when the issuer is in production', async () => {
      const lost = await deliveredOrder()
      expect(await idsOf(FiscalSweepKind.SALE_WITHOUT_DOCUMENT)).toContain(lost.id)
      await owner.fiscalIssuer.update({
        where: { organizationId: ctx.orgA.id },
        data: { environment: FiscalEnvironment.PRODUCTION }
      })
      try {
        // The go-live of production is the first document made there: until it exists nothing is "missing"
        expect(await idsOf(FiscalSweepKind.SALE_WITHOUT_DOCUMENT)).toEqual([])
      } finally {
        await owner.fiscalIssuer.update({
          where: { organizationId: ctx.orgA.id },
          data: { environment: FiscalEnvironment.SANDBOX }
        })
      }
    })

    it('takes a document that the listener made first as the answer, not as a failure', async () => {
      const lost = await deliveredOrder()
      const spy = jest
        .spyOn(documents, 'createForOrder')
        .mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
      try {
        const run = reconciler()
        await expect(run.reconciler.reconcile(ctx.orgA.id)).resolves.toBeDefined()
        expect(run.heavy.jobs).toEqual([])
      } finally {
        spy.mockRestore()
      }
      expect(lost.id).toBeDefined()
    })

    it('makes no document for a cancelled order, nor for an order that has one in any status', async () => {
      const cancelled = await deliveredOrder()
      await owner.order.update({
        where: { id: cancelled.id },
        data: { status: OrderStatus.CANCELLED }
      })
      const voidedSale = await deliveredOrder()
      expect(await idsOf(FiscalSweepKind.SALE_WITHOUT_DOCUMENT)).not.toContain(cancelled.id)
      // A document that exists in any status is a document: the sweep never makes a second one
      await owner.fiscalDocument.create({
        data: {
          ...(await owner.fiscalDocument.findUniqueOrThrow({
            where: { id: firstSale.documentId },
            select: {
              organizationId: true,
              storeId: true,
              receiverEncrypted: true,
              providerId: true,
              environment: true,
              currency: true
            }
          })),
          orderId: voidedSale.id,
          issuerSnapshot: {},
          linesSnapshot: [],
          sequenceNumber:
            900_000 +
            (await owner.fiscalDocument.count({ where: { organizationId: ctx.orgA.id } })),
          documentType: 'pending',
          status: FiscalDocumentStatus.VOIDED,
          voidReason: 'test',
          voidedAt: new Date(),
          totalCents: 2825,
          taxCents: 325
        }
      })
      expect(await idsOf(FiscalSweepKind.SALE_WITHOUT_DOCUMENT)).not.toContain(voidedSale.id)
    })
  })

  describe('a document left in the queue', () => {
    it('is found when it did not move for an hour, and its job is asked again with the same id', async () => {
      const sale = await documentedSale()
      // Just made: waiting for its job, not left
      expect(await idsOf(FiscalSweepKind.STALLED_DOCUMENT)).not.toContain(sale.documentId)
      await ageDocument(sale.documentId, 2)
      expect(await idsOf(FiscalSweepKind.STALLED_DOCUMENT)).toContain(sale.documentId)

      const run = reconciler()
      await run.reconciler.reconcile(ctx.orgA.id)
      const jobs = run.heavy.jobs.filter(
        entry => entry.opts?.jobId === submitFiscalDocumentJobId(sale.documentId, 1)
      )
      expect(jobs).toHaveLength(1)
      // A document that was accepted is never "left", however long ago it last moved (an accepted row cannot be touched afterwards)
      await owner.fiscalDocument.update({
        where: { id: sale.documentId },
        data: {
          status: FiscalDocumentStatus.ACCEPTED,
          issuedAt: new Date(),
          updatedAt: new Date(Date.now() - 2 * HOUR_MS)
        }
      })
      expect(await idsOf(FiscalSweepKind.STALLED_DOCUMENT)).not.toContain(sale.documentId)
    })

    it('is found as SUBMITTED when no worker moved it for the lease and then some', async () => {
      const sale = await documentedSale()
      await owner.fiscalDocument.update({
        where: { id: sale.documentId },
        data: { status: FiscalDocumentStatus.SUBMITTED }
      })
      expect(await idsOf(FiscalSweepKind.STALLED_DOCUMENT)).not.toContain(sale.documentId)
      await ageDocument(sale.documentId, FiscalSweepLimits.SUBMITTED_STALL_MINUTES / 60 + 0.1)
      const page = await sweep.find(ctx.orgA.id, FiscalSweepKind.STALLED_DOCUMENT)
      const item = page.data.find(entry => entry.id === sale.documentId)
      expect(item?.status).toBe(FiscalDocumentStatus.SUBMITTED)
      expect(item?.submission).toBe(1)
    })
  })

  describe('a return with no credit note', () => {
    it('is found, made through the lifecycle and queued, once', async () => {
      const sale = await documentedSale()
      await documents.submit(ctx.orgA.id, sale.documentId)
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: sale.documentId } })).status
      ).toBe(FiscalDocumentStatus.ACCEPTED)
      const made = await owner.orderReturn.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: sale.id,
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
          orderItemId: sale.itemId,
          quantity: 1
        }
      })
      // The event never reached the listener
      expect(await idsOf(FiscalSweepKind.CREDIT_NOTE_MISSING)).toContain(made.id)

      const run = reconciler()
      await run.reconciler.reconcile(ctx.orgA.id)
      const note = await owner.fiscalDocument.findFirstOrThrow({
        where: { returnId: made.id, kind: FiscalDocumentKind.CREDIT_NOTE }
      })
      expect(note.parentDocumentId).toBe(sale.documentId)
      expect(
        run.heavy.jobs.some(entry => entry.opts?.jobId === submitFiscalDocumentJobId(note.id, 1))
      ).toBe(true)
      expect(await idsOf(FiscalSweepKind.CREDIT_NOTE_MISSING)).not.toContain(made.id)
      await run.reconciler.reconcile(ctx.orgA.id)
      expect(
        await owner.fiscalDocument.count({
          where: { returnId: made.id, kind: FiscalDocumentKind.CREDIT_NOTE }
        })
      ).toBe(1)
    })
  })

  describe('a document that disagrees with its entry', () => {
    it('is found by the field that differs, told once, and never corrected', async () => {
      const sale = await documentedSale()
      await posting.post({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.ORDER,
        sourceId: sale.id,
        kind: FinanceEventKind.SALE
      })
      // The sale and its document agree. The entry was posted after the document, so the column that links them stays null for good (an
      // immutable one, HC-109): the check finds the entry by its key, never by that column
      expect(await idsOf(FiscalSweepKind.ENTRY_MISMATCH)).not.toContain(sale.documentId)
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: sale.documentId } }))
          .journalEntryId
      ).toBeNull()

      await owner.fiscalDocument.update({
        where: { id: sale.documentId },
        data: { totalCents: 2925, taxCents: 325 }
      })
      let page = await sweep.find(ctx.orgA.id, FiscalSweepKind.ENTRY_MISMATCH)
      expect(page.data.find(item => item.id === sale.documentId)?.fields).toEqual([
        FiscalEntryMismatchField.TOTAL
      ])
      await owner.fiscalDocument.update({
        where: { id: sale.documentId },
        data: { taxCents: 300 }
      })
      page = await sweep.find(ctx.orgA.id, FiscalSweepKind.ENTRY_MISMATCH)
      expect(page.data.find(item => item.id === sale.documentId)?.fields).toEqual([
        FiscalEntryMismatchField.TOTAL,
        FiscalEntryMismatchField.TAX
      ])

      const told: FiscalEntryMismatchPayload[] = []
      const listener = (payload: FiscalEntryMismatchPayload): void => {
        told.push(payload)
      }
      emitter.on(Events.FISCAL_ENTRY_MISMATCH, listener)
      try {
        const run = reconciler()
        const report = await run.reconciler.reconcile(ctx.orgA.id)
        expect(report.found[FiscalSweepKind.ENTRY_MISMATCH]).toBeGreaterThanOrEqual(1)
        expect(told).toHaveLength(1)
        expect(told[0]?.organizationId).toBe(ctx.orgA.id)
        // The event names ids and a count: no amount, no receiver
        expect(Object.keys(told[0] ?? {}).sort()).toEqual(['count', 'documentId', 'organizationId'])
      } finally {
        emitter.off(Events.FISCAL_ENTRY_MISMATCH, listener)
      }
      // Nothing was corrected: the document and the entry are what they were
      const after = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: sale.documentId } })
      expect([after.totalCents, after.taxCents]).toEqual([2925, 300])
      expect(
        await owner.journalEntry.count({
          where: { organizationId: ctx.orgA.id, sourceId: sale.id }
        })
      ).toBe(1)
    })
  })

  describe('the dry run and the isolation', () => {
    it('pages the findings of one kind and shows the same ids as the check', async () => {
      // Its own findings, so it never leans on what another case left: two documents left in the queue for two hours
      await ageDocument((await documentedSale()).documentId, 2)
      await ageDocument((await documentedSale()).documentId, 2)
      const first = await asAdminA()
        .get(ApiRoutes.fiscal.reconciliation)
        .query({ kind: FiscalSweepKind.STALLED_DOCUMENT, limit: 1 })
      expect(first.status).toBe(OK)
      const page = first.body as FiscalFindingsPage
      expect(page.data).toHaveLength(1)
      expect(page.hasMore).toBe(true)
      const all = await idsOf(FiscalSweepKind.STALLED_DOCUMENT)
      expect(all.length).toBeGreaterThanOrEqual(2)
      const seen = [...page.data.map(item => item.id)]
      let cursor = page.nextCursor
      while (cursor !== null) {
        const next = await asAdminA()
          .get(ApiRoutes.fiscal.reconciliation)
          .query({ kind: FiscalSweepKind.STALLED_DOCUMENT, limit: 1, cursor })
        const body = next.body as FiscalFindingsPage
        seen.push(...body.data.map(item => item.id))
        cursor = body.nextCursor
      }
      expect(seen.sort()).toEqual([...all].sort())
    })

    it('refuses a kind that does not exist and a page size that is too large', async () => {
      const kind = await asAdminA().get(ApiRoutes.fiscal.reconciliation).query({ kind: 'invoices' })
      expect(kind.status).toBe(BAD_REQUEST)
      const big = await asAdminA()
        .get(ApiRoutes.fiscal.reconciliation)
        .query({
          kind: FiscalSweepKind.STALLED_DOCUMENT,
          limit: FiscalSweepLimits.PAGE_SIZE_MAX + 1
        })
      expect(big.status).toBe(BAD_REQUEST)
    })

    it('shows an organization nothing of another one: not in the report, not in the check', async () => {
      for (const kind of Object.values(FiscalSweepKind)) {
        expect(await idsOf(kind, ctx.orgB.id)).toEqual([])
        const seen = await api(app, ctx.adminB, ctx.storeB)
          .get(ApiRoutes.fiscal.reconciliation)
          .query({ kind })
        expect(seen.status).toBe(OK)
        expect((seen.body as FiscalFindingsPage).data).toEqual([])
      }
      const run = reconciler()
      const report = await run.reconciler.reconcile(ctx.orgB.id)
      expect(report.queued).toBe(0)
      expect(run.heavy.jobs).toEqual([])
    })
  })
})
