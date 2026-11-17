import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { CredentialCipher } from '@platform/core/crypto'
import { DatabaseNull } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalConflictReasons,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalLimits,
  FiscalRejectionReasons,
  FiscalVoidKind,
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
  async function deliveredOrder(
    overrides: { shippingCents?: number; totalCents?: number; taxCents?: number } = {}
  ): Promise<{ id: string; storeId: string; orderNumber: string }> {
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
        deliveredAt: new Date(),
        ...overrides
      },
      select: { id: true, storeId: true, orderNumber: true }
    })
    return order
  }

  // The sale is delivered: the listener makes the document and queues its submission
  async function sale(
    overrides: { shippingCents?: number; totalCents?: number; taxCents?: number } = {}
  ): Promise<{ orderId: string; documentId: string }> {
    const order = await deliveredOrder(overrides)
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

    it('keeps the moment of issue when a change of the issuer does not name it, and starts at delivered', async () => {
      await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, issueOn: FiscalIssueOn.SHIPPED })
      const withoutIssueOn: Record<string, unknown> = { ...ISSUER }
      delete withoutIssueOn['issueOn']
      const again = await asAdminA().put(ApiRoutes.fiscal.issuer).send(withoutIssueOn)
      expect(again.status).toBe(OK)
      expect((again.body as { data: { issueOn: string } }).data.issueOn).toBe(FiscalIssueOn.SHIPPED)
      // Said again, it changes; a new issuer that never said it starts at delivered
      const back = await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)
      expect((back.body as { data: { issueOn: string } }).data.issueOn).toBe(
        FiscalIssueOn.DELIVERED
      )
      await owner.fiscalIssuer.deleteMany({ where: { organizationId: ctx.orgB.id } })
      try {
        const first = await api(app, ctx.adminB, ctx.storeB)
          .put(ApiRoutes.fiscal.issuer)
          .send(withoutIssueOn)
        expect((first.body as { data: { issueOn: string } }).data.issueOn).toBe(
          FiscalIssueOn.DELIVERED
        )
      } finally {
        await owner.fiscalIssuer.deleteMany({ where: { organizationId: ctx.orgB.id } })
      }
    })

    it('keeps the registration, the activity and the establishment code when a change does not name them, and clears them with null', async () => {
      const codes = { registrationId: 'NRC-1', activityCode: '4711', establishmentCode: 'M001' }
      const set = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, ...codes })
      expect(set.status).toBe(OK)
      const read = async (): Promise<Record<string, unknown>> =>
        ((await asAdminA().get(ApiRoutes.fiscal.issuer)).body as { data: Record<string, unknown> })
          .data
      expect(await read()).toMatchObject(codes)
      // A change that names none of them leaves all three
      const without = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, legalName: 'Isolation Issuer 2' })
      expect(without.status).toBe(OK)
      expect(await read()).toMatchObject({ ...codes, legalName: 'Isolation Issuer 2' })
      // Null clears one and leaves the others
      const cleared = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, activityCode: null })
      expect(cleared.status).toBe(OK)
      expect(await read()).toMatchObject({
        registrationId: 'NRC-1',
        activityCode: null,
        establishmentCode: 'M001'
      })
      await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)

      // A first issuer that does not name them has none
      await owner.fiscalIssuer.deleteMany({ where: { organizationId: ctx.orgB.id } })
      try {
        const first = await api(app, ctx.adminB, ctx.storeB)
          .put(ApiRoutes.fiscal.issuer)
          .send(ISSUER)
        expect(first.status).toBe(OK)
        expect(first.body).toMatchObject({
          data: { registrationId: null, activityCode: null, establishmentCode: null }
        })
      } finally {
        await owner.fiscalIssuer.deleteMany({ where: { organizationId: ctx.orgB.id } })
      }
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

    it('asks for new credentials when the environment or the provider changes: a sandbox key is never kept as the key of production', async () => {
      expect((await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)).status).toBe(OK)
      // Sent with no credentials (undefined is left out of the JSON)
      const withoutCredentials = { ...ISSUER, credentials: undefined }
      const changed = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...withoutCredentials, environment: FiscalEnvironment.PRODUCTION })
      expect(changed.status).toBe(BAD_REQUEST)
      expect((changed.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FISCAL_ISSUER_INVALID
      )
      // The same environment and provider keep the stored credentials
      expect((await asAdminA().put(ApiRoutes.fiscal.issuer).send(withoutCredentials)).status).toBe(
        OK
      )
    })

    it('does not wipe the stored credentials when they are sent empty', async () => {
      expect((await asAdminA().put(ApiRoutes.fiscal.issuer).send(ISSUER)).status).toBe(OK)
      const empty = await asAdminA()
        .put(ApiRoutes.fiscal.issuer)
        .send({ ...ISSUER, credentials: {} })
      expect(empty.status).toBe(OK)
      expect((empty.body as { data: { credentialsSet: boolean } }).data.credentialsSet).toBe(true)
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

  describe('the detail and the period of a document (Step 4B.7b-4)', () => {
    it('reads the lines, the tax by rate and the issuer as they were sealed, and nothing else', async () => {
      const { documentId } = await sale()
      // The issuer changes after the document was made: the detail still shows the one it was made with
      await owner.fiscalDocument.update({
        where: { id: documentId },
        data: {
          issuerSnapshot: {
            legalName: 'Sealed Issuer',
            taxId: 'SEALED-TAX-ID',
            address: { line1: 'Calle 9', city: 'Ciudad', nested: { x: 1 } },
            environment: 'sandbox',
            credentials: { signingKey: SECRET }
          },
          linesSnapshot: {
            lines: [
              {
                description: 'Widget',
                quantity: 2,
                unitPriceCents: 1130,
                taxRateBps: 1300,
                taxCents: 260,
                totalCents: 2260,
                providerData: 'raw'
              }
            ],
            shippingCents: 565,
            shippingTaxCents: 65,
            discountCents: 0,
            pricesIncludeTax: true,
            orderNumber: 'ORD-DETAIL'
          }
        }
      })
      const got = await asAdminA().get(ApiRoutes.fiscal.documents.byId(documentId))
      expect(got.status).toBe(OK)
      expect((got.body as { data: { detail: unknown } }).data.detail).toEqual({
        orderNumber: 'ORD-DETAIL',
        pricesIncludeTax: true,
        lines: [
          {
            description: 'Widget',
            quantity: 2,
            unitPriceCents: 1130,
            taxRateBps: 1300,
            taxCents: 260,
            totalCents: 2260
          }
        ],
        shippingCents: 565,
        shippingTaxCents: 65,
        discountCents: 0,
        taxBreakdown: [{ taxRateBps: 1300, baseCents: 2000, taxCents: 260 }],
        consistent: true,
        issuer: {
          legalName: 'Sealed Issuer',
          taxId: 'SEALED-TAX-ID',
          registrationId: null,
          address: { line1: 'Calle 9', city: 'Ciudad' },
          activityCode: null,
          establishmentCode: null,
          environment: 'sandbox'
        }
      })
      // No credential and no raw field anywhere in the answer
      const text = JSON.stringify(got.body)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('providerData')
      expect(text).not.toContain('receiverEncrypted')
    })

    it('does not show the detail of another organization: it is a not found', async () => {
      const { documentId } = await sale()
      const other = await api(app, ctx.adminB, ctx.storeB).get(
        ApiRoutes.fiscal.documents.byId(documentId)
      )
      expect(other.status).toBe(NOT_FOUND)
    })

    it('answers the list light, without the detail', async () => {
      const { documentId } = await sale()
      const list = await asAdminA().get(ApiRoutes.fiscal.documents.list)
      const rows = (list.body as { data: { id: string }[] }).data
      const found = rows.find(row => row.id === documentId)
      expect(found).toBeDefined()
      expect(found).not.toHaveProperty('detail')
    })

    it('filters the list by the period of creation, both ends included, and refuses a bad range', async () => {
      const early = await sale()
      const late = await sale()
      const instants = {
        early: new Date('2020-03-10T12:00:00.000Z'),
        late: new Date('2020-05-10T12:00:00.000Z')
      }
      await owner.fiscalDocument.update({
        where: { id: early.documentId },
        data: { createdAt: instants.early }
      })
      await owner.fiscalDocument.update({
        where: { id: late.documentId },
        data: { createdAt: instants.late }
      })
      const ids = async (query: string): Promise<string[]> => {
        const answer = await asAdminA().get(`${ApiRoutes.fiscal.documents.list}?${query}`)
        expect(answer.status).toBe(OK)
        return (answer.body as { data: { id: string }[] }).data.map(row => row.id)
      }
      const march = await ids('from=2020-03-01T00:00:00.000Z&to=2020-03-31T23:59:59.999Z')
      expect(march).toEqual([early.documentId])
      const exact = await ids(
        `from=${instants.early.toISOString()}&to=${instants.late.toISOString()}`
      )
      expect(exact).toEqual(expect.arrayContaining([early.documentId, late.documentId]))
      const onlyTo = await ids('to=2020-04-01T00:00:00.000Z')
      expect(onlyTo).toContain(early.documentId)
      expect(onlyTo).not.toContain(late.documentId)
      const onlyFrom = await ids('from=2020-04-01T00:00:00.000Z')
      expect(onlyFrom).toContain(late.documentId)
      expect(onlyFrom).not.toContain(early.documentId)

      for (const bad of [
        'from=2020-05-01T00:00:00.000Z&to=2020-04-01T00:00:00.000Z',
        'from=yesterday',
        'to=2020-13-45T00:00:00.000Z'
      ]) {
        const refused = await asAdminA().get(`${ApiRoutes.fiscal.documents.list}?${bad}`)
        expect(refused.status).toBe(BAD_REQUEST)
      }
    })

    it('keeps the period inside the organization: another one sees none of these documents', async () => {
      const { documentId } = await sale()
      const answer = await api(app, ctx.adminB, ctx.storeB).get(
        `${ApiRoutes.fiscal.documents.list}?from=2000-01-01T00:00:00.000Z`
      )
      expect(answer.status).toBe(OK)
      expect((answer.body as { data: { id: string }[] }).data.map(row => row.id)).not.toContain(
        documentId
      )
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

    describe('a change of the receiver that carries some fields', () => {
      const FULL = {
        name: 'Ana Pérez',
        taxId: '0614-010101-101-1',
        registrationId: '123456-7',
        email: 'ana@example.com',
        phone: '70000000',
        address: { line1: 'Calle 1', city: 'San Salvador' }
      }
      const storedReceiver = async (documentId: string): Promise<Record<string, unknown>> => {
        const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
        return app.get(CredentialCipher).open(row.receiverEncrypted)
      }

      const changes: Array<[string, Record<string, unknown>]> = [
        ['name', { name: 'Ana María' }],
        ['tax id', { taxId: '0614-020202-202-2' }],
        ['registration id', { registrationId: '765432-1' }],
        ['email', { email: 'otra@example.com' }],
        ['phone', { phone: '71111111' }],
        ['address', { address: { line1: 'Calle 2', city: 'Santa Ana' } }]
      ]

      it.each(changes)('keeps every field it does not carry: the %s', async (_label, change) => {
        const { documentId } = await sale()
        expect((await patchReceiver(documentId, FULL)).status).toBe(OK)
        expect((await patchReceiver(documentId, change)).status).toBe(OK)
        const kept = await storedReceiver(documentId)
        expect(kept).toMatchObject({ ...FULL, ...change })
      })

      it('refuses with its reason, and drops nothing, when the stored receiver cannot be read and the change is partial', async () => {
        const { documentId } = await sale()
        expect((await patchReceiver(documentId, FULL)).status).toBe(OK)
        const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
        const damaged = Buffer.from(row.receiverEncrypted)
        damaged.writeUInt8(damaged.readUInt8(damaged.length - 1) ^ 0xff, damaged.length - 1)
        await owner.fiscalDocument.update({
          where: { id: documentId },
          data: { receiverEncrypted: new Uint8Array(damaged) }
        })
        const refused = await patchReceiver(documentId, { name: 'Solo Nombre' })
        expect(refused.status).toBe(409)
        expect(
          (refused.body as { error: { metadata?: { reason?: string } } }).error.metadata?.reason
        ).toBe(FiscalConflictReasons.RECEIVER_UNREADABLE)
        const after = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
        expect(Buffer.from(after.receiverEncrypted).equals(damaged)).toBe(true)
        // Writing the whole receiver again repairs it
        const repaired = await patchReceiver(documentId, FULL)
        expect(repaired.status).toBe(OK)
        expect(await storedReceiver(documentId)).toMatchObject(FULL)
      })
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

    it('refuses a sale whose tax is more than its lines and its shipping can carry, as the entry of the sale does', async () => {
      // No shipping and $0.50 of tax more than the lines carry: the difference is not the tax of a shipping fee that is not there
      const { documentId } = await sale({ shippingCents: 0, totalCents: 2260, taxCents: 310 })
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
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
        // Nothing was sent: the claim of the attempt is given back
        expect(refused.attempts).toBe(0)
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

    it('refuses to sign in the name of an issuer whose identity changed after the document was made', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      await owner.fiscalIssuer.update({
        where: { organizationId: ctx.orgA.id },
        data: { taxId: 'ANOTHER-TAX-ID' }
      })
      try {
        await documents.submit(ctx.orgA.id, documentId)
        const refused = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
        expect(refused.status).toBe(FiscalDocumentStatus.REJECTED)
        expect(refused.rejectionReason).toBe(FiscalRejectionReasons.ISSUER_CHANGED)
        expect(refused.builtPayloadEncrypted).toBeNull()
      } finally {
        await owner.fiscalIssuer.update({
          where: { organizationId: ctx.orgA.id },
          data: { taxId: ISSUER.taxId }
        })
      }
    })

    it('builds every attempt with the time the document was made, and keeps that time as its issue date', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: SimulatorRules.LOST, name: 'Ana' })
      await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/did not answer/)
      await documents.submit(ctx.orgA.id, documentId)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(row.issuedAt?.toISOString()).toBe(row.createdAt.toISOString())
    })

    it('keeps what the authority answered to the invalidation as its own evidence', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const voided = await asAdminA()
        .post(ApiRoutes.fiscal.documents.void(documentId))
        .send({ reason: 'wrong customer' })
      expect(voided.status).toBe(OK)
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect(row.voidResponse).toEqual({ voided: true })
      // The response to the acceptance is the one that was kept when it was accepted
      expect(row.response).toEqual({ accepted: true })
    })

    it('stores a reason and an external number the database would refuse, cleaned, and a blank reason as a code', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const first = await sale()
      await patchReceiver(first.documentId, { taxId: '12345-6', name: 'Ana' })
      const reject = jest
        .spyOn(provider, 'submit')
        .mockResolvedValue({ outcome: 'rejected' as never, reason: 'bad\u0000id' })
      try {
        await documents.submit(ctx.orgA.id, first.documentId)
      } finally {
        reject.mockRestore()
      }
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: first.documentId } }))
          .rejectionReason
      ).toBe('badid')

      const second = await sale()
      await patchReceiver(second.documentId, { taxId: '12345-6', name: 'Ana' })
      const blank = jest
        .spyOn(provider, 'submit')
        .mockResolvedValue({ outcome: 'rejected' as never, reason: '  ' })
      try {
        await documents.submit(ctx.orgA.id, second.documentId)
      } finally {
        blank.mockRestore()
      }
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: second.documentId } }))
          .rejectionReason
      ).toBe(FiscalRejectionReasons.PROVIDER_UNAVAILABLE)

      const third = await sale()
      await patchReceiver(third.documentId, { taxId: '12345-6', name: 'Ana' })
      const accept = jest.spyOn(provider, 'submit').mockResolvedValue({
        outcome: 'accepted' as never,
        externalNumber: 'EXT\u0000-9',
        providerData: { ['k\u0000ey']: 'v' }
      })
      try {
        await documents.submit(ctx.orgA.id, third.documentId)
      } finally {
        accept.mockRestore()
      }
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: third.documentId } })
      expect([row.status, row.externalNumber, row.providerData]).toEqual([
        FiscalDocumentStatus.ACCEPTED,
        'EXT-9',
        { key: 'v' }
      ])
    })

    it('does not keep as an acceptance an answer with no number', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      const spy = jest.spyOn(provider, 'submit').mockResolvedValue({ outcome: 'accepted' as never })
      try {
        await documents.submit(ctx.orgA.id, documentId)
      } finally {
        spy.mockRestore()
      }
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      expect([row.status, row.rejectionReason, row.externalNumber]).toEqual([
        FiscalDocumentStatus.REJECTED,
        FiscalRejectionReasons.PROVIDER_ANSWER_INVALID,
        null
      ])
    })

    it('reads the sale again from the order when a retry follows a sale that did not add up', async () => {
      const { documentId, orderId } = await sale()
      await patchReceiver(documentId, { taxId: '12345-6', name: 'Ana' })
      const row = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      // A snapshot that is wrong: the order is right
      await owner.fiscalDocument.update({
        where: { id: documentId },
        data: { linesSnapshot: { ...(row.linesSnapshot as object), discountCents: 1 } }
      })
      await documents.submit(ctx.orgA.id, documentId)
      expect(
        (await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } }))
          .rejectionReason
      ).toBe(FiscalRejectionReasons.SALE_INCONSISTENT)
      expect((await asAdminA().post(ApiRoutes.fiscal.documents.retry(documentId))).status).toBe(OK)
      await documents.submit(ctx.orgA.id, documentId)
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(orderId).toBeDefined()
    })

    it('does not move a document that may be at the authority to another issuer', async () => {
      const { documentId } = await sale()
      await patchReceiver(documentId, { taxId: SimulatorRules.LOST, name: 'Ana' })
      await expect(documents.submit(ctx.orgA.id, documentId)).rejects.toThrow(/did not answer/)
      await owner.fiscalIssuer.update({
        where: { organizationId: ctx.orgA.id },
        data: { taxId: 'ANOTHER-TAX-ID' }
      })
      try {
        await documents.submit(ctx.orgA.id, documentId)
        expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.REJECTED)
        const retry = await asAdminA().post(ApiRoutes.fiscal.documents.retry(documentId))
        expect(retry.status).toBe(CONFLICT)
        expect((retry.body as { error: { code: string } }).error.code).toBe(
          ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE
        )
      } finally {
        await owner.fiscalIssuer.update({
          where: { organizationId: ctx.orgA.id },
          data: { taxId: ISSUER.taxId }
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

    it('flags a document that is stuck, says what a person may do with it, and counts what needs a person over the whole organization', async () => {
      type Page = { attention: { rejected: number; stuck: number } }
      type One = { data: { stuck: boolean; allowedActions: { retry: boolean; void: boolean } } }
      const attentionOf = async (who = asAdminA()): Promise<Page['attention']> =>
        ((await who.get(`${ApiRoutes.fiscal.documents.list}?limit=1`)).body as Page).attention
      const before = await attentionOf()
      const otherBefore = await attentionOf(api(app, ctx.adminB, ctx.storeB))

      const stuck = await sale()
      const retrying = await sale()
      const refused = await sale()
      const ids = [stuck.documentId, retrying.documentId, refused.documentId]
      const originals = await owner.fiscalDocument.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, attempts: true }
      })
      try {
        await owner.fiscalDocument.update({
          where: { id: stuck.documentId },
          data: { status: FiscalDocumentStatus.QUEUED, attempts: FiscalLimits.MAX_ATTEMPTS }
        })
        await owner.fiscalDocument.update({
          where: { id: retrying.documentId },
          data: { status: FiscalDocumentStatus.QUEUED, attempts: FiscalLimits.MAX_ATTEMPTS - 1 }
        })
        await owner.fiscalDocument.update({
          where: { id: refused.documentId },
          data: { status: FiscalDocumentStatus.REJECTED, attempts: 1 }
        })

        const read = async (id: string): Promise<One['data']> =>
          ((await asAdminA().get(ApiRoutes.fiscal.documents.byId(id))).body as One).data
        expect(await read(stuck.documentId)).toMatchObject({
          stuck: true,
          allowedActions: { retry: true, void: false }
        })
        expect(await read(retrying.documentId)).toMatchObject({ stuck: false })
        expect(await read(refused.documentId)).toMatchObject({
          stuck: false,
          allowedActions: { retry: true }
        })
        const after = await attentionOf()
        expect(after.stuck - before.stuck).toBe(1)
        expect(after.rejected - before.rejected).toBe(1)
        // The count is the organization's own, whatever the page is
        expect(await attentionOf(api(app, ctx.adminB, ctx.storeB))).toEqual(otherBefore)
      } finally {
        // The documents of this test go back to the state the sale left them in: the tests that follow read the same organization
        for (const original of originals) {
          await owner.fiscalDocument.update({
            where: { id: original.id },
            data: { status: original.status, attempts: original.attempts }
          })
        }
      }
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

  describe('the details of an invalidation (Step 4B.7c-4)', () => {
    const responsible = { name: 'Ana Pérez', idType: '13', idNumber: '012345678' }
    const requester = { name: 'Luis Gómez', idType: '36', idNumber: '06140101011011' }
    const voidWith = (documentId: string, body: Record<string, unknown>) =>
      asAdminA()
        .post(ApiRoutes.fiscal.documents.void(documentId))
        .send({ reason: 'wrong customer', ...body })
    // The replacement of an accepted document as the database keeps it: an accepted document is immutable and a replacement is made by the
    // lifecycle, so the tests make it as a copy of the original that names it (same order), changed as the case needs
    const replacementOf = async (documentId: string, over: Record<string, unknown> = {}) => {
      const mine = await owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
      return owner.fiscalDocument.create({
        data: {
          ...mine,
          id: randomUUID(),
          replacesDocumentId: documentId,
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
    }

    it('hands the kind, the people and the replacement to the provider, with the replacement as it was accepted', async () => {
      const provider = app.get(FiscalProviderRegistry).find(SIMULATOR_PROVIDER_ID)
      if (provider === undefined) throw new Error('the simulator is registered in test')
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const replacement = await replacementOf(documentId)
      const spy = jest.spyOn(provider, 'void')
      try {
        const answer = await voidWith(documentId, {
          kind: FiscalVoidKind.CORRECTION,
          responsible,
          requester,
          replacementDocumentId: replacement.id
        })
        expect(answer.status).toBe(OK)
        const details = spy.mock.calls[0]?.[3]
        expect(details).toMatchObject({ kind: FiscalVoidKind.CORRECTION, responsible, requester })
        expect(details?.replacement).toMatchObject({
          documentType: replacement.documentType,
          externalNumber: replacement.externalNumber
        })
        // The trail says the kind and the replacement, and never the number of an identity document
        const trail = await waitForAuditEntries(owner, {
          action: AuditAction.FISCAL_DOCUMENT_VOIDED,
          userId: ctx.adminA.id,
          resourceId: documentId
        })
        const metadata = JSON.stringify(trail.map(entry => entry.metadata))
        expect(metadata).toContain('"voidKind":"correction"')
        expect(metadata).toContain(replacement.id)
        expect(metadata).not.toContain(responsible.idNumber)
        // Without any of it the provider is told only the reason
        const plain = await sale()
        await documents.submit(ctx.orgA.id, plain.documentId)
        expect((await voidWith(plain.documentId, {})).status).toBe(OK)
        expect(spy.mock.calls[1]?.[3]).toEqual({})
      } finally {
        spy.mockRestore()
      }
    })

    it('refuses a replacement that was not made for this document, or is not an accepted document of the organization', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const queued = await sale()
      const unrelated = await sale()
      await documents.submit(ctx.orgA.id, unrelated.documentId)
      // The document itself, one that is not accepted, one that does not exist, an accepted one of another sale, and the document of
      // another organization
      const foreign = await createOrder(owner, { storeId: ctx.storeB.id })
      const other = await replacementOf(documentId, {
        replacesDocumentId: null,
        organizationId: ctx.orgB.id,
        storeId: ctx.storeB.id,
        orderId: foreign.id
      })
      // One that replaces it but was made in the other environment or with another provider is not taken either
      for (const change of [
        { environment: FiscalEnvironment.PRODUCTION },
        { providerId: 'another' }
      ]) {
        const fresh = await sale()
        await documents.submit(ctx.orgA.id, fresh.documentId)
        const made = await replacementOf(fresh.documentId, change)
        const answer = await voidWith(fresh.documentId, {
          kind: FiscalVoidKind.CORRECTION,
          responsible,
          requester,
          replacementDocumentId: made.id
        })
        expect(answer.status).toBe(NOT_FOUND)
      }
      // The document of the other organization stays (a fiscal document is never deleted): this block runs after the ones that read
      // the list of that organization
      for (const replacementDocumentId of [
        documentId,
        queued.documentId,
        unrelated.documentId,
        randomUUID(),
        other.id
      ]) {
        const answer = await voidWith(documentId, {
          kind: FiscalVoidKind.CORRECTION,
          responsible,
          requester,
          replacementDocumentId
        })
        expect(answer.status).toBe(NOT_FOUND)
      }
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('says the evidence cannot be read when the replacement has no sealed copy', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      const bare = await replacementOf(documentId, { builtPayloadEncrypted: null })
      const answer = await voidWith(documentId, {
        kind: FiscalVoidKind.CORRECTION,
        responsible,
        requester,
        replacementDocumentId: bare.id
      })
      expect(answer.status).toBe(CONFLICT)
      expect((answer.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE
      )
      expect(await statusOf(documentId)).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('refuses a body with a kind that does not exist, a person with no number, or a field it does not know', async () => {
      const { documentId } = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      for (const body of [
        { kind: 'nope' },
        { requester: { name: 'x', idType: '1' } },
        { responsible: { ...responsible, extra: 1 } },
        { replacementDocumentId: 'not-a-uuid' },
        { surprise: true }
      ]) {
        expect((await voidWith(documentId, body)).status).toBe(BAD_REQUEST)
      }
    })
  })
})
