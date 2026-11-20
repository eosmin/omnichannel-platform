import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalConflictReasons,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalEvidenceKind,
  FiscalIssueOn,
  FiscalRejectionReasons,
  MediaStatus,
  OrderReturnStatus,
  OrderStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events, type FiscalDocumentStuckPayload } from '@platform/core/events'
import { JobNames, QueueNames } from '@platform/core/queues'
import { MediaPurpose } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { FiscalDocumentsService, FiscalProviderRegistry } from '@platform/fiscal/runtime'
import { SIMULATOR_PROVIDER_ID, SimulatorRules } from '@platform/fiscal/simulator'

import { createOrder } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}

const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Evidence Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
}
const RECEIVER_TAX_ID = '0614-010101-101-1'

// The evidence of a fiscal document as media, the void that is asked about before it is sent, the change of issuer a person confirms and the
// credit note that is made again (Step 4B.7b-2). The documents belong to the organization; nothing crosses to another.
describe('The evidence and the second thoughts of the fiscal documents (Step 4B.7b-2)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2
  let storage: StorageService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    documents = app.get(FiscalDocumentsService)
    emitter = app.get(EventEmitter2)
    storage = app.get(StorageService)
    expect((await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)).status).toBe(OK)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const jobs = () => queueOf(app, QueueNames.HEAVY_PROCESSING).jobs

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

  // The sale, delivered: its document is made; `taxId` is the rule of the simulator it answers by; `accept` submits it
  async function sale(options: { taxId?: string; accept?: boolean } = {}) {
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
    if (options.taxId !== undefined) {
      const fix = await asAdminA()
        .patch(ApiRoutes.fiscal.documents.receiver(document.id))
        .send({ taxId: options.taxId, name: 'Ana Receiver' })
      expect(fix.status).toBe(OK)
    }
    if (options.accept === true) await documents.submit(ctx.orgA.id, document.id)
    return { ...order, documentId: document.id }
  }

  const evidenceOf = (documentId: string) =>
    owner.media.findMany({
      where: { fiscalDocumentId: documentId },
      orderBy: { fiscalEvidenceKind: 'asc' }
    })
  const evidenceUrl = (documentId: string, kind: string) =>
    asAdminA().get(ApiRoutes.fiscal.documents.evidence(documentId, kind))

  describe('the evidence of a document', () => {
    it('keeps the document and the answer of the authority as files of the store, pending their scan, which is queued', async () => {
      const { documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const files = await evidenceOf(documentId)
      expect(files.map(file => file.fiscalEvidenceKind)).toEqual([
        FiscalEvidenceKind.DOCUMENT,
        FiscalEvidenceKind.RESPONSE
      ])
      for (const file of files) {
        expect(file.purpose).toBe(MediaPurpose.FISCAL_EVIDENCE)
        expect(file.storeId).toBe(ctx.storeA.id)
        expect(file.status).toBe(MediaStatus.PENDING)
        expect(file.contentType).toBe('application/json')
        expect(file.key).toContain(`/fiscal-evidence/${documentId}/${file.id}/`)
        expect(await storage.head(file.key)).not.toBeNull()
        // Scanned like any file before anybody is given a link
        const job = jobs().find(entry => entry.opts?.jobId === `${JobNames.SCAN_FILE}-${file.id}`)
        expect(job?.data).toEqual({ mediaId: file.id, storeId: ctx.storeA.id })
      }
      // Asked again, it is the same files: one of each kind for ever
      await expect(
        documents.submit(ctx.orgA.id, documentId).then(() => evidenceOf(documentId))
      ).resolves.toHaveLength(2)
    })

    it('gives a signed link only to a clean file, to who reads the fiscal documents, and audits it', async () => {
      const { documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const pending = await evidenceUrl(documentId, FiscalEvidenceKind.DOCUMENT)
      expect(pending.status).toBe(CONFLICT)
      expect((pending.body as ErrorBody).error.code).toBe(ErrorCodes.FILE_NOT_READY)

      await owner.media.updateMany({
        where: { fiscalDocumentId: documentId },
        data: { status: MediaStatus.CLEAN, scannedAt: new Date() }
      })
      const clean = await evidenceUrl(documentId, FiscalEvidenceKind.DOCUMENT)
      expect(clean.status).toBe(OK)
      const body = (clean.body as { data: { url: string; contentType: string } }).data
      expect(body.url).toContain('http')
      expect(body.contentType).toBe('application/json')
      await waitForAuditEntries(owner, {
        action: AuditAction.FISCAL_EVIDENCE_READ,
        userId: ctx.adminA.id
      })

      // Who does not read the fiscal documents is refused, and a kind that does not exist is a bad request
      const noFiscal = await actorWithPermissions(owner, app, {
        prefix,
        name: 'no-fiscal',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.MEDIA_VIEW]
      })
      const refused = await api(app, noFiscal, ctx.storeA).get(
        ApiRoutes.fiscal.documents.evidence(documentId, FiscalEvidenceKind.DOCUMENT)
      )
      expect(refused.status).toBe(FORBIDDEN)
      expect((await evidenceUrl(documentId, 'something')).status).toBe(BAD_REQUEST)
      // A kind the document does not have (it was never voided)
      expect((await evidenceUrl(documentId, FiscalEvidenceKind.VOID_RESPONSE)).status).toBe(
        NOT_FOUND
      )
    })

    it('never gives the evidence of a document to another organization, whichever store it names', async () => {
      const { documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      await owner.media.updateMany({
        where: { fiscalDocumentId: documentId },
        data: { status: MediaStatus.CLEAN, scannedAt: new Date() }
      })
      const other = await api(app, ctx.adminB, ctx.storeB).get(
        ApiRoutes.fiscal.documents.evidence(documentId, FiscalEvidenceKind.DOCUMENT)
      )
      expect(other.status).toBe(NOT_FOUND)
      expect(JSON.stringify(other.body)).not.toContain('http')
    })

    it('makes the file on request when it was not made as the document was accepted (the bucket was down)', async () => {
      const spy = jest.spyOn(storage, 'put').mockRejectedValue(new Error('bucket down'))
      let documentId: string
      try {
        ;({ documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true }))
      } finally {
        spy.mockRestore()
      }
      // The authority had answered: the document is accepted and has no file yet
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })).status
      ).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(await evidenceOf(documentId)).toHaveLength(0)
      // Asked for, it is made from the row (pending its scan: not served yet)
      const asked = await evidenceUrl(documentId, FiscalEvidenceKind.DOCUMENT)
      expect(asked.status).toBe(CONFLICT)
      expect(await evidenceOf(documentId)).toHaveLength(1)
    })

    it('keeps the file a pending request made: asked again it is the same file, never two and never none', async () => {
      const spy = jest.spyOn(storage, 'put').mockRejectedValue(new Error('bucket down'))
      let documentId: string
      try {
        ;({ documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true }))
      } finally {
        spy.mockRestore()
      }
      expect(await evidenceOf(documentId)).toHaveLength(0)
      // The request makes the file and answers 409: the answer must not take the file with it
      expect((await evidenceUrl(documentId, FiscalEvidenceKind.RESPONSE)).status).toBe(CONFLICT)
      const [made, ...rest] = await evidenceOf(documentId)
      expect(rest).toHaveLength(0)
      expect(made?.fiscalEvidenceKind).toBe(FiscalEvidenceKind.RESPONSE)
      expect((await evidenceUrl(documentId, FiscalEvidenceKind.RESPONSE)).status).toBe(CONFLICT)
      const again = await evidenceOf(documentId)
      expect(again.map(file => file.id)).toEqual([made?.id])
    })

    it('writes nothing for a person who cannot reach the document: a 404 and no file made', async () => {
      const spy = jest.spyOn(storage, 'put').mockRejectedValue(new Error('bucket down'))
      let documentId: string
      try {
        ;({ documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true }))
      } finally {
        spy.mockRestore()
      }
      expect(await evidenceOf(documentId)).toHaveLength(0)
      // Another organization, and a member of this one who reads fiscal documents only in another store (HC-128)
      for (const as of [api(app, ctx.adminB, ctx.storeB), api(app, ctx.adminA2, ctx.storeA2)]) {
        const refused = await as.get(
          ApiRoutes.fiscal.documents.evidence(documentId, FiscalEvidenceKind.DOCUMENT)
        )
        expect(refused.status).toBe(NOT_FOUND)
      }
      expect(await evidenceOf(documentId)).toHaveLength(0)
    })

    it('writes the file again from the row when the pipeline deleted it after a verdict, and scans it again', async () => {
      const { documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const [file] = await evidenceOf(documentId)
      if (file === undefined) throw new Error('no evidence was kept')
      // The pipeline marks the row and deletes the object of a file with no clean verdict
      await owner.media.update({
        where: { id: file.id },
        data: { status: MediaStatus.UNSCANNABLE, scannedAt: new Date() }
      })
      await storage.delete(file.key)
      expect(await storage.head(file.key)).toBeNull()

      const asked = await evidenceUrl(documentId, FiscalEvidenceKind.DOCUMENT)
      expect(asked.status).toBe(CONFLICT)
      const after = await owner.media.findUniqueOrThrow({ where: { id: file.id } })
      expect([after.id, after.key, after.status]).toEqual([file.id, file.key, MediaStatus.PENDING])
      expect(await storage.head(file.key)).not.toBeNull()
      expect(await evidenceOf(documentId)).toHaveLength(2)
    })

    it('keeps the answer to the invalidation too, once the document is voided', async () => {
      const { documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const voided = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(documentId))
        .send({ reason: 'wrong customer' })
      expect(voided.status).toBe(OK)
      expect((await evidenceOf(documentId)).map(file => file.fiscalEvidenceKind)).toEqual([
        FiscalEvidenceKind.DOCUMENT,
        FiscalEvidenceKind.RESPONSE,
        FiscalEvidenceKind.VOID_RESPONSE
      ])
    })

    it('is kept for ever by the database: no delete, no change of what makes it evidence, no file in another store', async () => {
      const { documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const [file] = await evidenceOf(documentId)
      await expect(owner.media.delete({ where: { id: file?.id } })).rejects.toThrow(/never deleted/)
      await expect(
        owner.media.update({ where: { id: file?.id }, data: { key: 'stores/x/other' } })
      ).rejects.toThrow(/keeps its document, kind, store and file/)
      await expect(
        owner.media.update({
          where: { id: file?.id },
          data: { fiscalEvidenceKind: 'void_response' }
        })
      ).rejects.toThrow(/keeps its document, kind, store and file/)
      // The scan can move its status: that is all that moves
      await expect(
        owner.media.update({ where: { id: file?.id }, data: { status: MediaStatus.CLEAN } })
      ).resolves.toBeDefined()
      // A second file of the same kind is refused, and so is one kept in a store that is not the document's
      await expect(
        owner.media.create({
          data: {
            storeId: ctx.storeA.id,
            purpose: MediaPurpose.FISCAL_EVIDENCE,
            fiscalDocumentId: documentId,
            fiscalEvidenceKind: FiscalEvidenceKind.DOCUMENT,
            key: `${prefix}/second`,
            filename: 'second.json',
            contentType: 'application/json',
            fileSize: 2
          }
        })
      ).rejects.toThrow()
      await expect(
        owner.media.create({
          data: {
            storeId: ctx.storeB.id,
            purpose: MediaPurpose.FISCAL_EVIDENCE,
            fiscalDocumentId: documentId,
            fiscalEvidenceKind: FiscalEvidenceKind.VOID_RESPONSE,
            key: `${prefix}/foreign`,
            filename: 'foreign.json',
            contentType: 'application/json',
            fileSize: 2
          }
        })
      ).rejects.toThrow(/FISCAL_EVIDENCE_SCOPE/)
      // A file of another purpose cannot name a document, and evidence has no other parent
      await expect(
        owner.media.create({
          data: {
            storeId: ctx.storeA.id,
            purpose: MediaPurpose.ORDER,
            fiscalDocumentId: documentId,
            fiscalEvidenceKind: FiscalEvidenceKind.VOID_RESPONSE,
            key: `${prefix}/wrong-purpose`,
            filename: 'wrong.json',
            contentType: 'application/json',
            fileSize: 2
          }
        })
      ).rejects.toThrow()
    })
  })

  describe('the notice of a document that ran out of attempts', () => {
    it('says it once for a document still waiting for the provider, and says nothing for one that was decided', async () => {
      const seen: FiscalDocumentStuckPayload[] = []
      const listener = (payload: FiscalDocumentStuckPayload): void => {
        seen.push(payload)
      }
      emitter.on(Events.FISCAL_DOCUMENT_STUCK, listener)
      try {
        const waiting = await sale({ taxId: 'UNAVAILABLE-3' })
        await expect(documents.submit(ctx.orgA.id, waiting.documentId)).rejects.toThrow()
        await documents.reportExhausted(ctx.orgA.id, waiting.documentId)
        const decided = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
        await documents.reportExhausted(ctx.orgA.id, decided.documentId)
        // Another organization's document says nothing
        await documents.reportExhausted(ctx.orgB.id, waiting.documentId)
        await new Promise(resolve => setTimeout(resolve, 200))
        expect(seen).toEqual([
          expect.objectContaining({ documentId: waiting.documentId, orderId: waiting.id })
        ])
      } finally {
        emitter.off(Events.FISCAL_DOCUMENT_STUCK, listener)
      }
    })
  })

  describe('the invalidation that was received and not answered', () => {
    it('asks the authority after a void that got no answer and settles the document as voided with what it answered', async () => {
      const { documentId } = await sale({ taxId: SimulatorRules.VOID_LOST, accept: true })
      const voided = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(documentId))
        .send({ reason: 'wrong customer' })
      expect(voided.status).toBe(OK)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.VOIDED)
      expect(row.voidResponse).toEqual({ voided: true, recovered: true })
    })

    it('still refuses a document the authority did not void when it did not answer either', async () => {
      const { documentId } = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is not registered')
      const spy = jest.spyOn(provider, 'void').mockRejectedValue(new Error('timeout'))
      try {
        const refused = await asAdminA()
          .post(ApiRoutes.fiscal.documents.void(documentId))
          .send({ reason: 'wrong customer' })
        expect(refused.status).toBe(CONFLICT)
        expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE)
      } finally {
        spy.mockRestore()
      }
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })).status
      ).toBe(FiscalDocumentStatus.ACCEPTED)
    })
  })

  describe('a document that may be at the issuer it was made with', () => {
    it('is not moved by a retry, and a person who checked that it is not there confirms it, with a reason, and it goes to the new issuer', async () => {
      const { documentId } = await sale({ taxId: 'UNAVAILABLE-3' })
      // An attempt that the authority did not answer: it may have the document
      await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow()
      // The issuer is changed (its identity), so the document is not the one the issuer makes now
      expect(
        (
          await asAdminA()
            .put(ApiRoutes.fiscal.issuer)
            .send({ ...ISSUER, legalName: 'Moved Issuer' })
        ).status
      ).toBe(OK)
      await documents.submit(ctx.orgA.id, documentId)
      const stuck = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(stuck.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(stuck.rejectionReason).toBe(FiscalRejectionReasons.ISSUER_CHANGED)
      expect(stuck.attempts).toBeGreaterThan(0)

      const retry = await asAdminA().post(ApiRoutes.fiscal.documents.retry(documentId))
      expect(retry.status).toBe(CONFLICT)
      expect((retry.body as ErrorBody).error.metadata?.['reason']).toBe(
        FiscalConflictReasons.ISSUER_CHANGED_IN_FLIGHT
      )

      // A reason is needed, and the permission to manage
      expect(
        (await asAdminA().post(ApiRoutes.fiscal.documents.confirmIssuerChange(documentId)).send({}))
          .status
      ).toBe(BAD_REQUEST)
      const confirmed = await asAdminA()
        .post(ApiRoutes.fiscal.documents.confirmIssuerChange(documentId))
        .send({ reason: 'checked with the authority: not there' })
      expect(confirmed.status).toBe(OK)
      const again = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(again.status).toBe(FiscalDocumentStatus.QUEUED)
      expect(again.attempts).toBe(0)
      expect(again.submission).toBe(stuck.submission + 1)
      expect((again.issuerSnapshot as { legalName: string }).legalName).toBe('Moved Issuer')
      await waitForAuditEntries(owner, {
        action: AuditAction.FISCAL_ISSUER_CHANGE_CONFIRMED,
        userId: ctx.adminA.id
      })
      // The authority of the new issuer answers (the rule that made the first one unavailable was the old authority's)
      expect(
        (
          await asAdminA()
            .patch(ApiRoutes.fiscal.documents.receiver(documentId))
            .send({ taxId: RECEIVER_TAX_ID })
        ).status
      ).toBe(OK)
      await documents.submit(ctx.orgA.id, documentId)
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })).status
      ).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('refuses to confirm a document that is not in that situation', async () => {
      const queued = await sale()
      const refused = await asAdminA()
        .post(ApiRoutes.fiscal.documents.confirmIssuerChange(queued.documentId))
        .send({ reason: 'checked' })
      expect(refused.status).toBe(CONFLICT)
      const accepted = await sale({ accept: true })
      expect(
        (
          await asAdminA()
            .post(ApiRoutes.fiscal.documents.confirmIssuerChange(accepted.documentId))
            .send({ reason: 'checked' })
        ).status
      ).toBe(CONFLICT)
      // Another organization's document is a document that does not exist
      const foreign = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.fiscal.documents.confirmIssuerChange(queued.documentId))
        .send({ reason: 'checked' })
      expect(foreign.status).toBe(NOT_FOUND)
    })
  })

  describe('a credit note that was voided', () => {
    async function receivedReturn(order: { id: string; itemId: string }) {
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
          quantity: 1
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

    it('is made again for the same return against the sale that is live, once, and never while the first stands', async () => {
      const order = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const returnId = await receivedReturn(order)
      const note = await owner.fiscalDocument.findFirstOrThrow({ where: { returnId } })
      await documents.submit(ctx.orgA.id, note.id)

      // A note that is not voided is not made again
      const early = await asAdminA().post(ApiRoutes.fiscal.documents.replace(note.id))
      expect(early.status).toBe(CONFLICT)
      expect((early.body as ErrorBody).error.metadata?.['reason']).toBe(
        FiscalConflictReasons.NOTE_NOT_VOIDED
      )

      expect(
        (
          await asAdminA()
            .post(ApiRoutes.fiscal.documents.void(note.id))
            .send({ reason: 'wrong units' })
        ).status
      ).toBe(OK)
      const again = await asAdminA().post(ApiRoutes.fiscal.documents.replace(note.id))
      expect(again.status).toBe(OK)
      const made = (again.body as { data: { id: string; status: string } }).data
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.kind).toBe(FiscalDocumentKind.CREDIT_NOTE)
      expect(row.returnId).toBe(returnId)
      expect(row.parentDocumentId).toBe(order.documentId)
      expect(row.status).toBe(FiscalDocumentStatus.QUEUED)
      expect(row.sequenceNumber).toBeGreaterThan(note.sequenceNumber)
      // Its job is queued like any other
      const job = jobs().find(
        entry => (entry.data as { documentId?: string }).documentId === made.id
      )
      expect(job?.name).toBe(JobNames.SUBMIT_FISCAL_DOCUMENT)

      // Once: the return has its live note now
      const twice = await asAdminA().post(ApiRoutes.fiscal.documents.replace(note.id))
      expect(twice.status).toBe(CONFLICT)
      expect((twice.body as ErrorBody).error.metadata?.['reason']).toBe(
        FiscalConflictReasons.NOTE_ALREADY_REPLACED
      )
      // The voided one is untouched
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: note.id } })).status
      ).toBe(FiscalDocumentStatus.VOIDED)
    })
  })
})
