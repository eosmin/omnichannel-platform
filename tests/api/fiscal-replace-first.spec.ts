import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { DatabaseNull } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalConflictReasons,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalVoidKind,
  OrderStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { FISCAL_PROVIDERS, FiscalDocumentsService } from '@platform/fiscal/runtime'
import type { FiscalDocumentProvider } from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CONFLICT = 409
const NOT_FOUND = 404
const ASKS_PROVIDER_ID = 'replace-first-test'
const SECRET = 'not-a-real-signing-key-1234567890'

// The simulator with a manifest that says its authority asks for the replacement before an invalidation (what a real provider declares):
// its methods stay on the prototype
function asksProvider(): FiscalDocumentProvider {
  const base = simulatorProvider()
  return Object.create(base, {
    id: { value: ASKS_PROVIDER_ID, enumerable: true },
    manifest: {
      enumerable: true,
      value: {
        ...base.manifest,
        voidInputs: {
          kinds: [FiscalVoidKind.CORRECTION, FiscalVoidKind.RESCISSION],
          requiresParties: false,
          kindsWithReplacement: [FiscalVoidKind.CORRECTION]
        }
      }
    }
  }) as FiscalDocumentProvider
}

describe('The replacement made before the invalidation (Step 4B.7c-5b)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(FISCAL_PROVIDERS).useValue([simulatorProvider(), asksProvider()])
    )
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
  const putIssuer = (providerId: string) =>
    asAdminA()
      .put(ApiRoutes.fiscal.issuer)
      .send({
        providerId,
        legalName: 'Replace Issuer',
        taxId: 'ISSUER-TAX-ID',
        address: { line1: 'Calle 1', city: 'Ciudad' },
        environment: FiscalEnvironment.SANDBOX,
        issueOn: FiscalIssueOn.DELIVERED,
        credentials: { signingKey: SECRET }
      })

  // A delivered order of organization A: its sale document is made by the event
  async function sale(): Promise<{ orderId: string; documentId: string }> {
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
      where: { orderId: order.id, organizationId: ctx.orgA.id },
      select: { id: true }
    })
    return { orderId: order.id, documentId: document.id }
  }
  const accepted = async () => {
    const made = await sale()
    await documents.submit(ctx.orgA.id, made.documentId)
    return made
  }
  const row = (id: string) => owner.fiscalDocument.findUniqueOrThrow({ where: { id } })
  const replaceOf = (id: string) => asAdminA().post(ApiRoutes.fiscal.documents.replace(id))
  const reasonOf = (answer: { body: unknown }): string | undefined =>
    (answer.body as { error?: { metadata?: { reason?: string } } }).error?.metadata?.reason

  describe('when the provider asks for the replacement before an invalidation', () => {
    beforeAll(async () => {
      expect((await putIssuer(ASKS_PROVIDER_ID)).status).toBe(OK)
    })

    it('makes the replacement of an accepted sale document, with the original left accepted beside it', async () => {
      const original = await accepted()
      const answer = await replaceOf(original.documentId)
      expect(answer.status).toBe(OK)
      const view = (answer.body as { data: { id: string; status: string } }).data
      expect(view.status).toBe(FiscalDocumentStatus.QUEUED)
      const fresh = await row(view.id)
      const old = await row(original.documentId)
      expect(fresh.replacesDocumentId).toBe(original.documentId)
      expect(fresh.orderId).toBe(old.orderId)
      expect(fresh.kind).toBe(FiscalDocumentKind.SALE)
      expect(fresh.sequenceNumber).toBeGreaterThan(old.sequenceNumber)
      expect(Buffer.from(fresh.receiverEncrypted).equals(Buffer.from(old.receiverEncrypted))).toBe(
        true
      )
      // The sale entry of the order is the same one: the books do not post it twice
      expect(fresh.journalEntryId).toBe(old.journalEntryId)
      // The original is untouched until it is invalidated
      expect(old.status).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('says the document was already replaced the second time, and from two requests at once', async () => {
      const original = await accepted()
      expect((await replaceOf(original.documentId)).status).toBe(OK)
      const again = await replaceOf(original.documentId)
      expect(again.status).toBe(CONFLICT)
      expect(reasonOf(again)).toBe(FiscalConflictReasons.ALREADY_REPLACED)
      const other = await accepted()
      const both = await Promise.all([replaceOf(other.documentId), replaceOf(other.documentId)])
      expect(both.map(answer => answer.status).sort()).toEqual([OK, CONFLICT])
      expect(
        await owner.fiscalDocument.count({ where: { replacesDocumentId: other.documentId } })
      ).toBe(1)
    })

    it('refuses a document that the authority does not have yet', async () => {
      const queued = await sale()
      const answer = await replaceOf(queued.documentId)
      expect(answer.status).toBe(CONFLICT)
      expect((answer.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION
      )
      expect(await owner.fiscalDocument.count({ where: { orderId: queued.orderId } })).toBe(1)
    })

    it('refuses while the document has a credit note the authority may have, as a void does', async () => {
      const original = await accepted()
      const mine = await row(original.documentId)
      // A credit note of the same order that was accepted: a copy of the document made so (an accepted document is immutable)
      await owner.fiscalDocument.create({
        data: {
          ...mine,
          id: randomUUID(),
          kind: FiscalDocumentKind.CREDIT_NOTE,
          parentDocumentId: mine.id,
          sequenceNumber: 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000),
          correlative: null,
          correlativeScopeKey: null,
          issuerSnapshot: mine.issuerSnapshot as object,
          providerData: mine.providerData ?? DatabaseNull,
          response: mine.response ?? DatabaseNull,
          voidResponse: DatabaseNull,
          linesSnapshot: mine.linesSnapshot as object
        }
      })
      const answer = await replaceOf(original.documentId)
      expect(answer.status).toBe(CONFLICT)
      expect(reasonOf(answer)).toBe(FiscalConflictReasons.HAS_CREDIT_NOTES)
    })

    it('refuses when the issuer changed since the document was made', async () => {
      const original = await accepted()
      await owner.fiscalIssuer.update({
        where: { organizationId: ctx.orgA.id },
        data: { legalName: 'Another legal name' }
      })
      try {
        const answer = await replaceOf(original.documentId)
        expect(answer.status).toBe(CONFLICT)
        expect((answer.body as { error: { code: string } }).error.code).toBe(
          ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE
        )
      } finally {
        await owner.fiscalIssuer.update({
          where: { organizationId: ctx.orgA.id },
          data: { legalName: 'Replace Issuer' }
        })
      }
    })

    it('lets the original be invalidated naming the replacement once it is accepted, and the replacement stays the live document', async () => {
      const original = await accepted()
      const made = ((await replaceOf(original.documentId)).body as { data: { id: string } }).data.id
      await documents.submit(ctx.orgA.id, made)
      const voided = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(original.documentId))
        .send({
          reason: 'wrong receiver',
          kind: FiscalVoidKind.CORRECTION,
          replacementDocumentId: made
        })
      expect(voided.status).toBe(OK)
      expect((await row(original.documentId)).status).toBe(FiscalDocumentStatus.VOIDED)
      expect((await row(made)).status).toBe(FiscalDocumentStatus.ACCEPTED)
      // The replacement of a voided document is not made a second time, and the replaced one is replaced once
      const again = await replaceOf(original.documentId)
      expect(again.status).toBe(CONFLICT)
      expect(reasonOf(again)).toBe(FiscalConflictReasons.ALREADY_REPLACED)
    })

    it('keeps one live sale document per order among the documents that replace nothing', async () => {
      const original = await accepted()
      const mine = await row(original.documentId)
      // A second sale document of the order that replaces nothing is refused by the database; one that replaces the first is not
      const copy = (over: Record<string, unknown>) =>
        owner.fiscalDocument.create({
          data: {
            ...mine,
            id: randomUUID(),
            sequenceNumber: 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000),
            correlative: null,
            correlativeScopeKey: null,
            issuerSnapshot: mine.issuerSnapshot as object,
            providerData: mine.providerData ?? DatabaseNull,
            response: mine.response ?? DatabaseNull,
            voidResponse: DatabaseNull,
            linesSnapshot: mine.linesSnapshot as object,
            ...over
          }
        })
      await expect(copy({})).rejects.toThrow()
      await expect(copy({ replacesDocumentId: mine.id })).resolves.toBeDefined()
      // And it is replaced once: a second one that names the same document is refused
      await expect(copy({ replacesDocumentId: mine.id })).rejects.toThrow()
    })

    it('names no document with a credit note while the original and its replacement are both alive', async () => {
      const original = await accepted()
      expect((await replaceOf(original.documentId)).status).toBe(OK)
      // The order comes back as a whole in that window: a note would name one of two documents, so none is made
      await owner.order.update({
        where: { id: original.orderId },
        data: { status: OrderStatus.RETURNED }
      })
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
        storeId: ctx.storeA.id,
        orderId: original.orderId,
        orderNumber: 'N',
        actor: { type: 'system', id: null },
        from: OrderStatus.DELIVERED,
        to: OrderStatus.RETURNED,
        notifyCustomer: false
      })
      expect(
        await owner.fiscalDocument.count({
          where: { orderId: original.orderId, kind: FiscalDocumentKind.CREDIT_NOTE }
        })
      ).toBe(0)
    })

    it('does not make the replacement of a document of another organization', async () => {
      const original = await accepted()
      const other = await api(app, ctx.adminB, ctx.storeB).post(
        ApiRoutes.fiscal.documents.replace(original.documentId)
      )
      expect(other.status).toBe(NOT_FOUND)
      expect(
        await owner.fiscalDocument.count({ where: { replacesDocumentId: original.documentId } })
      ).toBe(0)
    })
  })

  describe('when the provider asks for nothing before an invalidation', () => {
    beforeAll(async () => {
      expect((await putIssuer(simulatorProvider().id)).status).toBe(OK)
    })

    it('leaves the replacement for after the invalidation, with a reason a person can read', async () => {
      const original = await accepted()
      const answer = await replaceOf(original.documentId)
      expect(answer.status).toBe(CONFLICT)
      expect(reasonOf(answer)).toBe(FiscalConflictReasons.REPLACE_FIRST_UNAVAILABLE)
      expect(
        await owner.fiscalDocument.count({ where: { replacesDocumentId: original.documentId } })
      ).toBe(0)
    })
  })
})
