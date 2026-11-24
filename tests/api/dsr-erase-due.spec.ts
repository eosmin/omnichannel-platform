import { randomBytes, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  type DsrConfig,
  dsrEmailHash,
  dsrNoticeStatusOf
} from '@platform/core/compliance'
import { encrypt, parseEncryptionKey } from '@platform/core/crypto'
import { CustomerErasureService, DsrOpenWorkService } from '@platform/core/customer-erasure'
import { JobContext } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { DAY_MS, DsrStatus, DsrType } from '@platform/core/domain'
import type { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { dsrResultMailJobId, type SendEmailJob } from '@platform/core/queues'

import { DsrEraseDueSweeper } from '../../apps/worker/src/compliance/dsr-erase-due.sweeper'
import { DsrNoticeLedger } from '../../apps/worker/src/compliance/dsr-notice-ledger.service'
import { DsrNoticeSender } from '../../apps/worker/src/compliance/dsr-notice-sender.service'
import { createCustomer, createOrder } from '../builders'
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

// Step 7.2-H2b-1: the sweep that carries out the approved erasures whose grace period ended, against the REAL database as the (guarded)
// role of the worker and the REAL erasure service. Two stores have people with the same address; the cases prove who is erased, who is not,
// that a try is counted before the work, that the person is told once, and that a request that cannot be carried out goes back to review.
describe('the sweep of the data erasures that are due', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sweeper: DsrEraseDueSweeper
  let erasure: CustomerErasureService
  let ledger: DsrNoticeLedger
  const published: { event: string; payload: unknown }[] = []
  const mails: Call[] = []
  const jobs: unknown[] = []
  let failMail = false
  // The real service writes the rows (in the transaction of the work); the spy only records what was asked
  let realAudit: AuditService
  const audit = {
    log: jest.fn<void, [Parameters<AuditService['log']>[0]]>(entry => realAudit.log(entry))
  }
  const logger = { setContext: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([])
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = createGuardedWorkerPrisma()
    realAudit = new AuditService(prisma, logger as unknown as PinoLogger)
    const queueOf = <T>(calls: T[]) => ({
      add: (name: string, data: unknown, options: unknown) => {
        calls.push({ name, data, options } as T)
        return Promise.resolve()
      }
    })
    const mailQueue = {
      add: (name: string, data: SendEmailJob, options: { jobId?: string }) => {
        if (failMail) return Promise.reject(new Error('queue is down'))
        mails.push({ name, data, options })
        return Promise.resolve()
      }
    }
    erasure = new CustomerErasureService(
      prisma,
      audit as unknown as AuditService,
      { publish: jest.fn() } as unknown as DomainEvents,
      queueOf(jobs) as unknown as never,
      logger as unknown as PinoLogger
    )
    const events = {
      publish: (_tx: unknown, event: string, payload: unknown) => {
        published.push({ event, payload })
      }
    } as unknown as DomainEvents
    const jobContext = new JobContext(prisma)
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
    sweeper = new DsrEraseDueSweeper(
      prisma,
      jobContext,
      audit as unknown as AuditService,
      erasure,
      new DsrOpenWorkService(),
      sender,
      events,
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
    mails.length = 0
    jobs.length = 0
    published.length = 0
    failMail = false
    audit.log.mockClear()
    logger.error.mockClear()
    jest.restoreAllMocks()
  })

  const addressOf = (name: string): string =>
    `${prefix}-${name}-${randomUUID().slice(0, 6)}@example.com`

  async function customerWith(storeId: string, email: string | null): Promise<string> {
    const customer = await createCustomer(owner, { storeId })
    if (email !== null) await owner.customer.update({ where: { id: customer.id }, data: { email } })
    return customer.id
  }

  // A request as the approval leaves it: in progress, its date reached (unless said otherwise)
  async function approvedRequest(input: {
    storeId: string
    organizationId: string
    customerIds: string[]
    email: string
    type?: string
    status?: string
    erasureDueAt?: Date | null
    attempts?: number
    attemptedAt?: Date | null
    noticeLocale?: string | null
  }): Promise<string> {
    const row = await owner.dataSubjectRequest.create({
      data: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        type: input.type ?? DsrType.ERASURE,
        status: input.status ?? DsrStatus.IN_PROGRESS,
        subjectType: 'customer',
        subjectEmailHash: dsrEmailHash(input.email, CONFIG.hashKey),
        subjectCustomerIds: input.customerIds,
        notifyToEncrypted: encrypt(input.email, parseEncryptionKey(CONFIG.encryptionKeyHex)),
        approvals: [{ userId: ctx.adminA.id, at: new Date().toISOString() }],
        verifiedAt: new Date(),
        deadlineAt: new Date(Date.now() + 30 * DAY_MS),
        erasureDueAt:
          input.erasureDueAt === undefined ? new Date(Date.now() - HOUR_MS) : input.erasureDueAt,
        erasureAttempts: input.attempts ?? 0,
        erasureAttemptedAt: input.attemptedAt ?? null,
        noticeLocale: input.noticeLocale ?? null
      },
      select: { id: true }
    })
    return row.id
  }
  const requestOfStoreA = async (
    emails: string[],
    overrides: Partial<Parameters<typeof approvedRequest>[0]> = {}
  ): Promise<{ id: string; customerIds: string[]; email: string }> => {
    // The request names every customer of the store that had the address: all of them hold the first one
    const email = emails[0] ?? ''
    const customerIds: string[] = []
    for (let index = 0; index < emails.length; index += 1) {
      customerIds.push(await customerWith(ctx.storeA.id, email))
    }
    const id = await approvedRequest({
      storeId: ctx.storeA.id,
      organizationId: ctx.orgA.id,
      customerIds,
      email,
      ...overrides
    })
    return { id, customerIds, email }
  }

  const rowOf = (id: string) => owner.dataSubjectRequest.findUniqueOrThrow({ where: { id } })
  const customerOf = (id: string) => owner.customer.findUniqueOrThrow({ where: { id } })
  const erasedCount = async (ids: string[]): Promise<number> =>
    owner.customer.count({ where: { id: { in: ids }, erasedAt: { not: null } } })
  // Every run of a test starts from a request nobody holds: the lease of a try is an hour
  const releaseLease = (id: string) =>
    owner.dataSubjectRequest.update({
      where: { id },
      data: { erasureAttemptedAt: new Date(Date.now() - 2 * HOUR_MS) }
    })

  it('erases the customers of a due request in its own store only, ends it, and tells the person once', async () => {
    const email = addressOf('ana')
    const mine = await requestOfStoreA([email])
    // The same address in the sibling store and in another organization: they asked for nothing
    const sibling = await customerWith(ctx.storeA2.id, email)
    const other = await customerWith(ctx.storeB.id, email)
    await createOrder(owner, { storeId: ctx.storeA.id, status: 'DELIVERED', paymentStatus: 'PAID' })
    const bystanderOrder = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'DELIVERED',
      paymentStatus: 'PAID'
    })
    await owner.order.update({
      where: { id: bystanderOrder.id },
      data: { customerId: mine.customerIds[0] ?? '' }
    })
    // A fiscal document of that order, with its masked receiver: the erasure keeps it whole and the summary counts it
    const document = await owner.fiscalDocument.create({
      data: {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        orderId: bystanderOrder.id,
        sequenceNumber: 1_000_000 + Math.floor(Math.random() * 1_000_000_000),
        documentType: 'pending',
        status: 'accepted',
        providerId: 'simulator',
        environment: 'sandbox',
        issuerSnapshot: {},
        linesSnapshot: { lines: [] },
        receiverEncrypted: new Uint8Array(Buffer.concat([Buffer.from([1]), randomBytes(40)])),
        receiverNameMasked: 'A***********',
        receiverTaxIdMasked: '********1011',
        receiverMaskedAt: new Date(),
        totalCents: 1000,
        taxCents: 0
      },
      select: { id: true }
    })

    const report = await sweeper.run()

    expect(report.failed).toBe(0)
    expect(report.completed).toBeGreaterThanOrEqual(1)
    expect((await customerOf(mine.customerIds[0] ?? '')).erasedAt).not.toBeNull()
    expect((await customerOf(mine.customerIds[0] ?? '')).email).toBeNull()
    expect((await customerOf(sibling)).erasedAt).toBeNull()
    expect((await customerOf(other)).erasedAt).toBeNull()
    expect((await customerOf(sibling)).email).toBe(email)

    const row = await rowOf(mine.id)
    expect(row).toMatchObject({
      status: DsrStatus.COMPLETED,
      subjectEmailHash: null,
      erasureFailureCode: null,
      erasureAttempts: 1
    })
    expect(row.completedAt).not.toBeNull()
    // The sealed address STAYS until the mail processor confirms the send: a mail that is queued is not a mail that was sent (H2b-2)
    expect(row.notifyToEncrypted).not.toBeNull()
    expect(row.noticeSentAt).toBeNull()
    expect(row.retainedRecordsSummary).toEqual({
      legalBasis: 'legal_obligation',
      orders: 1,
      conversations: 0,
      fiscalDocuments: 1
    })
    // The decided document is kept as it was, masks included: the legal obligation, written in the summary
    expect(
      await owner.fiscalDocument.findUniqueOrThrow({ where: { id: document.id } })
    ).toMatchObject({
      receiverNameMasked: 'A***********',
      receiverTaxIdMasked: '********1011',
      status: 'accepted'
    })
    // One mail, to the address that asked, once, for the retained order
    const toThem = mails.filter(mail => [mail.data.to].flat().includes(email))
    expect(toThem).toHaveLength(1)
    expect(toThem[0]?.data.data).toEqual({
      outcome: 'completed',
      requestType: 'erasure',
      retainedOrders: 1
    })
    expect(toThem[0]?.options.jobId).toBe(dsrResultMailJobId(mine.id))
    // The job carries the ids the processor needs to confirm it, and the address nowhere but `to`
    expect(toThem[0]?.data.dsrNotice).toEqual({ requestId: mine.id, storeId: ctx.storeA.id })
    expect(JSON.stringify({ ...toThem[0]?.data, to: null })).not.toContain('@example.com')
    // The mail names no customer, no store data and no request id: the address it goes to, the kind and one count
    expect(Object.keys(toThem[0]?.data.data ?? {}).sort()).toEqual([
      'outcome',
      'requestType',
      'retainedOrders'
    ])
    expect(JSON.stringify(toThem[0]?.data)).not.toContain(mine.customerIds[0] ?? 'x')
    // The audit holds the request and counts, the actor is the system, and no address or name
    const entries = audit.log.mock.calls.map(call => call[0])
    expect(entries.filter(e => e.action === AuditAction.DSR_ERASURE_COMPLETED)).toHaveLength(1)
    expect(
      entries.filter(
        e => e.action === AuditAction.CUSTOMER_ERASED && JSON.stringify(e).includes(mine.id)
      )
    ).toHaveLength(1)
    for (const entry of entries) {
      if (entry.action === AuditAction.CUSTOMER_ERASED)
        expect(entry.actor).toEqual({ system: true })
    }
    expect(JSON.stringify(entries)).not.toContain('@example.com')
    // The rows are in the database, written with the commit (no waiting for a detached write)
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.CUSTOMER_ERASED, resourceId: mine.customerIds[0] ?? '' }
      })
    ).toBe(1)
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.DSR_ERASURE_COMPLETED, resourceId: mine.id }
      })
    ).toBe(1)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('@example.com')
  })

  it('never takes a request that is not due, not in progress, not an erasure, or without a date', async () => {
    const cases = {
      notDue: await requestOfStoreA([addressOf('a')], {
        erasureDueAt: new Date(Date.now() + DAY_MS)
      }),
      noDate: await requestOfStoreA([addressOf('b')], { erasureDueAt: null }),
      review: await requestOfStoreA([addressOf('c')], { status: DsrStatus.MANUAL_REVIEW }),
      done: await requestOfStoreA([addressOf('d')], { status: DsrStatus.COMPLETED }),
      cancelled: await requestOfStoreA([addressOf('e')], { status: DsrStatus.CANCELLED }),
      access: await requestOfStoreA([addressOf('f')], { type: DsrType.ACCESS })
    }

    await sweeper.run()

    for (const { id, customerIds } of Object.values(cases)) {
      expect(await erasedCount(customerIds)).toBe(0)
      expect((await rowOf(id)).erasureAttempts).toBe(0)
    }
  })

  it('does not execute a request that was cancelled between the list and the claim', async () => {
    const mine = await requestOfStoreA([addressOf('cancel')])
    const real = (
      sweeper as unknown as { candidatesOf: (s: string, n: Date) => Promise<string[]> }
    ).candidatesOf.bind(sweeper)
    jest
      .spyOn(sweeper as unknown as { candidatesOf: typeof real }, 'candidatesOf')
      .mockImplementation(async (storeId, now) => {
        const listed = await real(storeId, now)
        // The reviewer cancels right after the list was read
        await owner.dataSubjectRequest.update({
          where: { id: mine.id },
          data: { status: DsrStatus.CANCELLED, erasureDueAt: null }
        })
        return listed
      })

    await sweeper.run()

    expect(await erasedCount(mine.customerIds)).toBe(0)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.CANCELLED,
      erasureAttempts: 0
    })
  })

  it('writes the closing mail in the language the person asked in, and in the language of the store when none was kept', async () => {
    // The store speaks Spanish: a request that asked in English must get English, one with no language (or one this build does not
    // speak) must fall to the store, never to the default of the build
    const store = await owner.store.findUniqueOrThrow({
      where: { id: ctx.storeA.id },
      select: { defaultLocale: true }
    })
    await owner.store.update({ where: { id: ctx.storeA.id }, data: { defaultLocale: 'es' } })
    try {
      const asked = await requestOfStoreA([addressOf('lang-en')], { noticeLocale: 'en' })
      const unset = await requestOfStoreA([addressOf('lang-null')], { noticeLocale: null })
      const unknown = await requestOfStoreA([addressOf('lang-xx')], { noticeLocale: 'xx' })

      const report = await sweeper.run()

      expect(report.failed).toBe(0)
      const localeOf = (request: { id: string }) =>
        mails.find(mail => mail.options.jobId === dsrResultMailJobId(request.id))?.data.locale
      expect(localeOf(asked)).toBe('en')
      expect(localeOf(unset)).toBe('es')
      expect(localeOf(unknown)).toBe('es')
    } finally {
      await owner.store.update({
        where: { id: ctx.storeA.id },
        data: { defaultLocale: store.defaultLocale }
      })
    }
  })

  it('erases once and counts one try when two sweeps run at the same time', async () => {
    const mine = await requestOfStoreA([addressOf('twice')])

    await Promise.all([sweeper.run(), sweeper.run()])

    expect(await erasedCount(mine.customerIds)).toBe(1)
    expect((await rowOf(mine.id)).erasureAttempts).toBe(1)
    expect(mails.filter(mail => mail.options.jobId === dsrResultMailJobId(mine.id))).toHaveLength(1)
    const erased = audit.log.mock.calls.filter(
      call => (call[0] as { action: string }).action === AuditAction.CUSTOMER_ERASED
    )
    expect(erased).toHaveLength(1)
  })

  it('counts the try before the work, keeps the name of the error and not its message, and gives the request back after the last try', async () => {
    const mine = await requestOfStoreA([addressOf('boom')])
    jest
      .spyOn(erasure, 'erase')
      .mockRejectedValue(new TypeError(`cannot erase ${mine.email} Ana Quintanilla`))

    const first = await sweeper.run()

    expect(first.failed).toBe(1)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.IN_PROGRESS,
      erasureAttempts: 1,
      erasureFailureCode: 'TypeError'
    })
    // The try keeps the request for an hour: the same night's second run does not count another
    await sweeper.run()
    expect((await rowOf(mine.id)).erasureAttempts).toBe(1)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Quintanilla')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('@example.com')

    for (let attempt = 2; attempt <= ComplianceConfig.DSR_ERASE_MAX_ATTEMPTS; attempt += 1) {
      await releaseLease(mine.id)
      await sweeper.run()
    }

    // After the last try: back to the review queue, the grace period and the approvals cleared, nothing erased, the person not told
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.MANUAL_REVIEW,
      erasureDueAt: null,
      approvals: [],
      erasureAttempts: ComplianceConfig.DSR_ERASE_MAX_ATTEMPTS,
      erasureFailureCode: 'TypeError'
    })
    expect((await rowOf(mine.id)).notifyToEncrypted).not.toBeNull()
    expect(await erasedCount(mine.customerIds)).toBe(0)
    expect(mails).toHaveLength(0)
    const returned = audit.log.mock.calls.filter(
      call => (call[0] as { action: string }).action === AuditAction.DSR_ERASURE_RETURNED
    )
    expect(returned).toHaveLength(1)
    expect(JSON.stringify(returned)).not.toContain('@example.com')
    // It is not a candidate any more
    await releaseLease(mine.id)
    jest.restoreAllMocks()
    await sweeper.run()
    expect((await rowOf(mine.id)).status).toBe(DsrStatus.MANUAL_REVIEW)
  })

  it('gives back a request whose last try killed the process (tries spent, no one recorded the failure)', async () => {
    const mine = await requestOfStoreA([addressOf('crash')], {
      attempts: ComplianceConfig.DSR_ERASE_MAX_ATTEMPTS,
      attemptedAt: new Date(Date.now() - 2 * HOUR_MS)
    })

    const report = await sweeper.run()

    expect(report.returned).toBeGreaterThanOrEqual(1)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.MANUAL_REVIEW,
      erasureDueAt: null,
      erasureFailureCode: 'attempts_exhausted'
    })
    expect(await erasedCount(mine.customerIds)).toBe(0)
  })

  it('finishes a request that was half done: the customer already erased counts, the other is erased', async () => {
    const mine = await requestOfStoreA([addressOf('one'), addressOf('two')])
    const [first, second] = mine.customerIds as [string, string]
    await owner.customer.update({
      where: { id: first },
      data: { erasedAt: new Date(), email: null, name: '[erased]' }
    })
    const erase = jest.spyOn(erasure, 'erase')

    await sweeper.run()

    expect(erase).toHaveBeenCalledTimes(1)
    expect(erase.mock.calls[0]?.[1]).toBe(second)
    expect(await erasedCount(mine.customerIds)).toBe(2)
    expect((await rowOf(mine.id)).status).toBe(DsrStatus.COMPLETED)
  })

  it('gives the request back, erasing no one, when a customer no longer has the address that asked', async () => {
    const mine = await requestOfStoreA([addressOf('one'), addressOf('two')])
    await owner.customer.update({
      where: { id: mine.customerIds[1] ?? '' },
      data: { email: addressOf('someone-else') }
    })

    await sweeper.run()

    expect(await erasedCount(mine.customerIds)).toBe(0)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.MANUAL_REVIEW,
      erasureDueAt: null,
      approvals: [],
      erasureFailureCode: 'subject_changed'
    })
    expect(mails).toHaveLength(0)
  })

  it('gives the request back, erasing no one, when work opened after the approval', async () => {
    const mine = await requestOfStoreA([addressOf('open'), addressOf('open2')])
    // An order of the second customer appears between the approval and the sweep
    const order = await createOrder(owner, { storeId: ctx.storeA.id })
    await owner.order.update({
      where: { id: order.id },
      data: { customerId: mine.customerIds[1] ?? '', status: 'CONFIRMED' }
    })

    await sweeper.run()

    expect(await erasedCount(mine.customerIds)).toBe(0)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.MANUAL_REVIEW,
      erasureDueAt: null,
      erasureFailureCode: 'blocked_by_open_work',
      erasureAttempts: 0,
      erasureAttemptedAt: null
    })
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.DSR_ERASURE_RETURNED, resourceId: mine.id }
      })
    ).toBe(1)
    const returned = audit.log.mock.calls
      .map(call => call[0] as { action: string; metadata?: { openWork?: { orders: number } } })
      .find(entry => entry.action === AuditAction.DSR_ERASURE_RETURNED)
    expect(returned?.metadata?.openWork?.orders).toBe(1)
  })

  it('ends the erasure even when the closing mail cannot be queued, keeps the address, and sends the mail the next night', async () => {
    const mine = await requestOfStoreA([addressOf('mail')])
    failMail = true

    const first = await sweeper.run()

    // The erasure is committed (the mail is only queued after it, so it never announces what rolled back)
    expect(first.completed).toBe(1)
    expect(first.failed).toBe(1)
    expect(await erasedCount(mine.customerIds)).toBe(1)
    const waiting = await rowOf(mine.id)
    expect(waiting.status).toBe(DsrStatus.COMPLETED)
    expect(waiting.notifyToEncrypted).not.toBeNull()
    expect(waiting.subjectEmailHash).toBeNull()
    expect(mails).toHaveLength(0)

    failMail = false
    const second = await sweeper.run()

    expect(second.notified).toBe(1)
    expect(second.completed).toBe(0)
    // The address stays until the mail processor confirms the send (the notice is queued, not sent)
    expect((await rowOf(mine.id)).notifyToEncrypted).not.toBeNull()
    expect(mails).toHaveLength(1)
    // Nothing more the third night: the mail is on its way (the lease), so it is not queued again
    await sweeper.run()
    expect(mails).toHaveLength(1)
  })

  it('erases no one when the erasure of a later customer fails: the first one is rolled back with the rest', async () => {
    const mine = await requestOfStoreA([addressOf('half'), addressOf('half')])
    // The sweep erases them in id order: the one that fails is the last, so the first was erased for real before the failure
    const [, late] = [...mine.customerIds].sort() as [string, string]
    const real = erasure.erase.bind(erasure)
    jest.spyOn(erasure, 'erase').mockImplementation(async (storeId, customerId, actor) => {
      const view = await real(storeId, customerId, actor)
      if (customerId === late) throw new TypeError('the last one failed')
      return view
    })

    const report = await sweeper.run()

    expect(report.failed).toBe(1)
    expect(await erasedCount(mine.customerIds)).toBe(0)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.IN_PROGRESS,
      erasureFailureCode: 'TypeError'
    })
    // The erasure of the first customer was audited inside the transaction that rolled back: no row says someone was erased
    expect(
      await owner.auditLog.count({
        where: {
          action: AuditAction.CUSTOMER_ERASED,
          resourceId: { in: mine.customerIds }
        }
      })
    ).toBe(0)
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.DSR_ERASURE_COMPLETED, resourceId: mine.id }
      })
    ).toBe(0)
  })

  it('gives the request back without spending its tries when a merge into a customer can still be undone', async () => {
    const mine = await requestOfStoreA([addressOf('merged')])
    const absorbed = await customerWith(ctx.storeA.id, null)
    await owner.customerMerge.create({
      data: {
        storeId: ctx.storeA.id,
        survivorId: mine.customerIds[0] ?? '',
        absorbedId: absorbed,
        snapshot: {},
        mergedById: ctx.adminA.id,
        unmergeUntil: new Date(Date.now() + 3 * DAY_MS)
      }
    })
    const erase = jest.spyOn(erasure, 'erase')

    await sweeper.run()

    expect(erase).not.toHaveBeenCalled()
    expect(await erasedCount(mine.customerIds)).toBe(0)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.MANUAL_REVIEW,
      erasureDueAt: null,
      erasureFailureCode: 'undoable_merge',
      erasureAttempts: 0
    })
  })

  it('gives back the try of a request it could not take because a reviewer took its row after the claim', async () => {
    const mine = await requestOfStoreA([addressOf('locked')])
    type Claim = (storeId: string, requestId: string, now: Date) => Promise<boolean>
    const internals = sweeper as unknown as { claim: Claim }
    const realClaim = internals.claim.bind(sweeper)
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let holder: Promise<unknown> = Promise.resolve()
    jest.spyOn(internals, 'claim').mockImplementation(async (storeId, requestId, now) => {
      const claimed = await realClaim(storeId, requestId, now)
      if (requestId === mine.id) {
        // A reviewer opens a decision on the row between the claim and the work
        // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
        holder = owner.$transaction(
          async tx => {
            await tx.$queryRaw`SELECT id FROM data_subject_requests WHERE id = ${mine.id} FOR UPDATE`
            await held
          },
          { timeout: 120_000 }
        )
        await new Promise(resolve => setTimeout(resolve, 500))
        // The reviewer finishes a little later: giving the try back waits for the row, like any other write
        setTimeout(release, 2000)
      }
      return claimed
    })

    const report = await sweeper.run()
    await holder

    expect(report.skipped).toBeGreaterThanOrEqual(1)
    expect(await erasedCount(mine.customerIds)).toBe(0)
    expect(await rowOf(mine.id)).toMatchObject({
      status: DsrStatus.IN_PROGRESS,
      erasureAttempts: 0,
      erasureAttemptedAt: null
    })
  })

  it('erases without a mail when the sealed address cannot be opened, and still ends the request', async () => {
    const mine = await requestOfStoreA([addressOf('seal')])
    await owner.dataSubjectRequest.update({
      where: { id: mine.id },
      data: { notifyToEncrypted: Buffer.from('not a sealed address') }
    })

    await sweeper.run()

    const ended = await rowOf(mine.id)
    expect(ended.status).toBe(DsrStatus.COMPLETED)
    // The person could not be told, and that is SAID: the address is gone, the notice is marked failed and the reviewers are told (H2b-2)
    expect(ended.notifyToEncrypted).toBeNull()
    expect(ended.noticeFailedAt).not.toBeNull()
    expect(dsrNoticeStatusOf(ended)).toBe('failed')
    expect(published.filter(item => item.event === Events.DSR_NOTICE_FAILED)).toHaveLength(1)
    // No mail to the address that asked (the sweep also takes what earlier cases left due)
    expect(mails.filter(mail => [mail.data.to].flat().includes(mine.email))).toHaveLength(0)
  })

  describe('the closing notice is confirmed by the mail processor, never assumed', () => {
    it('keeps the sealed address until the notice is confirmed, then clears it', async () => {
      const mine = await requestOfStoreA([addressOf('confirm')])
      await sweeper.run()
      expect((await rowOf(mine.id)).notifyToEncrypted).not.toBeNull()

      await ledger.sent(ctx.storeA.id, mine.id)

      const row = await rowOf(mine.id)
      expect(row.notifyToEncrypted).toBeNull()
      expect(row.noticeSentAt).not.toBeNull()
      expect(dsrNoticeStatusOf(row)).toBe('sent')
      // A confirmed notice is never queued again
      mails.length = 0
      await sweeper.run()
      expect(mails.filter(mail => mail.options.jobId === dsrResultMailJobId(mine.id))).toHaveLength(
        0
      )
    })

    const backdateQueued = (id: string, hours: number) =>
      owner.dataSubjectRequest.update({
        where: { id },
        data: { noticeQueuedAt: new Date(Date.now() - hours * HOUR_MS) }
      })

    it('counts every queueing, asks for the mail again after each failure, and gives the person up visibly after the last one', async () => {
      const mine = await requestOfStoreA([addressOf('retry')])
      await sweeper.run()
      mails.length = 0

      for (let night = 1; night < ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS; night += 1) {
        // The first queueing counted one; the processor says the mail failed all its attempts
        await ledger.failed(ctx.storeA.id, mine.id, 'mail_failed')
        const waiting = await rowOf(mine.id)
        expect(waiting.noticeAttempts).toBe(night)
        expect(dsrNoticeStatusOf(waiting)).toBe('pending')
        expect(published.filter(item => item.event === Events.DSR_NOTICE_FAILED)).toHaveLength(0)
        await sweeper.run()
        expect(
          mails.filter(mail => mail.options.jobId === dsrResultMailJobId(mine.id))
        ).toHaveLength(night)
      }

      await ledger.failed(ctx.storeA.id, mine.id, 'mail_failed')
      const row = await rowOf(mine.id)
      expect(row.notifyToEncrypted).toBeNull()
      expect(row.noticeAttempts).toBe(ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS)
      expect(dsrNoticeStatusOf(row)).toBe('failed')
      expect(published.filter(item => item.event === Events.DSR_NOTICE_FAILED)).toHaveLength(1)
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.DSR_NOTICE_FAILED, resourceId: mine.id }
        })
      ).toBe(1)
      mails.length = 0
      await sweeper.run()
      expect(mails.filter(mail => mail.options.jobId === dsrResultMailJobId(mine.id))).toHaveLength(
        0
      )
      expect(JSON.stringify(published)).not.toContain('@example.com')
    })

    it('gives up a notice whose job never reached the processor (nothing confirmed or failed it) after the tries and the stale hours, and says so once', async () => {
      const mine = await requestOfStoreA([addressOf('lost')])
      await sweeper.run()
      // The job vanished each time (a stalled job, a payload the processor refused): the lease runs out and the sweep queues it again, counting
      for (let night = 2; night <= ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS; night += 1) {
        await backdateQueued(mine.id, 2)
        await sweeper.run()
        expect((await rowOf(mine.id)).noticeAttempts).toBe(night)
      }
      expect(dsrNoticeStatusOf(await rowOf(mine.id))).toBe('pending')

      // Tries spent and a day without an answer: given up, with the event
      await backdateQueued(mine.id, ComplianceConfig.DSR_NOTICE_STALE_HOURS + 1)
      mails.length = 0
      await sweeper.run()

      const row = await rowOf(mine.id)
      expect(dsrNoticeStatusOf(row)).toBe('failed')
      expect(row.notifyToEncrypted).toBeNull()
      expect(mails.filter(mail => mail.options.jobId === dsrResultMailJobId(mine.id))).toHaveLength(
        0
      )
      expect(published.filter(item => item.event === Events.DSR_NOTICE_FAILED)).toHaveLength(1)
      await sweeper.run()
      expect(published.filter(item => item.event === Events.DSR_NOTICE_FAILED)).toHaveLength(1)
    })

    it('gives up the notice of a rejection (no address left) that was queued and never answered', async () => {
      const mine = await requestOfStoreA([addressOf('rejected')])
      await owner.dataSubjectRequest.update({
        where: { id: mine.id },
        data: {
          status: DsrStatus.REJECTED,
          notifyToEncrypted: null,
          erasureDueAt: null,
          completedAt: new Date(),
          noticeAttempts: 1,
          noticeQueuedAt: new Date(
            Date.now() - (ComplianceConfig.DSR_NOTICE_STALE_HOURS + 1) * HOUR_MS
          )
        }
      })
      expect(dsrNoticeStatusOf(await rowOf(mine.id))).toBe('pending')

      await sweeper.run()

      expect(dsrNoticeStatusOf(await rowOf(mine.id))).toBe('failed')
      expect(published.filter(item => item.event === Events.DSR_NOTICE_FAILED)).toHaveLength(1)
    })

    it('queues a notice that a queue that was down left unsent, on the next night, once', async () => {
      const mine = await requestOfStoreA([addressOf('down')])
      failMail = true
      await sweeper.run()
      expect(await erasedCount(mine.customerIds)).toBe(1)
      expect((await rowOf(mine.id)).notifyToEncrypted).not.toBeNull()

      failMail = false
      await sweeper.run()

      expect(mails.filter(mail => mail.options.jobId === dsrResultMailJobId(mine.id))).toHaveLength(
        1
      )
    })

    it('does not mark a request twice, and a late failure after the confirmation changes nothing', async () => {
      const mine = await requestOfStoreA([addressOf('late')])
      await sweeper.run()
      await ledger.sent(ctx.storeA.id, mine.id)

      await ledger.failed(ctx.storeA.id, mine.id, 'mail_failed')

      const row = await rowOf(mine.id)
      expect(row.noticeFailedAt).toBeNull()
      // Only the queueing was counted: a late failure changes nothing
      expect(row.noticeAttempts).toBe(1)
      expect(dsrNoticeStatusOf(row)).toBe('sent')
      expect(published.filter(item => item.event === Events.DSR_NOTICE_FAILED)).toHaveLength(0)
    })
  })
})
