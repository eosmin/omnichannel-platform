import { randomInt, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import type { INestApplication } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { unzipSync } from 'fflate'
import type { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  type DsrConfig,
  dsrEmailHash,
  dsrNoticeStatusOf
} from '@platform/core/compliance'
import { CredentialCipher, encrypt, parseEncryptionKey } from '@platform/core/crypto'
import { JobContext } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelIds,
  DAY_MS,
  DsrStatus,
  DsrType,
  MediaStatus,
  MessageType,
  OrderStatus
} from '@platform/core/domain'
import type { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { dsrResultMailJobId, type SendEmailJob } from '@platform/core/queues'
import { MediaPurpose, StorageKeys } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import { collectDsrExport } from '../../apps/worker/src/compliance/dsr-export-data'
import { DsrExportRunner } from '../../apps/worker/src/compliance/dsr-export.runner'
import { DsrNoticeLedger } from '../../apps/worker/src/compliance/dsr-notice-ledger.service'
import { DsrNoticeSender } from '../../apps/worker/src/compliance/dsr-notice-sender.service'
import {
  createConversation,
  createCustomer,
  createCustomerIdentity,
  createMessage,
  createOrder
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { createGuardedWorkerPrisma } from '../helpers/worker-db'

const CONFIG: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}
const HOUR_MS = 60 * 60 * 1000

interface Call {
  name: string
  data: SendEmailJob
  options: { jobId?: string }
}

// Step 7.2-H2b-2: the export of an approved access or portability request and the purge of the expired files, against the REAL database as the
// (guarded) role of the worker. A person of store A shares an address with people of the sibling store and of another organization, and
// the cases prove that the file holds the data of the people the request names and of nobody else, that the notes of the team are not in
// it, that a try is counted before the work, that the request goes back to review when it cannot be done, and that an expired file is deleted.
describe('the export of the data requests of access and portability', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let runner: DsrExportRunner
  let prisma: ReturnType<typeof createGuardedWorkerPrisma>
  let jobContext: JobContext
  let ledger: DsrNoticeLedger
  const cipher = new CredentialCipher(parseEncryptionKey(CONFIG.encryptionKeyHex))
  const objects = new Map<string, Buffer>()
  const deleted: string[] = []
  const mails: Call[] = []
  const published: { event: string; payload: unknown }[] = []
  let failPut = false
  let realAudit: AuditService
  const audit = {
    log: jest.fn<void, [Parameters<AuditService['log']>[0]]>(entry => realAudit.log(entry))
  }
  const logger = { setContext: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([])
    ctx = await seedTestContext(owner, app, prefix)
    prisma = createGuardedWorkerPrisma()
    realAudit = new AuditService(prisma, logger as unknown as PinoLogger)
    const storage = {
      putStream: async (key: string, body: Readable) => {
        if (failPut) {
          body.destroy()
          throw new Error(`the bucket said no for ${prefix}@example.com`)
        }
        const chunks: Buffer[] = []
        for await (const chunk of body) chunks.push(chunk as Buffer)
        objects.set(key, Buffer.concat(chunks))
      },
      stream: (key: string) => {
        const object = objects.get(key)
        return Promise.resolve(object === undefined ? null : Readable.from([object]))
      },
      head: (key: string) => {
        const object = objects.get(key)
        return Promise.resolve(object === undefined ? null : { contentLength: object.length })
      },
      delete: (key: string) => {
        deleted.push(key)
        objects.delete(key)
        return Promise.resolve()
      }
    } as unknown as StorageService
    const mailQueue = {
      add: (name: string, data: SendEmailJob, options: { jobId?: string }) => {
        mails.push({ name, data, options })
        return Promise.resolve()
      }
    }
    const events = {
      publish: (_tx: unknown, event: string, payload: unknown) => {
        published.push({ event, payload })
      }
    } as unknown as DomainEvents
    jobContext = new JobContext(prisma)
    ledger = new DsrNoticeLedger(
      prisma,
      jobContext,
      audit as unknown as AuditService,
      events,
      logger as unknown as PinoLogger
    )
    const sender = new DsrNoticeSender(
      prisma,
      jobContext,
      ledger,
      mailQueue as unknown as Queue<SendEmailJob>,
      CONFIG,
      logger as unknown as PinoLogger
    )
    runner = new DsrExportRunner(
      prisma,
      jobContext,
      audit as unknown as AuditService,
      events,
      storage,
      sender,
      cipher,
      CONFIG,
      logger as unknown as PinoLogger
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    objects.clear()
    deleted.length = 0
    mails.length = 0
    published.length = 0
    failPut = false
    audit.log.mockClear()
    logger.error.mockClear()
    jest.restoreAllMocks()
  })

  const addressOf = (name: string): string =>
    `${prefix}-${name}-${randomUUID().slice(0, 6)}@example.com`

  async function customerWith(storeId: string, email: string, name: string): Promise<string> {
    const customer = await createCustomer(owner, { storeId })
    await owner.customer.update({ where: { id: customer.id }, data: { email, name } })
    return customer.id
  }

  async function approvedExport(input: {
    storeId?: string
    organizationId?: string
    customerIds: string[]
    email: string
    type?: string
    status?: string
    attempts?: number
    attemptedAt?: Date | null
  }): Promise<string> {
    const row = await owner.dataSubjectRequest.create({
      data: {
        organizationId: input.organizationId ?? ctx.orgA.id,
        storeId: input.storeId ?? ctx.storeA.id,
        type: input.type ?? DsrType.ACCESS,
        status: input.status ?? DsrStatus.IN_PROGRESS,
        subjectType: 'customer',
        subjectEmailHash: dsrEmailHash(input.email, CONFIG.hashKey),
        subjectCustomerIds: input.customerIds,
        notifyToEncrypted: encrypt(input.email, parseEncryptionKey(CONFIG.encryptionKeyHex)),
        approvals: [{ userId: ctx.adminA.id, at: new Date().toISOString() }],
        verifiedAt: new Date(),
        deadlineAt: new Date(Date.now() + 30 * DAY_MS),
        exportAttempts: input.attempts ?? 0,
        exportAttemptedAt: input.attemptedAt ?? null
      },
      select: { id: true }
    })
    return row.id
  }

  // A person of store A with a conversation (their words, a reply of the team, an internal note), an order and an address
  async function personOfStoreA(name: string) {
    const email = addressOf(name)
    const customerId = await customerWith(ctx.storeA.id, email, `Ana ${name}`)
    const identity = await createCustomerIdentity(owner, { storeId: ctx.storeA.id, customerId })
    const conversation = await createConversation(owner, {
      storeId: ctx.storeA.id,
      customerId,
      customerIdentityId: identity.id,
      channelType: ChannelIds.INSTAGRAM
    })
    await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: conversation.id,
      content: `hello from ${name}`,
      authorType: AuthorType.CUSTOMER
    })
    await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: conversation.id,
      content: `reply to ${name}`,
      authorType: AuthorType.AGENT,
      authorId: ctx.adminA.id
    })
    await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: conversation.id,
      content: `SECRET internal note about ${name}`,
      authorType: AuthorType.AGENT,
      authorId: ctx.adminA.id,
      type: MessageType.INTERNAL_NOTE
    })
    const order = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: OrderStatus.DELIVERED
    })
    await owner.order.update({
      where: { id: order.id },
      data: {
        customerId,
        internalNotes: `SECRET internal order note ${name}`,
        packingNotes: `SECRET packing note ${name}`
      }
    })
    await owner.address.create({
      data: { customerId, line1: `Calle ${name} 1`, city: 'San Salvador', country: 'SV' }
    })
    return { email, customerId, orderId: order.id }
  }

  const rowOf = (id: string) => owner.dataSubjectRequest.findUniqueOrThrow({ where: { id } })
  const releaseLease = (id: string) =>
    owner.dataSubjectRequest.update({
      where: { id },
      data: { exportAttemptedAt: new Date(Date.now() - 2 * HOUR_MS) }
    })
  const filesOf = (id: string): Record<string, unknown> => {
    const zip = objects.get(StorageKeys.dsrExport(id))
    if (zip === undefined) throw new Error('no export')
    const files = unzipSync(new Uint8Array(zip))
    return Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
      ])
    )
  }

  it('makes one file with the data of the people the request names and of nobody else, and ends the request', async () => {
    const mine = await personOfStoreA('ana')
    const email = mine.email
    // The same address in the sibling store and in another organization: other people, other data, never in this file
    const sibling = await customerWith(ctx.storeA2.id, email, 'Ana of the sibling store')
    const other = await customerWith(ctx.storeB.id, email, 'Ana of another organization')
    const bystander = await personOfStoreA('bystander')
    const id = await approvedExport({ customerIds: [mine.customerId], email })

    const report = await runner.run()

    expect(report.exported).toBeGreaterThanOrEqual(1)
    const files = filesOf(id)
    const text = JSON.stringify(files)
    // Theirs: the customer, the words, the order, the address
    expect(text).toContain('hello from ana')
    expect(text).toContain('reply to ana')
    expect(text).toContain('Calle ana 1')
    expect(text).toContain(mine.email)
    // Not theirs: the notes of the team, the people of other stores, the bystander of the same store
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain(sibling)
    expect(text).not.toContain(other)
    expect(text).not.toContain('Ana of the sibling store')
    expect(text).not.toContain('Ana of another organization')
    expect(text).not.toContain(bystander.customerId)
    expect(text).not.toContain('hello from bystander')
    expect(text).not.toContain(ctx.adminA.id)
    // The manifest carries the hash of each file and says what is not included
    const manifest = files['manifest.json'] as {
      files: { name: string; sha256: string }[]
      notIncluded: string[]
      counts: Record<string, number>
    }
    expect(manifest.files.map(file => file.name)).toEqual(
      expect.arrayContaining(['customers.json', 'orders.json', 'conversations.json'])
    )
    expect(manifest.notIncluded.length).toBeGreaterThan(0)
    expect(manifest.counts).toMatchObject({
      customers: 1,
      conversations: 1,
      messages: 2,
      orders: 1
    })

    const row = await rowOf(id)
    expect(row).toMatchObject({
      status: DsrStatus.COMPLETED,
      resultKey: StorageKeys.dsrExport(id),
      subjectEmailHash: null,
      exportFailureCode: null,
      exportAttempts: 1
    })
    // The file lives the days the link lives, and the summary holds counts only
    const lifeMs = (row.resultExpiresAt?.getTime() ?? 0) - (row.completedAt?.getTime() ?? 0)
    expect(lifeMs).toBe(ComplianceConfig.DSR_EXPORT_LINK_DAYS * DAY_MS)
    expect(row.retainedRecordsSummary).toMatchObject({ legalBasis: 'legal_obligation', orders: 1 })
    // The audit holds ids and counts: never the data, never the address
    const entry = audit.log.mock.calls
      .map(call => call[0])
      .find(e => e.action === AuditAction.DSR_EXPORT_COMPLETED)
    expect(entry?.actor).toEqual({ system: true })
    expect(JSON.stringify(entry)).not.toContain('@example.com')
    expect(JSON.stringify(entry)).not.toContain('Ana')
  })

  it('tells the person once, keeps the address until the processor confirms, and the mail names no data', async () => {
    const mine = await personOfStoreA('notice')
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })

    await runner.run()

    const toThem = mails.filter(mail => [mail.data.to].flat().includes(mine.email))
    expect(toThem).toHaveLength(1)
    expect(toThem[0]?.data.data).toEqual({ outcome: 'completed', requestType: 'access' })
    expect(toThem[0]?.options.jobId).toBe(dsrResultMailJobId(id))
    expect(toThem[0]?.data.dsrNotice).toEqual({ requestId: id, storeId: ctx.storeA.id })
    const row = await rowOf(id)
    expect(row.notifyToEncrypted).not.toBeNull()
    expect(dsrNoticeStatusOf(row)).toBe('pending')
    // A second night does not queue it again while it is on its way
    mails.length = 0
    await runner.run()
    expect(mails.filter(mail => [mail.data.to].flat().includes(mine.email))).toHaveLength(0)
    await ledger.sent(ctx.storeA.id, id)
    expect(dsrNoticeStatusOf(await rowOf(id))).toBe('sent')
  })

  it('exports the portability kind the same way', async () => {
    const mine = await personOfStoreA('port')
    const id = await approvedExport({
      customerIds: [mine.customerId],
      email: mine.email,
      type: DsrType.PORTABILITY
    })

    await runner.run()

    expect((await rowOf(id)).status).toBe(DsrStatus.COMPLETED)
    expect(Object.keys(filesOf(id))).toContain('customers.json')
  })

  it('never takes a request that is not approved, not an export, or that already has its file', async () => {
    const a = await personOfStoreA('idle')
    const inReview = await approvedExport({
      customerIds: [a.customerId],
      email: a.email,
      status: DsrStatus.MANUAL_REVIEW
    })
    const erasure = await approvedExport({
      customerIds: [a.customerId],
      email: a.email,
      type: DsrType.ERASURE
    })
    const withFile = await approvedExport({ customerIds: [a.customerId], email: a.email })
    await owner.dataSubjectRequest.update({
      where: { id: withFile },
      data: { resultKey: 'compliance/dsr/x/export.zip' }
    })

    await runner.run()

    expect(objects.size).toBe(0)
    expect((await rowOf(inReview)).status).toBe(DsrStatus.MANUAL_REVIEW)
    expect(await rowOf(erasure)).toMatchObject({ status: DsrStatus.IN_PROGRESS, exportAttempts: 0 })
    expect((await rowOf(withFile)).exportAttempts).toBe(0)
  })

  const rawFilesOf = (id: string): Record<string, Buffer> => {
    const zip = objects.get(StorageKeys.dsrExport(id))
    if (zip === undefined) throw new Error('no export')
    return Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(zip))).map(([name, bytes]) => [
        name,
        Buffer.from(bytes)
      ])
    )
  }
  const textOf = (files: Record<string, Buffer>, name: string): string =>
    (files[name] ?? Buffer.alloc(0)).toString('utf8')

  // A file a person sent in a chat: a row of the store and the bytes in the (fake) bucket
  async function fileOf(
    storeId: string,
    customerId: string,
    filename: string,
    bytes: Buffer,
    status: string = MediaStatus.CLEAN,
    inBucket = true
  ): Promise<string> {
    const id = randomUUID()
    const key = StorageKeys.message(storeId, id, filename)
    await owner.media.create({
      data: {
        id,
        storeId,
        customerId,
        purpose: MediaPurpose.MESSAGE,
        key,
        filename,
        contentType: 'image/png',
        fileSize: bytes.length,
        status
      }
    })
    if (inBucket) objects.set(key, bytes)
    return key
  }
  // A fiscal document of an order, with the receiver sealed as the app seals it
  async function fiscalDocumentOf(
    storeId: string,
    orderId: string,
    receiver: Record<string, unknown>
  ): Promise<void> {
    await owner.fiscalDocument.create({
      data: {
        organizationId: ctx.orgA.id,
        storeId,
        orderId,
        sequenceNumber: randomInt(1_000_000, 2_000_000_000),
        documentType: 'invoice',
        status: 'accepted',
        providerId: 'simulator',
        environment: 'sandbox',
        issuerSnapshot: { legalName: 'SECRET issuer' },
        linesSnapshot: { lines: [{ description: 'Blue shirt', quantity: 1, totalCents: 1130 }] },
        receiverEncrypted: new Uint8Array(cipher.seal(receiver)),
        builtPayloadEncrypted: new Uint8Array(cipher.seal({ payload: 'SECRET payload' })),
        providerData: { token: 'SECRET provider data' },
        response: { sello: 'SECRET authority answer' },
        voidReason: 'SECRET internal reason',
        totalCents: 1130,
        taxCents: 130
      }
    })
  }

  it('puts the files of the person and their fiscal data in the ZIP, and the files and fiscal data of nobody else', async () => {
    const mine = await personOfStoreA('files')
    const bystander = await personOfStoreA('bystander-files')
    const sibling = await customerWith(ctx.storeA2.id, mine.email, 'Ana of the sibling store')
    const photo = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3, 255, 254])
    await fileOf(ctx.storeA.id, mine.customerId, 'receipt.png', photo)
    await fileOf(
      ctx.storeA.id,
      mine.customerId,
      'virus.png',
      Buffer.from('INFECTED-BYTES'),
      MediaStatus.INFECTED
    )
    await fileOf(
      ctx.storeA.id,
      mine.customerId,
      'waiting.png',
      Buffer.from('UNSCANNED-BYTES'),
      MediaStatus.PENDING
    )
    await fileOf(
      ctx.storeA.id,
      mine.customerId,
      'lost.png',
      Buffer.from('x'),
      MediaStatus.CLEAN,
      false
    )
    await fileOf(ctx.storeA.id, bystander.customerId, 'theirs.png', Buffer.from('BYSTANDER-BYTES'))
    await fileOf(ctx.storeA2.id, sibling, 'sibling.png', Buffer.from('SIBLING-BYTES'))
    await owner.customerFiscalData.create({
      data: {
        storeId: ctx.storeA.id,
        customerId: mine.customerId,
        dataEncrypted: new Uint8Array(
          cipher.seal({ name: 'Ana Fiscal SA', taxId: 'NIT-ANA-1', internalFlag: 'SECRET-flag' })
        )
      }
    })
    await owner.customerFiscalData.create({
      data: {
        storeId: ctx.storeA.id,
        customerId: bystander.customerId,
        dataEncrypted: new Uint8Array(cipher.seal({ name: 'Bystander SA', taxId: 'NIT-BYSTANDER' }))
      }
    })
    await fiscalDocumentOf(ctx.storeA.id, mine.orderId, {
      name: 'Ana Receiver',
      taxId: 'NIT-ANA-2'
    })
    await fiscalDocumentOf(ctx.storeA.id, bystander.orderId, {
      name: 'Bystander Receiver',
      taxId: 'NIT-BYSTANDER-2'
    })
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })

    await runner.run()

    const files = rawFilesOf(id)
    const entries = Object.keys(files).filter(name => name.startsWith('files/'))
    expect(entries).toHaveLength(1)
    expect(files[entries[0] ?? '']?.equals(photo)).toBe(true)
    const everything = Object.values(files)
      .map(file => file.toString('latin1'))
      .join('\n')
    for (const secret of [
      'INFECTED-BYTES',
      'UNSCANNED-BYTES',
      'BYSTANDER',
      'SIBLING-BYTES',
      'SECRET',
      'stores/'
    ]) {
      expect(everything).not.toContain(secret)
    }
    // What is left out of the ZIP is listed, with the reason
    const listed = JSON.parse(textOf(files, 'files.json')) as {
      filename: string
      included: boolean
      reason?: string
    }[]
    expect(listed.map(row => [row.filename, row.included, row.reason ?? null]).sort()).toEqual(
      [
        ['receipt.png', true, null],
        ['virus.png', false, 'not_scanned_clean'],
        ['waiting.png', false, 'not_scanned_clean'],
        ['lost.png', false, 'not_available']
      ].sort()
    )
    // Their fiscal record and the document issued to them, opened for them
    expect(textOf(files, 'fiscal-data.json')).toContain('NIT-ANA-1')
    expect(textOf(files, 'fiscal-documents.json')).toContain('NIT-ANA-2')
    expect(textOf(files, 'fiscal-documents.json')).toContain('Blue shirt')
    const manifest = JSON.parse(textOf(files, 'manifest.json')) as {
      files: { name: string; sha256: string }[]
      counts: Record<string, number>
    }
    expect(manifest.files.map(file => file.name)).toEqual(
      expect.arrayContaining(['fiscal-data.json', 'fiscal-documents.json', entries[0] ?? ''])
    )
    expect(manifest.counts).toMatchObject({ filesIncluded: 1, fiscalData: 1, fiscalDocuments: 1 })
    expect((await rowOf(id)).status).toBe(DsrStatus.COMPLETED)
  })

  it('goes back to review, leaving no half ZIP in the bucket, when the files pass the size of one export', async () => {
    const mine = await personOfStoreA('heavy')
    await fileOf(ctx.storeA.id, mine.customerId, 'heavy.png', Buffer.alloc(5 * 1024, 9))
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })
    jest.replaceProperty(ComplianceConfig, 'DSR_EXPORT_MAX_ZIP_BYTES', 1024)

    await runner.run()

    expect(await rowOf(id)).toMatchObject({
      status: DsrStatus.MANUAL_REVIEW,
      exportFailureCode: 'export_too_large',
      resultKey: null
    })
    expect(objects.has(StorageKeys.dsrExport(id))).toBe(false)
  })

  it('exports once and counts one try when two runs happen at the same time', async () => {
    const mine = await personOfStoreA('twice')
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })

    await Promise.all([runner.run(), runner.run()])

    expect((await rowOf(id)).exportAttempts).toBe(1)
    expect(
      audit.log.mock.calls.filter(
        call =>
          (call[0] as { action: string; resourceId?: string }).action ===
            AuditAction.DSR_EXPORT_COMPLETED &&
          (call[0] as { resourceId?: string }).resourceId === id
      )
    ).toHaveLength(1)
    expect(mails.filter(mail => mail.options.jobId === dsrResultMailJobId(id))).toHaveLength(1)
  })

  it('counts the try before the work, keeps the NAME of the error and never its message, and goes back to review after the last try', async () => {
    const mine = await personOfStoreA('fail')
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })
    failPut = true

    for (let night = 1; night <= ComplianceConfig.DSR_EXPORT_MAX_ATTEMPTS; night += 1) {
      await runner.run()
      const row = await rowOf(id)
      const last = night === ComplianceConfig.DSR_EXPORT_MAX_ATTEMPTS
      // The count of the tries is cleared when the request goes back to review: a new approval starts from zero
      expect(row.exportAttempts).toBe(last ? 0 : night)
      expect(row.exportFailureCode).toBe('export_failed')
      expect(row.status).toBe(last ? DsrStatus.MANUAL_REVIEW : DsrStatus.IN_PROGRESS)
      await releaseLease(id)
    }

    // The reviewers are told, the audit says why, nothing of the message that carried an address leaked
    expect(published.filter(item => item.event === Events.DSR_RETURNED_TO_REVIEW)).toHaveLength(1)
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.DSR_EXPORT_FAILED, resourceId: id }
      })
    ).toBe(1)
    expect(
      JSON.stringify([JSON.stringify(logger.error.mock.calls), published, audit.log.mock.calls])
    ).not.toContain('@example.com')
    expect((await rowOf(id)).resultKey).toBeNull()
    expect(mails.filter(mail => mail.options.jobId === dsrResultMailJobId(id))).toHaveLength(0)
  })

  it('goes back to review at once, without spending the other tries, for an export that is too large', async () => {
    const mine = await personOfStoreA('big')
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })
    // The constant is a literal type: the cast lowers it for this case only (restored by `jest.restoreAllMocks`)
    jest.replaceProperty(ComplianceConfig, 'DSR_EXPORT_MAX_ROWS_PER_KIND', 0 as never)

    await runner.run()

    expect(await rowOf(id)).toMatchObject({
      status: DsrStatus.MANUAL_REVIEW,
      exportFailureCode: 'export_too_large'
    })
    expect(objects.size).toBe(0)
  })

  it('gives the request back, exporting nothing, when a customer no longer has the address that asked or was erased', async () => {
    const moved = await personOfStoreA('moved')
    const erased = await personOfStoreA('erased')
    const movedId = await approvedExport({ customerIds: [moved.customerId], email: moved.email })
    const erasedId = await approvedExport({ customerIds: [erased.customerId], email: erased.email })
    await owner.customer.update({
      where: { id: moved.customerId },
      data: { email: addressOf('someone-else') }
    })
    await owner.customer.update({
      where: { id: erased.customerId },
      data: { erasedAt: new Date() }
    })

    await runner.run()

    for (const id of [movedId, erasedId]) {
      expect(await rowOf(id)).toMatchObject({
        status: DsrStatus.MANUAL_REVIEW,
        exportFailureCode: 'subject_changed',
        exportAttempts: 0,
        resultKey: null
      })
      expect(objects.has(StorageKeys.dsrExport(id))).toBe(false)
    }
  })

  it('never exports a customer of another store that the request names', async () => {
    const foreign = await customerWith(ctx.storeB.id, addressOf('foreign'), 'Foreign Person')
    const email = addressOf('claim')
    await owner.customer.update({ where: { id: foreign }, data: { email } })
    const id = await approvedExport({ customerIds: [foreign], email })

    await runner.run()

    expect(await rowOf(id)).toMatchObject({ status: DsrStatus.MANUAL_REVIEW, resultKey: null })
    expect(JSON.stringify([...objects.values()].map(String))).not.toContain('Foreign Person')
  })

  it('deletes the file when its date passes, once, and leaves a file that has not expired', async () => {
    const live = await personOfStoreA('live')
    const gone = await personOfStoreA('gone')
    const liveId = await approvedExport({ customerIds: [live.customerId], email: live.email })
    const goneId = await approvedExport({ customerIds: [gone.customerId], email: gone.email })
    await runner.run()
    await owner.dataSubjectRequest.update({
      where: { id: goneId },
      data: { resultExpiresAt: new Date(Date.now() - 1000) }
    })

    const report = await runner.run()

    expect(report.purged).toBe(1)
    expect(deleted).toEqual([StorageKeys.dsrExport(goneId)])
    expect((await rowOf(goneId)).resultKey).toBeNull()
    expect((await rowOf(liveId)).resultKey).toBe(StorageKeys.dsrExport(liveId))
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.DSR_EXPORT_PURGED, resourceId: goneId }
      })
    ).toBe(1)
    // A second run finds nothing to delete
    deleted.length = 0
    expect((await runner.run()).purged).toBe(0)
    expect(deleted).toEqual([])
  })

  it('does not clear the key when the object could not be deleted: the next run tries again', async () => {
    const mine = await personOfStoreA('stuck')
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })
    await runner.run()
    await owner.dataSubjectRequest.update({
      where: { id },
      data: { resultExpiresAt: new Date(Date.now() - 1000) }
    })
    const storage = (runner as unknown as { storage: { delete: (key: string) => Promise<void> } })
      .storage
    jest.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('bucket down'))

    await runner.run()
    expect((await rowOf(id)).resultKey).toBe(StorageKeys.dsrExport(id))

    await runner.run()
    expect((await rowOf(id)).resultKey).toBeNull()
  })

  // The collector is the second lock after the check of the customers: even when handed the id of a person of another store, or of a sibling
  // store, it reads nothing of them
  it('reads nothing of a customer that is not of the store, whatever ids it is given', async () => {
    const mine = await personOfStoreA('collect')
    const foreign = await customerWith(
      ctx.storeB.id,
      addressOf('foreign-collect'),
      'Foreign Collect'
    )
    const sibling = await customerWith(
      ctx.storeA2.id,
      addressOf('sibling-collect'),
      'Sibling Collect'
    )
    const foreignIdentity = await createCustomerIdentity(owner, {
      storeId: ctx.storeB.id,
      customerId: foreign
    })
    await createConversation(owner, {
      storeId: ctx.storeB.id,
      customerId: foreign,
      customerIdentityId: foreignIdentity.id,
      channelType: ChannelIds.INSTAGRAM
    })

    const content = await jobContext.forStore(ctx.storeA.id, () =>
      prisma.transaction(tx =>
        collectDsrExport(tx, ctx.storeA.id, [mine.customerId, foreign, sibling], {
          head: () => Promise.resolve(null),
          open: sealed => cipher.openRotating(sealed).credentials
        })
      )
    )

    const text = JSON.stringify(content.files)
    expect(text).not.toContain('Foreign Collect')
    expect(text).not.toContain('Sibling Collect')
    expect(content.counts).toMatchObject({ customers: 1, conversations: 1 })
  })

  it('deletes the file a try left behind when the request goes back to review with its tries spent', async () => {
    const mine = await personOfStoreA('orphan')
    const id = await approvedExport({
      customerIds: [mine.customerId],
      email: mine.email,
      attempts: ComplianceConfig.DSR_EXPORT_MAX_ATTEMPTS,
      attemptedAt: new Date(Date.now() - 2 * HOUR_MS)
    })
    objects.set(StorageKeys.dsrExport(id), Buffer.from('a ZIP the dead try left'))

    await runner.run()

    expect((await rowOf(id)).status).toBe(DsrStatus.MANUAL_REVIEW)
    expect(objects.has(StorageKeys.dsrExport(id))).toBe(false)
  })

  it('finds and deletes the file of an export that ended rejected or cancelled with no key, and leaves the other objects', async () => {
    const mine = await personOfStoreA('late')
    const rejected = await approvedExport({
      customerIds: [mine.customerId],
      email: mine.email,
      status: DsrStatus.REJECTED
    })
    await owner.dataSubjectRequest.update({
      where: { id: rejected },
      data: { completedAt: new Date() }
    })
    objects.set(StorageKeys.dsrExport(rejected), Buffer.from('left by a try'))
    objects.set('compliance/dsr/someone-else/export.zip', Buffer.from('not ours to touch'))

    const report = await runner.run()

    expect(report.purged).toBeGreaterThanOrEqual(1)
    expect(objects.has(StorageKeys.dsrExport(rejected))).toBe(false)
    expect(objects.has('compliance/dsr/someone-else/export.zip')).toBe(true)
  })

  it('leaves the system lines and the order summaries out of the file', async () => {
    const mine = await personOfStoreA('system')
    const conversation = await owner.conversation.findFirstOrThrow({
      where: { customerId: mine.customerId },
      select: { id: true }
    })
    await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: conversation.id,
      content: 'SYSTEM line naming Agent Smith',
      authorType: AuthorType.SYSTEM,
      type: MessageType.SYSTEM
    })
    await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId: conversation.id,
      content: 'ORDER_SUMMARY naming Agent Jones',
      authorType: AuthorType.SYSTEM,
      type: MessageType.ORDER_SUMMARY
    })
    const id = await approvedExport({ customerIds: [mine.customerId], email: mine.email })

    await runner.run()

    const text = JSON.stringify(filesOf(id))
    expect(text).not.toContain('Agent Smith')
    expect(text).not.toContain('Agent Jones')
  })
})
