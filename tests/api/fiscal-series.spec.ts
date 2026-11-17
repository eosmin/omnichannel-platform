import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { CredentialCipher } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalLimits,
  FiscalOperationCondition,
  FiscalRejectionReasons,
  FiscalSubmitOutcome,
  OrderStatus,
  PaymentMethod
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { FISCAL_PROVIDERS, FiscalDocumentsService } from '@platform/fiscal/runtime'
import type { FiscalBuildInput, FiscalDocumentProvider } from '@platform/fiscal/sdk'
import {
  SIMULATOR_PROVIDER_ID,
  SimulatorDocumentTypes,
  simulatorProvider
} from '@platform/fiscal/simulator'
import { SvRejectionReasons } from '@platform/fiscal/sv'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200

const SERIES_PROVIDER_ID = 'series-test'
const LIAR_PROVIDER_ID = 'series-liar'
const NEVER_SENT_PROVIDER_ID = 'never-sent'
const SECRET = 'not-a-real-signing-key-1234567890'

// A provider that numbers by document type, establishment and point of sale: the simulator with a manifest that says so. It records what
// core handed to `build`, which is what the numbering is for.
const built: FiscalBuildInput[] = []
function seriesProvider(): FiscalDocumentProvider {
  const base = simulatorProvider()
  return {
    id: SERIES_PROVIDER_ID,
    countryCode: base.countryCode,
    manifest: {
      ...base.manifest,
      requiredIssuerFields: [
        ...base.manifest.requiredIssuerFields,
        'establishmentCode',
        'pointOfSaleCode'
      ],
      sequence: { perDocumentType: true, perEstablishment: true, perPointOfSale: true }
    },
    validateIssuer: (issuer, credentials) => base.validateIssuer(issuer, credentials),
    validateReceiver: receiver => base.validateReceiver(receiver),
    resolveDocumentType: input => base.resolveDocumentType(input),
    build: input => {
      built.push(input)
      return base.build(input)
    },
    submit: (document, ctx) => base.submit(document, ctx),
    consult: (document, ctx) => base.consult(document, ctx),
    void: (doc, reason) => base.void(doc, reason)
  }
}

// A provider that says one type before it builds and builds another: the number would belong to a series that is not the document's
function liarProvider(): FiscalDocumentProvider {
  const base = simulatorProvider()
  return {
    ...seriesProvider(),
    id: LIAR_PROVIDER_ID,
    manifest: { ...base.manifest, sequence: { perDocumentType: true } },
    build: async input => ({
      ...(await base.build(input)),
      documentType: SimulatorDocumentTypes.BUSINESS
    })
  }
}

// A provider that refuses before it sends anything (a credential that is missing): `neverSent`
function neverSentProvider(): FiscalDocumentProvider {
  return {
    ...seriesProvider(),
    id: NEVER_SENT_PROVIDER_ID,
    manifest: simulatorProvider().manifest,
    resolveDocumentType: input => simulatorProvider().resolveDocumentType(input),
    submit: () =>
      Promise.resolve({
        outcome: FiscalSubmitOutcome.REJECTED as const,
        reason: SvRejectionReasons.CREDENTIALS_INCOMPLETE,
        neverSent: true as const
      })
  }
}

