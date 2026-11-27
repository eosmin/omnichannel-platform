import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalConflictReasons,
  FiscalDeliveryReason,
  FiscalDeliveryRoute,
  FiscalDeliveryStatus,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalEvidenceKind,
  FiscalHandMeans,
  FiscalIssueOn,
  MediaStatus,
  OrderStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { MediaPurpose } from '@platform/core/storage'
import { FiscalDocumentsService } from '@platform/fiscal/runtime'
import { SIMULATOR_PROVIDER_ID } from '@platform/fiscal/simulator'

import { createOrder } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface DeliveryBody {
  data: {
    documentId: string
    state: string
    route: string | null
    reason: string | null
    means: string | null
    handedOverAt: string | null
    files: string[]
  }
}

const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Hand Delivery Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
}

// The files of an accepted document given to its receiver by a person of the store (Step 4B.7d, D13b-2a): which files exist, the record that
// closes a delivery the system could not make, and what it refuses. Every case has a document of its own, so none counts another's rows.
describe('The hand delivery of the files of a fiscal document (Step 4B.7d)', () => {
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
    expect((await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)).status).toBe(OK)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)

  // A delivered sale whose document is made, and accepted when asked
  async function sale(accept: boolean, options: { young?: boolean } = {}): Promise<string> {
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
    const fix = await asAdminA()
      .patch(ApiRoutes.fiscal.documents.receiver(document.id))
      .send({ taxId: '0614-010101-101-1', name: 'Ana Receiver' })
    expect(fix.status).toBe(OK)
    if (accept) {
      await documents.submit(ctx.orgA.id, document.id)
      // Accepted long enough ago for the delivery of the system to be over (a young document is refused, see the case of it below)
      if (options.young !== true) {
        await owner.$executeRaw`UPDATE fiscal_documents SET updated_at = ${new Date(Date.now() - 2 * 3_600_000)} WHERE id = ${document.id}`
      }
    }
    return document.id
  }

  // The two files of the receiver as rows of the evidence (the simulator draws none, so the files are written as the owner)
  async function withFiles(
    documentId: string,
    kinds: readonly FiscalEvidenceKind[],
    status: MediaStatus = MediaStatus.CLEAN
  ): Promise<void> {
    for (const kind of kinds) {
      const id = randomUUID()
      await owner.media.create({
        data: {
          id,
          storeId: ctx.storeA.id,
          purpose: MediaPurpose.FISCAL_EVIDENCE,
          fiscalDocumentId: documentId,
          fiscalEvidenceKind: kind,
          key: `stores/${ctx.storeA.id}/fiscal-evidence/${documentId}/${id}/${kind}`,
          filename: `${kind}.bin`,
          contentType: 'application/octet-stream',
          fileSize: 10,
          status
        }
      })
    }
  }

  const both = [FiscalEvidenceKind.REPRESENTATION, FiscalEvidenceKind.DTE_FILE]
  const read = (documentId: string) =>
    asAdminA().get(ApiRoutes.fiscal.documents.delivery(documentId))
  const handOver = (documentId: string, means: FiscalHandMeans) =>
    asAdminA().post(ApiRoutes.fiscal.documents.delivery(documentId)).send({ means })

  it('says a document the system has not delivered is pending and lists the files that exist', async () => {
    const documentId = await sale(true)
    const empty = (await read(documentId)).body as DeliveryBody
    expect(empty.data).toMatchObject({ state: 'pending', route: null, files: [] })
    await withFiles(documentId, [FiscalEvidenceKind.REPRESENTATION])
    const one = (await read(documentId)).body as DeliveryBody
    expect(one.data.files).toEqual([FiscalEvidenceKind.REPRESENTATION])
  })

  it('records a hand delivery for a document with no row, once, and audits it', async () => {
    const documentId = await sale(true)
    await withFiles(documentId, both)
    const first = await handOver(documentId, FiscalHandMeans.DOWNLOAD)
    expect(first.status).toBe(OK)
    expect((first.body as DeliveryBody).data).toMatchObject({
      state: FiscalDeliveryStatus.SENT,
      route: FiscalDeliveryRoute.MANUAL,
      means: FiscalHandMeans.DOWNLOAD,
      reason: null
    })
    const row = await owner.fiscalDelivery.findUniqueOrThrow({ where: { documentId } })
    expect(row.handedOverBy).toBe(ctx.adminA.id)
    expect(row.handedOverAt).not.toBeNull()
    await waitForAuditEntries(owner, {
      action: AuditAction.FISCAL_DELIVERY_HANDED_OVER,
      userId: ctx.adminA.id,
      resourceId: documentId
    })
    // A repeat is the same record: no second row and no second audit entry
    const again = await handOver(documentId, FiscalHandMeans.PAPER)
    expect(again.status).toBe(OK)
    expect((again.body as DeliveryBody).data.means).toBe(FiscalHandMeans.DOWNLOAD)
    expect(await owner.fiscalDelivery.count({ where: { documentId } })).toBe(1)
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.FISCAL_DELIVERY_HANDED_OVER, resourceId: documentId }
      })
    ).toBe(1)
  })

  it('closes a delivery the system could not make, keeping why it could not', async () => {
    const documentId = await sale(true)
    await withFiles(documentId, both)
    const document = await owner.fiscalDocument.findUniqueOrThrow({
      where: { id: documentId },
      select: { storeId: true, orderId: true }
    })
    await owner.fiscalDelivery.create({
      data: {
        organizationId: ctx.orgA.id,
        storeId: document.storeId,
        documentId,
        orderId: document.orderId,
        status: FiscalDeliveryStatus.NOT_SENT,
        route: FiscalDeliveryRoute.NONE,
        reason: FiscalDeliveryReason.NO_CHANNEL
      }
    })
    const pending = (await read(documentId)).body as DeliveryBody
    expect(pending.data).toMatchObject({ state: 'not_sent', reason: 'no_channel' })
    const done = await handOver(documentId, FiscalHandMeans.DOWNLOAD)
    expect(done.status).toBe(OK)
    expect((done.body as DeliveryBody).data).toMatchObject({
      state: 'sent',
      route: 'manual',
      reason: 'no_channel'
    })
  })

  it('takes the paper copy with the representation alone, and refuses the files when one is missing', async () => {
    const documentId = await sale(true)
    await withFiles(documentId, [FiscalEvidenceKind.REPRESENTATION])
    const refused = await handOver(documentId, FiscalHandMeans.DOWNLOAD)
    expect(refused.status).toBe(CONFLICT)
    expect((refused.body as ErrorBody).error.metadata).toMatchObject({
      reason: FiscalConflictReasons.DELIVERY_FILES_MISSING
    })
    expect(await owner.fiscalDelivery.count({ where: { documentId } })).toBe(0)
    const paper = await handOver(documentId, FiscalHandMeans.PAPER)
    expect(paper.status).toBe(OK)
    expect((paper.body as DeliveryBody).data.means).toBe(FiscalHandMeans.PAPER)
  })

  it('refuses a hand delivery while the system may still be delivering a document accepted a moment ago', async () => {
    const documentId = await sale(true, { young: true })
    await withFiles(documentId, both)
    const early = await handOver(documentId, FiscalHandMeans.DOWNLOAD)
    expect(early.status).toBe(CONFLICT)
    expect((early.body as ErrorBody).error.metadata).toMatchObject({
      reason: FiscalConflictReasons.DELIVERY_RUNNING
    })
    expect(await owner.fiscalDelivery.count({ where: { documentId } })).toBe(0)
  })

  it('does not count a file the scan refused or has not cleared: it cannot be given', async () => {
    const documentId = await sale(true)
    await withFiles(documentId, [FiscalEvidenceKind.REPRESENTATION], MediaStatus.INFECTED)
    await withFiles(documentId, [FiscalEvidenceKind.DTE_FILE], MediaStatus.PENDING)
    expect(((await read(documentId)).body as DeliveryBody).data.files).toEqual([])
    const refused = await handOver(documentId, FiscalHandMeans.PAPER)
    expect(refused.status).toBe(CONFLICT)
    expect((refused.body as ErrorBody).error.metadata).toMatchObject({
      reason: FiscalConflictReasons.DELIVERY_FILES_MISSING
    })
  })

  it('answers a repeat with the record even when the document was voided afterwards', async () => {
    const documentId = await sale(true)
    await withFiles(documentId, both)
    expect((await handOver(documentId, FiscalHandMeans.DOWNLOAD)).status).toBe(OK)
    await owner.$executeRaw`UPDATE fiscal_documents SET status = 'voided', voided_at = now(), void_reason = 'iso' WHERE id = ${documentId}`
    const again = await handOver(documentId, FiscalHandMeans.DOWNLOAD)
    expect(again.status).toBe(OK)
    expect((again.body as DeliveryBody).data.route).toBe(FiscalDeliveryRoute.MANUAL)
  })

  it('refuses a document the system already delivered, and one that is not accepted', async () => {
    const delivered = await sale(true)
    await withFiles(delivered, both)
    const row = await owner.fiscalDocument.findUniqueOrThrow({
      where: { id: delivered },
      select: { storeId: true, orderId: true }
    })
    await owner.fiscalDelivery.create({
      data: {
        organizationId: ctx.orgA.id,
        storeId: row.storeId,
        documentId: delivered,
        orderId: row.orderId,
        status: FiscalDeliveryStatus.SENT,
        route: FiscalDeliveryRoute.EMAIL
      }
    })
    const sent = await handOver(delivered, FiscalHandMeans.DOWNLOAD)
    expect(sent.status).toBe(CONFLICT)
    expect((sent.body as ErrorBody).error.metadata).toMatchObject({
      reason: FiscalConflictReasons.ALREADY_DELIVERED
    })
    const queued = await sale(false)
    await withFiles(queued, both)
    const notOwed = await handOver(queued, FiscalHandMeans.DOWNLOAD)
    expect(notOwed.status).toBe(CONFLICT)
    expect((notOwed.body as ErrorBody).error.metadata).toMatchObject({
      reason: FiscalConflictReasons.DELIVERY_NOT_OWED
    })
  })

  it('refuses who may not manage the documents, a body that says more, and a document of another organization', async () => {
    const documentId = await sale(true)
    await withFiles(documentId, both)
    const viewer = await actorWithPermissions(owner, app, {
      prefix,
      name: 'fiscal-viewer',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.FISCAL_VIEW]
    })
    const asViewer = api(app, viewer, ctx.storeA)
    expect((await asViewer.get(ApiRoutes.fiscal.documents.delivery(documentId))).status).toBe(OK)
    expect(
      (
        await asViewer
          .post(ApiRoutes.fiscal.documents.delivery(documentId))
          .send({ means: FiscalHandMeans.PAPER })
      ).status
    ).toBe(FORBIDDEN)
    const extra = await asAdminA()
      .post(ApiRoutes.fiscal.documents.delivery(documentId))
      .send({ means: FiscalHandMeans.PAPER, handedOverBy: 'someone-else' })
    expect(extra.status).toBe(400)
    const stranger = api(app, ctx.adminB, ctx.storeB)
    expect((await stranger.get(ApiRoutes.fiscal.documents.delivery(documentId))).status).toBe(
      NOT_FOUND
    )
    expect(
      (
        await stranger
          .post(ApiRoutes.fiscal.documents.delivery(documentId))
          .send({ means: FiscalHandMeans.PAPER })
      ).status
    ).toBe(NOT_FOUND)
    expect(await owner.fiscalDelivery.count({ where: { documentId } })).toBe(0)
  })
})
