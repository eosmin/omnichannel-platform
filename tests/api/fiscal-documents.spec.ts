import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalLimits,
  FiscalRejectionReasons,
  OrderStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events, type FiscalDocumentRejectedPayload } from '@platform/core/events'
import { JobNames, QueueNames, submitFiscalDocumentJobId } from '@platform/core/queues'
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

const SECRET = 'not-a-real-signing-key-1234567890'
const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Isolation Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: SECRET }
}

describe('The fiscal documents (Step 4B.7)', () => {
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
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const jobs = () => queueOf(app, QueueNames.HEAVY_PROCESSING).jobs

  // A delivered order of store A, with the tax snapshot of Step 4B.3b: 2 x $11.30 with 13 % in the price, $5.65 of shipping
  async function deliveredOrder(): Promise<{ id: string; storeId: string; orderNumber: string }> {
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
    return order
  }

  // The sale is delivered: the listener makes the document and queues its submission
  async function sale(): Promise<{ orderId: string; documentId: string }> {
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
      where: { orderId: order.id },
      select: { id: true }
    })
    return { orderId: order.id, documentId: document.id }
  }

  const patchReceiver = (documentId: string, body: Record<string, unknown>) =>
    asAdminA().patch(ApiRoutes.fiscal.documents.receiver(documentId)).send(body)
  const statusOf = async (documentId: string): Promise<string> =>
    (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })).status

  describe('the issuer', () => {
    it('lists the providers of the deployment and refuses an issuer the provider rejects', async () => {
      const providers = await asAdminA().get(ApiRoutes.fiscal.providers)
      expect(providers.status).toBe(OK)
      const ids = (providers.body as { data: { id: string }[] }).data.map(row => row.id)
      expect(ids).toContain(SIMULATOR_PROVIDER_ID)

      const refused = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, credentials: { other: 'x' } })
      expect(refused.status).toBe(BAD_REQUEST)
      expect((refused.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FISCAL_ISSUER_INVALID
      )

      const unknown = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, providerId: 'no-such-provider' })
      expect(unknown.status).toBe(CONFLICT)
      expect((unknown.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE
      )
    })

    it('keeps the credentials encrypted, never returns them and audits the field names only', async () => {
      const put = await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)
      expect(put.status).toBe(OK)
      expect(JSON.stringify(put.body)).not.toContain(SECRET)
      expect((put.body as { data: { credentialsSet: boolean } }).data.credentialsSet).toBe(true)
      const got = await asAdminA().get(ApiRoutes.fiscal.issuer)
      expect(JSON.stringify(got.body)).not.toContain(SECRET)

      const row = await owner.fiscalIssuer.findUniqueOrThrow({
        where: { organizationId: ctx.orgA.id }
      })
      expect(row.credentialsEncrypted).not.toBeNull()
      expect(Buffer.from(row.credentialsEncrypted ?? []).includes(Buffer.from(SECRET))).toBe(false)

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.FISCAL_ISSUER_CHANGED,
        userId: ctx.adminA.id
      })
      expect(JSON.stringify(entries)).not.toContain(SECRET)
    })

    it('moves the correlative forward only: a number is never used twice', async () => {
      const forward = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, nextSequence: 5000 })
      expect(forward.status).toBe(OK)
      expect((forward.body as { data: { nextSequence: number } }).data.nextSequence).toBe(5000)
      const back = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, nextSequence: 10 })
      expect(back.status).toBe(BAD_REQUEST)
      expect((back.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FISCAL_ISSUER_INVALID
      )
      // Left out, it keeps the stored one
      const kept = await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)
      expect(
        (kept.body as { data: { nextSequence: number } }).data.nextSequence
      ).toBeGreaterThanOrEqual(5000)
    })

    it('does not touch another organization: its issuer is its own', async () => {
      const other = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.fiscal.issuer)
      expect(other.status).toBe(OK)
      expect((other.body as { data: unknown }).data).toBeNull()
    })
  })

  describe('a sale makes its document', () => {
    it('queues one document per sale with the order amounts and a correlative, and a repeated event makes no second one', async () => {
      const first = await sale()
      // The job carries the ids only (never an amount or the receiver) and its id is the document and its submission
      const queued = jobs().filter(job => job.name === JobNames.SUBMIT_FISCAL_DOCUMENT)
      const job = queued.find(
        entry => entry.opts?.jobId === submitFiscalDocumentJobId(first.documentId, 1)
      )
      expect(job?.data).toEqual({ organizationId: ctx.orgA.id, documentId: first.documentId })
      const document = await owner.fiscalDocument.findUniqueOrThrow({
        where: { id: first.documentId }
      })
      expect(document.status).toBe(FiscalDocumentStatus.QUEUED)
      expect([document.totalCents, document.taxCents]).toEqual([2825, 325])
      expect(document.receiverEncrypted.length).toBeGreaterThan(0)

      const second = await sale()
      const other = await owner.fiscalDocument.findUniqueOrThrow({
        where: { id: second.documentId }
      })
      expect(other.sequenceNumber).toBe(document.sequenceNumber + 1)

      // The same sale again: the unique index of the order, no second document
      const order = await owner.order.findUniqueOrThrow({ where: { id: first.orderId } })
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
        storeId: order.storeId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        actor: { type: 'system', id: null },
        from: OrderStatus.SHIPPED,
        to: OrderStatus.DELIVERED,
        notifyCustomer: false
      })
      expect(await owner.fiscalDocument.count({ where: { orderId: first.orderId } })).toBe(1)
    })

    it('makes the document when the issuer says so: at shipped, or at delivered when the order never had a shipped event', async () => {
      const emit = async (orderId: string, orderNumber: string, to: OrderStatus): Promise<void> => {
        await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
          storeId: ctx.storeA.id,
          orderId,
          orderNumber,
          actor: { type: 'system', id: null },
          from: OrderStatus.CONFIRMED,
          to,
          notifyCustomer: false
        })
      }
      await owner.fiscalIssuer.update({
        where: { organizationId: ctx.orgA.id },
        data: { issueOn: FiscalIssueOn.SHIPPED }
      })
      try {
        const shipped = await deliveredOrder()
        await emit(shipped.id, shipped.orderNumber, OrderStatus.SHIPPED)
        expect(await owner.fiscalDocument.count({ where: { orderId: shipped.id } })).toBe(1)
        // The same order delivered later: still one document
        await emit(shipped.id, shipped.orderNumber, OrderStatus.DELIVERED)
        expect(await owner.fiscalDocument.count({ where: { orderId: shipped.id } })).toBe(1)
        // An order that went straight to delivered is not left without its document
        const straight = await deliveredOrder()
        await emit(straight.id, straight.orderNumber, OrderStatus.DELIVERED)
        expect(await owner.fiscalDocument.count({ where: { orderId: straight.id } })).toBe(1)
      } finally {
        await owner.fiscalIssuer.update({
          where: { organizationId: ctx.orgA.id },
          data: { issueOn: FiscalIssueOn.DELIVERED }
        })
      }
    })

    it('makes nothing when the organization has no issuer', async () => {
      const made = await createOrder(owner, { storeId: ctx.storeB.id })
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
        storeId: ctx.storeB.id,
        orderId: made.id,
        orderNumber: 'X',
        actor: { type: 'system', id: null },
        from: OrderStatus.SHIPPED,
        to: OrderStatus.DELIVERED,
        notifyCustomer: false
      })
      expect(await owner.fiscalDocument.count({ where: { orderId: made.id } })).toBe(0)
    })
  })

  describe('the lifecycle against the simulator', () => {
    it('accepts a document and keeps it as the evidence, and a repeated job does nothing', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(row.externalNumber).toMatch(/^SIM-/)
      expect(row.issuedAt).not.toBeNull()
      expect(row.builtPayloadEncrypted).not.toBeNull()
      await documents.submit(ctx.orgA.id, documentId)
      const again = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(again.attempts).toBe(row.attempts)
      expect(again.externalNumber).toBe(row.externalNumber)
    })

    it('keeps the document the provider built sealed: the receiver inside it is not readable in the database', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '0614-010101-101-1', name: 'Ana Receiver' })
      await documents.submit(ctx.orgA.id, documentId)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.ACCEPTED)
      const sealed = Buffer.from(row.builtPayloadEncrypted ?? [])
      expect(sealed.length).toBeGreaterThan(0)
      expect(sealed.includes(Buffer.from('0614-010101-101-1'))).toBe(false)
      expect(sealed.includes(Buffer.from('Ana Receiver'))).toBe(false)
    })

    it('is immutable once accepted: the service refuses first and the database is the floor', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const refused = await patchReceiver(documentId, { name: 'Changed' })
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FISCAL_DOCUMENT_IMMUTABLE
      )
      const retry = await asAdminA().post(ApiRoutes.fiscal.documents.retry(documentId))
      expect(retry.status).toBe(CONFLICT)

      await expect(
        owner.fiscalDocument.update({ where: { id: documentId }, data: { totalCents: 1 } })
      ).rejects.toThrow(/immutable/)
      await expect(owner.fiscalDocument.delete({ where: { id: documentId } })).rejects.toThrow(
        /never deleted/
      )
    })

    it('rejects, raises the event, and goes back to the queue once a person fixes the receiver', async () => {
      const seen: FiscalDocumentRejectedPayload[] = []
      const listener = (payload: FiscalDocumentRejectedPayload): void => {
        seen.push(payload)
      }
      emitter.on(Events.FISCAL_DOCUMENT_REJECTED, listener)
      try {
        const { documentId, orderId } = await sale()
        const fix = await patchReceiver(documentId, { taxId: SimulatorRules.REJECT, name: 'Ana' })
        expect(fix.status).toBe(OK)
        await documents.submit(ctx.orgA.id, documentId)
        const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
        expect(row.status).toBe(FiscalDocumentStatus.REJECTED)
        expect(row.rejectionReason).toBe(SimulatorRules.REJECT_REASON)
        expect(seen).toEqual([
          expect.objectContaining({ documentId, orderId, reason: SimulatorRules.REJECT_REASON })
        ])

        const fixed = await patchReceiver(documentId, { taxId: null })
        expect(fixed.status).toBe(OK)
        const retry = await asAdminA().post(ApiRoutes.fiscal.documents.retry(documentId))
        expect(retry.status).toBe(OK)
        expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.QUEUED)
        await documents.submit(ctx.orgA.id, documentId)
        expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
      } finally {
        emitter.off(Events.FISCAL_DOCUMENT_REJECTED, listener)
      }
    })

    it('rejects a document whose receiver lacks what its type needs', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: null })
      await documents.submit(ctx.orgA.id, documentId)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(row.rejectionReason).toBe(FiscalRejectionReasons.RECEIVER_INCOMPLETE)
    })

    it('keeps the document queued while the authority is down and accepts it on a later attempt', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: `${SimulatorRules.UNAVAILABLE}-1`, name: 'Ana' })
      await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/did not answer/)
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.QUEUED)
      await documents.submit(ctx.orgA.id, documentId)
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('asks before it sends again when an answer was lost: one document, not two', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: SimulatorRules.LOST, name: 'Ana' })
      await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/did not answer/)
      await documents.submit(ctx.orgA.id, documentId)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.ACCEPTED)
      // The key of the submission: the organization, the document and the submission it belongs to
      expect(row.externalNumber).toBe(`SIM-${ctx.orgA.id}:${documentId}:1`)
    })

    it('makes a corrected document a new submission, with a new key and a new job, after the authority refused it', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: SimulatorRules.REJECT, name: 'Ana' })
      await documents.submit(ctx.orgA.id, documentId)
      const refused = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect([refused.submission, refused.attempts]).toEqual([2, 0])
      await patchReceiver(documentId, { taxId: null })
      expect((await asAdminA().post(ApiRoutes.fiscal.documents.retry(documentId))).status).toBe(OK)
      expect(jobs().some(job => job.opts?.jobId === submitFiscalDocumentJobId(documentId, 2))).toBe(
        true
      )
      await documents.submit(ctx.orgA.id, documentId)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(row.externalNumber).toBe(`SIM-${ctx.orgA.id}:${documentId}:2`)
    })

    it('keeps the key when core refused the document before the provider was reached', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: null })
      await documents.submit(ctx.orgA.id, documentId)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.submission).toBe(1)
    })

    it('refuses to build a sale whose parts do not add up to its total: the provider never sees it', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      await owner.fiscalDocument.update({
        where: { id: documentId },
        data: { linesSnapshot: { ...(row.linesSnapshot as object), discountCents: 1 } }
      })
      await documents.submit(ctx.orgA.id, documentId)
      const after = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(after.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(after.rejectionReason).toBe(FiscalRejectionReasons.SALE_INCONSISTENT)
      expect(after.builtPayloadEncrypted).toBeNull()
    })

    it('treats a provider that throws before it returns a promise as one that did not answer', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      const spy = jest.spyOn(provider, 'submit').mockImplementation(() => {
        throw new Error('boom with 12345-6')
      })
      try {
        await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/did not answer/)
      } finally {
        spy.mockRestore()
      }
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.QUEUED)
    })

    it('cuts the reason of a provider and keeps no more of its response than the limit', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      const spy = jest.spyOn(provider, 'submit').mockResolvedValue({
        outcome: 'rejected' as never,
        reason: 'x'.repeat(FiscalLimits.REASON_MAX_LENGTH * 3),
        response: { body: 'y'.repeat(FiscalLimits.RESPONSE_MAX_CHARS * 2) }
      })
      try {
        await documents.submit(ctx.orgA.id, documentId)
      } finally {
        spy.mockRestore()
      }
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.rejectionReason).toHaveLength(FiscalLimits.REASON_MAX_LENGTH)
      expect(row.response).toEqual({ truncated: true })
    })

    it('answers that the provider did not answer when the invalidation throws', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const spy = jest.spyOn(provider, 'void').mockImplementation(() => {
        throw new Error('boom')
      })
      try {
        const answer = await asAdminA()
          .post(ApiRoutes.fiscal.documents.void(documentId))
          .send({ reason: 'wrong customer' })
        expect(answer.status).toBe(CONFLICT)
        expect((answer.body as { error: { code: string } }).error.code).toBe(
          ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE
        )
      } finally {
        spy.mockRestore()
      }
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('refuses to use an issuer that changed after the document was made, and remakes it on a retry', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      await owner.fiscalIssuer.update({
        where: { organizationId: ctx.orgA.id },
        data: { environment: FiscalEnvironment.PRODUCTION }
      })
      try {
        await documents.submit(ctx.orgA.id, documentId)
        const refused = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
        expect(refused.status).toBe(FiscalDocumentStatus.REJECTED)
        expect(refused.rejectionReason).toBe(FiscalRejectionReasons.ISSUER_CHANGED)
        expect(refused.environment).toBe(FiscalEnvironment.SANDBOX)
        // The retry makes it again with the issuer as it is now
        expect((await asAdminA().post(ApiRoutes.fiscal.documents.retry(documentId))).status).toBe(
          OK
        )
        const remade = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
        expect(remade.environment).toBe(FiscalEnvironment.PRODUCTION)
        await documents.submit(ctx.orgA.id, documentId)
        expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
      } finally {
        await owner.fiscalIssuer.update({
          where: { organizationId: ctx.orgA.id },
          data: { environment: FiscalEnvironment.SANDBOX }
        })
      }
    })

    it('does not invalidate with an issuer that is not the one that accepted the document', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      await owner.fiscalIssuer.update({
        where: { organizationId: ctx.orgA.id },
        data: { environment: FiscalEnvironment.PRODUCTION }
      })
      try {
        const answer = await asAdminA()
          .post(ApiRoutes.fiscal.documents.void(documentId))
          .send({ reason: 'wrong customer' })
        expect(answer.status).toBe(CONFLICT)
        expect((answer.body as { error: { code: string } }).error.code).toBe(
          ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE
        )
      } finally {
        await owner.fiscalIssuer.update({
          where: { organizationId: ctx.orgA.id },
          data: { environment: FiscalEnvironment.SANDBOX }
        })
      }
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('waits for an attempt that is alive and takes over one whose worker died', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      await owner.fiscalDocument.update({
        where: { id: documentId },
        data: { status: FiscalDocumentStatus.SUBMITTED, attempts: 1 }
      })
      await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/another attempt/)
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.SUBMITTED)
      await owner.fiscalDocument.update({
        where: { id: documentId },
        data: { updatedAt: new Date(Date.now() - FiscalLimits.CLAIM_LEASE_MS - 1000) }
      })
      await documents.submit(ctx.orgA.id, documentId)
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('puts the document back in the queue when the consultation of a lost answer gets no answer', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: SimulatorRules.LOST, name: 'Ana' })
      await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/did not answer/)
      const submit = jest.spyOn(provider, 'submit')
      const spy = jest.spyOn(provider, 'consult').mockImplementation(() => {
        throw new Error('timeout')
      })
      try {
        await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/consultation/)
        // Not "never received": nothing was sent again
        expect(submit).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
        submit.mockRestore()
      }
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.QUEUED)
    })

    it('keeps the acceptance of the authority even when part of what the provider returned cannot be stored', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      const cycle: Record<string, unknown> = {}
      cycle['self'] = cycle
      const spy = jest.spyOn(provider, 'submit').mockResolvedValue({
        outcome: 'accepted' as never,
        externalNumber: 'EXT-1',
        providerData: cycle,
        response: { note: 'has a nul \u0000 inside' }
      })
      try {
        await documents.submit(ctx.orgA.id, documentId)
      } finally {
        spy.mockRestore()
      }
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(row.externalNumber).toBe('EXT-1')
      expect(row.providerData).toEqual({ unreadable: true })
      expect(row.response).toEqual({ note: 'has a nul  inside' })
    })

    it('voids an accepted document with a reason, audited, and never twice', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const noReason = await asAdminA().post(ApiRoutes.fiscal.documents.void(documentId)).send({})
      expect(noReason.status).toBe(BAD_REQUEST)
      const voided = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(documentId))
        .send({ reason: 'wrong customer' })
      expect(voided.status).toBe(OK)
      expect((voided.body as { data: { status: string } }).data.status).toBe(
        FiscalDocumentStatus.VOIDED
      )
      const again = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(documentId))
        .send({ reason: 'again' })
      expect(again.status).toBe(CONFLICT)
      await waitForAuditEntries(owner, {
        action: AuditAction.FISCAL_DOCUMENT_VOIDED,
        userId: ctx.adminA.id
      })
      const queued = await sale()
      const early = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(queued.documentId))
        .send({ reason: 'not accepted yet' })
      expect(early.status).toBe(CONFLICT)
    })
  })

  describe('reading and permissions', () => {
    it('lists the documents of the organization with the receiver minimized', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '0614-010101-101-1', name: 'Ana' })
      const list = await asAdminA().get(ApiRoutes.fiscal.documents.list)
      expect(list.status).toBe(OK)
      expect(JSON.stringify(list.body)).not.toContain('0614-010101-101-1')
      const one = await asAdminA().get(ApiRoutes.fiscal.documents.byId(documentId))
      expect(
        (one.body as { data: { receiver: { taxIdMasked: string } } }).data.receiver.taxIdMasked
      ).toBe(`${'*'.repeat(13)}01-1`)
    })

    it('refuses a cursor that is not a correlative', async () => {
      const answer = await asAdminA().get(`${ApiRoutes.fiscal.documents.list}?cursor=9999999999`)
      expect(answer.status).toBe(BAD_REQUEST)
    })

    it('asks FISCAL_VIEW to read and FISCAL_MANAGE to write', async () => {
      const reader = await actorWithPermissions(owner, app, {
        prefix,
        name: 'fiscal-reader',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.FISCAL_VIEW]
      })
      const asReader = api(app, reader, ctx.storeA)
      expect((await asReader.get(ApiRoutes.fiscal.documents.list)).status).toBe(OK)
      expect((await asReader.put(ApiRoutes.fiscal.issuer).send(ISSUER)).status).toBe(FORBIDDEN)
      const { documentId } = await sale()
      expect((await asReader.post(ApiRoutes.fiscal.documents.retry(documentId))).status).toBe(
        FORBIDDEN
      )
      // A member with neither reads nothing
      expect(
        (await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.fiscal.documents.list)).status
      ).toBe(FORBIDDEN)
    })

    it('does not show a document of another organization, and answers 404 to its id', async () => {
      const { documentId } = await sale()
      const other = api(app, ctx.adminB, ctx.storeB)
      expect((await other.get(ApiRoutes.fiscal.documents.byId(documentId))).status).toBe(NOT_FOUND)
      expect((await other.post(ApiRoutes.fiscal.documents.retry(documentId))).status).toBe(
        NOT_FOUND
      )
      const list = await other.get(ApiRoutes.fiscal.documents.list)
      expect((list.body as { data: unknown[] }).data).toEqual([])
    })
  })
})