describe('The series of the fiscal correlatives (Step 4B.7c-1)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(FISCAL_PROVIDERS)
        .useValue([simulatorProvider(), seriesProvider(), liarProvider(), neverSentProvider()])
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

  const issuerBody = (providerId: string, extra: Record<string, unknown> = {}) => ({
    providerId,
    legalName: 'Series Issuer',
    taxId: 'ISSUER-TAX-ID',
    address: { line1: 'Calle 1', city: 'Ciudad' },
    environment: FiscalEnvironment.SANDBOX,
    issueOn: FiscalIssueOn.DELIVERED,
    credentials: { signingKey: SECRET },
    ...extra
  })
  const putIssuerA = (body: Record<string, unknown>) =>
    api(app, ctx.adminA, ctx.storeA).put(ApiRoutes.fiscal.issuer).send(body)
  const patchReceiver = (documentId: string, body: Record<string, unknown>) =>
    api(app, ctx.adminA, ctx.storeA)
      .patch(ApiRoutes.fiscal.documents.receiver(documentId))
      .send(body)

  async function delivered(
    organizationId: string,
    store: { id: string },
    payment: { paymentMethod?: string; paymentStatus?: string; paymentReference?: string } = {}
  ): Promise<{ orderId: string; documentId: string }> {
    const made = await createOrder(owner, { storeId: store.id })
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
        ...payment
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
      where: { orderId: order.id, organizationId },
      select: { id: true }
    })
    return { orderId: order.id, documentId: document.id }
  }
  const row = (documentId: string) =>
    owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })
  const buildsOf = (documentId: string): FiscalBuildInput[] => {
    const uuid = built.filter(input => input.documentUuid !== '')
    return uuid.filter(input => input.orderNumber === orderNumbers.get(documentId))
  }
  const orderNumbers = new Map<string, string>()
  async function sale(
    payment: Parameters<typeof delivered>[2] = {}
  ): Promise<{ orderId: string; documentId: string }> {
    const made = await delivered(ctx.orgA.id, ctx.storeA, payment)
    const order = await owner.order.findUniqueOrThrow({ where: { id: made.orderId } })
    orderNumbers.set(made.documentId, order.orderNumber)
    return made
  }

  describe('a provider that numbers by document type, establishment and point of sale', () => {
    beforeAll(async () => {
      const put = await putIssuerA(
        issuerBody(SERIES_PROVIDER_ID, { establishmentCode: 'M001', pointOfSaleCode: 'P001' })
      )
      expect(put.status).toBe(OK)
    })

    it('numbers each document in the series of its own type, from 1, and keeps the number across attempts', async () => {
      const first = await sale()
      const second = await sale()
      await documents.submit(ctx.orgA.id, first.documentId)
      await documents.submit(ctx.orgA.id, second.documentId)
      const [one, two] = [await row(first.documentId), await row(second.documentId)]
      expect([one.documentType, two.documentType]).toEqual([
        SimulatorDocumentTypes.CONSUMER,
        SimulatorDocumentTypes.CONSUMER
      ])
      expect([one.correlative, two.correlative]).toEqual([1, 2])
      expect(one.correlativeScopeKey).not.toBeNull()
      expect(one.correlativeScopeKey).toBe(two.correlativeScopeKey)
      // What the provider was handed is the number of the series, not the one of the organization
      expect(buildsOf(first.documentId).at(-1)?.correlative).toBe(1)
      expect(buildsOf(first.documentId).at(-1)?.sequenceNumber).toBe(one.sequenceNumber)
      expect(buildsOf(second.documentId).at(-1)?.correlative).toBe(2)
    })

    it('counts the series of another type apart: a business document starts at 1', async () => {
      const made = await sale()
      expect((await patchReceiver(made.documentId, { name: 'Acme', taxId: 'T-1' })).status).toBe(OK)
      await documents.submit(ctx.orgA.id, made.documentId)
      const business = await row(made.documentId)
      expect(business.documentType).toBe(SimulatorDocumentTypes.BUSINESS)
      expect(business.correlative).toBe(1)
      const consumer = await owner.fiscalDocument.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, documentType: SimulatorDocumentTypes.CONSUMER },
        orderBy: { correlative: 'asc' }
      })
      expect(business.correlativeScopeKey).not.toBe(consumer.correlativeScopeKey)
    })

    it('describes each series in its row, for a person who reads the table', async () => {
      const series = await owner.fiscalSequence.findMany({ where: { organizationId: ctx.orgA.id } })
      expect(series.length).toBeGreaterThanOrEqual(2)
      for (const one of series) {
        expect(one.scope).toMatchObject({
          providerId: SERIES_PROVIDER_ID,
          environment: FiscalEnvironment.SANDBOX,
          establishmentCode: 'M001',
          pointOfSaleCode: 'P001'
        })
      }
    })

    it('hands the provider the same stable identifier at every attempt and every build of a document', async () => {
      const made = await sale()
      await documents.submit(ctx.orgA.id, made.documentId)
      const identifiers = new Set(buildsOf(made.documentId).map(input => input.documentUuid))
      expect(identifiers.size).toBe(1)
      expect([...identifiers][0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      const other = await sale()
      await documents.submit(ctx.orgA.id, other.documentId)
      expect(buildsOf(other.documentId).at(-1)?.documentUuid).not.toBe([...identifiers][0])
    })

    it('keeps the number of a document that was refused and corrected with the same type of document', async () => {
      const made = await sale()
      // A tax id that makes the simulator refuse: the document is a business one
      expect((await patchReceiver(made.documentId, { name: 'Ana', taxId: 'REJECT' })).status).toBe(
        OK
      )
      await documents.submit(ctx.orgA.id, made.documentId)
      const refused = await row(made.documentId)
      expect(refused.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(refused.documentType).toBe(SimulatorDocumentTypes.BUSINESS)
      const businessNumber = refused.correlative
      expect(businessNumber).not.toBeNull()

      // Fixed with the same type of document: sent again, the same number
      expect((await patchReceiver(made.documentId, { name: 'Ana', taxId: 'FIXED-1' })).status).toBe(
        OK
      )
      const retried = await api(app, ctx.adminA, ctx.storeA).post(
        ApiRoutes.fiscal.documents.retry(made.documentId)
      )
      expect(retried.status).toBe(OK)
      await documents.submit(ctx.orgA.id, made.documentId)
      const accepted = await row(made.documentId)
      expect(accepted.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(accepted.correlative).toBe(businessNumber)
    })

    it('takes the next number of the new series when a corrected receiver makes another type of document, and leaves the old number unused', async () => {
      const made = await sale()
      expect((await patchReceiver(made.documentId, { name: 'Ana', taxId: 'REJECT' })).status).toBe(
        OK
      )
      await documents.submit(ctx.orgA.id, made.documentId)
      const refused = await row(made.documentId)
      expect(refused.documentType).toBe(SimulatorDocumentTypes.BUSINESS)
      const businessKey = refused.correlativeScopeKey
      const lastConsumer =
        (
          await owner.fiscalDocument.aggregate({
            _max: { correlative: true },
            where: { organizationId: ctx.orgA.id, documentType: SimulatorDocumentTypes.CONSUMER }
          })
        )._max.correlative ?? 0

      // No tax id any more: a consumer document, counted in the series of consumers
      expect((await patchReceiver(made.documentId, { taxId: null })).status).toBe(OK)
      expect(
        (
          await api(app, ctx.adminA, ctx.storeA).post(
            ApiRoutes.fiscal.documents.retry(made.documentId)
          )
        ).status
      ).toBe(OK)
      await documents.submit(ctx.orgA.id, made.documentId)
      const accepted = await row(made.documentId)
      expect(accepted.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(accepted.documentType).toBe(SimulatorDocumentTypes.CONSUMER)
      expect(accepted.correlativeScopeKey).not.toBe(businessKey)
      expect(accepted.correlative).toBe(lastConsumer + 1)
    })

    it('an accepted document keeps its number for ever: the database refuses to change it', async () => {
      const made = await sale()
      await documents.submit(ctx.orgA.id, made.documentId)
      const accepted = await row(made.documentId)
      expect(accepted.status).toBe(FiscalDocumentStatus.ACCEPTED)
      await expect(
        owner.fiscalDocument.update({
          where: { id: made.documentId },
          data: { correlative: (accepted.correlative ?? 0) + 100 }
        })
      ).rejects.toThrow(/immutable/)
      await expect(
        owner.fiscalDocument.update({
          where: { id: made.documentId },
          data: { correlativeScopeKey: 'another' }
        })
      ).rejects.toThrow(/immutable/)
    })

    it('never gives two documents of a series the same number, even when they are numbered at the same moment', async () => {
      const documentsOfRun = await Promise.all(Array.from({ length: 6 }, () => sale()))
      await Promise.all(documentsOfRun.map(made => documents.submit(ctx.orgA.id, made.documentId)))
      const rows = await Promise.all(documentsOfRun.map(made => row(made.documentId)))
      const numbers = rows.map(one => one.correlative)
      expect(numbers.every(number => number !== null)).toBe(true)
      expect(new Set(numbers).size).toBe(numbers.length)
      // The series has no hole: the numbers are consecutive (the rows of this run are the last ones of the consumer series)
      const sorted = numbers
        .flatMap(number => (number === null ? [] : [number]))
        .sort((a, b) => a - b)
      expect((sorted.at(-1) ?? 0) - (sorted[0] ?? 0) + 1).toBe(sorted.length)
    })

    it('the database refuses two documents with the same number of a series, a lowered counter and a deleted one', async () => {
      const [one, two] = [await sale(), await sale()]
      await documents.submit(ctx.orgA.id, one.documentId)
      const a = await row(one.documentId)
      // A document that is not accepted yet (the guard of an accepted one would answer first): the unique index is what refuses
      await expect(
        owner.fiscalDocument.update({
          where: { id: two.documentId },
          data: { correlative: a.correlative, correlativeScopeKey: a.correlativeScopeKey }
        })
      ).rejects.toThrow(/unique constraint/i)

      const counter = await owner.fiscalSequence.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, scopeKey: a.correlativeScopeKey ?? '' }
      })
      await expect(
        owner.fiscalSequence.update({
          where: {
            organizationId_scopeKey: { organizationId: ctx.orgA.id, scopeKey: counter.scopeKey }
          },
          data: { nextValue: 1 }
        })
      ).rejects.toThrow(/only moves forward/)
      await expect(
        owner.fiscalSequence.delete({
          where: {
            organizationId_scopeKey: { organizationId: ctx.orgA.id, scopeKey: counter.scopeKey }
          }
        })
      ).rejects.toThrow(/never deleted/)
    })

    it('refuses a number past the end of the series and leaves the counter where it was', async () => {
      const made = await sale()
      // The receiver makes the series of the business documents, and its counter sits at the last number
      expect((await patchReceiver(made.documentId, { name: 'Zed', taxId: 'Z-1' })).status).toBe(OK)
      const probe = await owner.fiscalSequence.findFirstOrThrow({
        where: {
          organizationId: ctx.orgA.id,
          scope: { path: ['documentType'], equals: SimulatorDocumentTypes.BUSINESS }
        }
      })
      await owner.fiscalSequence.update({
        where: {
          organizationId_scopeKey: { organizationId: ctx.orgA.id, scopeKey: probe.scopeKey }
        },
        data: { nextValue: FiscalLimits.MAX_CORRELATIVE + 1 }
      })
      await documents.submit(ctx.orgA.id, made.documentId)
      const after = await row(made.documentId)
      expect(after.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(after.rejectionReason).toBe(FiscalRejectionReasons.SEQUENCE_EXHAUSTED)
      expect(after.correlative).toBeNull()
      const counter = await owner.fiscalSequence.findUniqueOrThrow({
        where: {
          organizationId_scopeKey: { organizationId: ctx.orgA.id, scopeKey: probe.scopeKey }
        }
      })
      expect(counter.nextValue).toBe(FiscalLimits.MAX_CORRELATIVE + 1)
    })

    it('hands the provider how the order was paid, and reads a payment that is not completed as deferred', async () => {
      const paid = await sale({
        paymentMethod: PaymentMethod.TRANSFER,
        paymentStatus: 'COMPLETED',
        paymentReference: 'TRF-77'
      })
      await documents.submit(ctx.orgA.id, paid.documentId)
      const input = buildsOf(paid.documentId).at(-1)
      expect(input?.payments).toEqual([
        { method: PaymentMethod.TRANSFER, amountCents: 2825, reference: 'TRF-77' }
      ])
      expect(input?.condition).toBe(FiscalOperationCondition.IMMEDIATE)
      const owed = await sale({
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        paymentStatus: 'PENDING'
      })
      await documents.submit(ctx.orgA.id, owed.documentId)
      expect(buildsOf(owed.documentId).at(-1)?.condition).toBe(FiscalOperationCondition.DEFERRED)
      // The lines carry the treatment the order kept
      expect(input?.lines[0]?.taxTreatment).toBe('taxed')
    })
  })

  describe('the series of an organization belongs to it', () => {
    it('starts at 1 for another organization with the same provider, and never reads the series of the first', async () => {
      const put = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.fiscal.issuer)
        .send(
          issuerBody(SERIES_PROVIDER_ID, { establishmentCode: 'M001', pointOfSaleCode: 'P001' })
        )
      expect(put.status).toBe(OK)
      const made = await delivered(ctx.orgB.id, ctx.storeB)
      await documents.submit(ctx.orgB.id, made.documentId)
      const mine = await row(made.documentId)
      expect(mine.correlative).toBe(1)
      // Same provider, same environment, same codes: the same key, in another organization's row
      const own = await owner.fiscalSequence.findMany({ where: { organizationId: ctx.orgB.id } })
      expect(own).toHaveLength(1)
      expect(own[0]?.nextValue).toBe(2)
      // And the first organization's counters did not move with the second one's document
      const countersOfA = () =>
        owner.fiscalSequence.findMany({
          where: { organizationId: ctx.orgA.id },
          orderBy: { scopeKey: 'asc' },
          select: { scopeKey: true, nextValue: true }
        })
      const beforeA = await countersOfA()
      const again = await delivered(ctx.orgB.id, ctx.storeB)
      await documents.submit(ctx.orgB.id, again.documentId)
      expect(await countersOfA()).toEqual(beforeA)
      expect((await row(again.documentId)).correlative).toBe(2)
    })
  })

  describe('a provider that declares no series', () => {
    it('numbers by the correlative of the organization, as before, and keeps no series', async () => {
      const put = await putIssuerA(issuerBody(SIMULATOR_PROVIDER_ID))
      expect(put.status).toBe(OK)
      const countBefore = await owner.fiscalSequence.count({
        where: { organizationId: ctx.orgA.id }
      })
      const made = await sale()
      await documents.submit(ctx.orgA.id, made.documentId)
      const one = await row(made.documentId)
      expect(one.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(one.correlative).toBeNull()
      expect(one.correlativeScopeKey).toBeNull()
      expect(await owner.fiscalSequence.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        countBefore
      )
    })
  })

  describe('the point of sale and the contact of the issuer', () => {
    const view = async () =>
      (
        (await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.fiscal.issuer)).body as {
          data: Record<string, unknown>
        }
      ).data

    it('are kept, stay when a later request leaves them out, and are cleared when sent as null', async () => {
      const set = await putIssuerA(
        issuerBody(SIMULATOR_PROVIDER_ID, {
          establishmentType: 'branch',
          pointOfSaleCode: 'P002',
          phone: '2222-0000',
          email: 'billing@example.test'
        })
      )
      expect(set.status).toBe(OK)
      expect(await view()).toMatchObject({
        establishmentType: 'branch',
        pointOfSaleCode: 'P002',
        phone: '2222-0000',
        email: 'billing@example.test'
      })
      // A form that does not know them leaves them out and wipes nothing
      expect((await putIssuerA(issuerBody(SIMULATOR_PROVIDER_ID))).status).toBe(OK)
      expect(await view()).toMatchObject({ pointOfSaleCode: 'P002', phone: '2222-0000' })
      // Null clears one and leaves the others
      expect((await putIssuerA(issuerBody(SIMULATOR_PROVIDER_ID, { phone: null }))).status).toBe(OK)
      expect(await view()).toMatchObject({ phone: null, pointOfSaleCode: 'P002' })
    })

    it('are part of the snapshot of a document, and a document made before them is not refused as another issuer', async () => {
      const made = await sale()
      const snapshot = (await row(made.documentId)).issuerSnapshot as Record<string, unknown>
      expect(snapshot).toMatchObject({ pointOfSaleCode: 'P002', establishmentType: 'branch' })
      // The snapshot of a document made before the fields existed has no key for them
      const old = { ...snapshot }
      for (const key of ['establishmentType', 'pointOfSaleCode', 'phone', 'email']) delete old[key]
      // The guards are off for this one statement and inside one transaction, so a failure puts them back (like `purgeFinance`)
      // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
      await owner.$transaction(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE fiscal_documents DISABLE TRIGGER USER')
        await tx.fiscalDocument.update({
          where: { id: made.documentId },
          data: { issuerSnapshot: old as never }
        })
        await tx.$executeRawUnsafe('ALTER TABLE fiscal_documents ENABLE TRIGGER USER')
      })
      // The issuer now has no point of sale: the same issuer as the old snapshot, so the document is sent
      expect(
        (
          await putIssuerA(
            issuerBody(SIMULATOR_PROVIDER_ID, {
              establishmentType: null,
              pointOfSaleCode: null,
              phone: null,
              email: null
            })
          )
        ).status
      ).toBe(OK)
      await documents.submit(ctx.orgA.id, made.documentId)
      expect((await row(made.documentId)).status).toBe(FiscalDocumentStatus.ACCEPTED)
    })

    it('changing one of them after a document was made refuses that document as made for another issuer', async () => {
      const made = await sale()
      expect(
        (await putIssuerA(issuerBody(SIMULATOR_PROVIDER_ID, { pointOfSaleCode: 'P009' }))).status
      ).toBe(OK)
      await documents.submit(ctx.orgA.id, made.documentId)
      const after = await row(made.documentId)
      expect(after.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(after.rejectionReason).toBe(FiscalRejectionReasons.ISSUER_CHANGED)
    })
  })

  describe('the kind of identity document of a receiver', () => {
    it('is kept with the receiver of a document, sealed like the rest of it, and read back by it', async () => {
      const made = await sale()
      const patched = await patchReceiver(made.documentId, {
        name: 'Ana',
        taxId: 'ID-1',
        documentType: 'passport'
      })
      expect(patched.status).toBe(OK)
      const sealed = (await row(made.documentId)).receiverEncrypted
      expect(Buffer.from(sealed).toString('utf8')).not.toContain('passport')
      expect(app.get(CredentialCipher).open(sealed)).toMatchObject({
        taxId: 'ID-1',
        documentType: 'passport'
      })
      // Sent as null it is removed, and the other fields stay
      expect((await patchReceiver(made.documentId, { documentType: null })).status).toBe(OK)
      const opened = app.get(CredentialCipher).open((await row(made.documentId)).receiverEncrypted)
      expect(opened['documentType']).toBeUndefined()
      expect(opened['taxId']).toBe('ID-1')
    })
  })

  describe('what core refuses to number', () => {
    it('never sends a document whose built type is not the one its series was chosen for', async () => {
      expect((await putIssuerA(issuerBody(LIAR_PROVIDER_ID))).status).toBe(OK)
      const made = await sale()
      await documents.submit(ctx.orgA.id, made.documentId)
      const after = await row(made.documentId)
      expect(after.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(after.rejectionReason).toBe(FiscalRejectionReasons.BUILD_FAILED)
    })

    it.each([
      ['the establishment', { establishmentCode: null, pointOfSaleCode: 'P001' }],
      ['the point of sale', { establishmentCode: 'M001', pointOfSaleCode: null }]
    ])(
      'refuses a series by establishment and point of sale when the issuer has no code for %s, so no series starts without it',
      async (_part, codes) => {
        // The issuer is saved (the simulator's own check does not ask for the codes), one code sent and the other cleared
        expect((await putIssuerA(issuerBody(SERIES_PROVIDER_ID, codes))).status).toBe(OK)
        const made = await sale()
        const before = await owner.fiscalSequence.count({ where: { organizationId: ctx.orgA.id } })
        await documents.submit(ctx.orgA.id, made.documentId)
        const after = await row(made.documentId)
        expect(after.status).toBe(FiscalDocumentStatus.REJECTED)
        expect(after.rejectionReason).toBe(FiscalRejectionReasons.BUILD_FAILED)
        expect(after.correlative).toBeNull()
        expect(await owner.fiscalSequence.count({ where: { organizationId: ctx.orgA.id } })).toBe(
          before
        )
      }
    )
  })

  describe('a refusal of the provider before anything was sent', () => {
    it('gives the attempt back and keeps the submission: it reads as a document that never left, not as one the authority refused', async () => {
      expect((await putIssuerA(issuerBody(NEVER_SENT_PROVIDER_ID))).status).toBe(OK)
      const never = await sale()
      await documents.submit(ctx.orgA.id, never.documentId)
      const notSent = await row(never.documentId)
      expect(notSent.status).toBe(FiscalDocumentStatus.REJECTED)
      expect(notSent.rejectionReason).toBe(SvRejectionReasons.CREDENTIALS_INCOMPLETE)
      expect([notSent.submission, notSent.attempts]).toEqual([1, 0])

      // The authority's own refusal moves the submission (a new key for the document once a person fixes it)
      expect((await putIssuerA(issuerBody(SIMULATOR_PROVIDER_ID))).status).toBe(OK)
      const refusedByAuthority = await sale()
      expect(
        (await patchReceiver(refusedByAuthority.documentId, { name: 'Ana', taxId: 'REJECT' }))
          .status
      ).toBe(OK)
      await documents.submit(ctx.orgA.id, refusedByAuthority.documentId)
      expect((await row(refusedByAuthority.documentId)).submission).toBe(2)
    })
  })
})
