import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  dsrEmailHash
} from '@platform/core/compliance'
import { encrypt, parseEncryptionKey } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import { DAY_MS, DsrStatus, DsrType, OrderStatus, PaymentStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { EmailTemplates } from '@platform/core/queues'

import { DSR_EXECUTOR_PROBE } from '../../apps/api/src/modules/compliance/dsr-review.service'
import { createCustomer, createOrder } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { emailsOf } from '../helpers/email'
import { type Actor, api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const REASON = 'Identity checked against the order of March, Ana Quintanilla'

interface ErrorBody {
  error?: { code?: string; metadata?: Record<string, unknown> }
}

// Step 7.2-H1b: the review queue of the data requests, through the real app (guards, pipes, interceptors) and the real database, as the api
// runs. The people and the stores are real rows; only the queue of mail and the answer of "is there an executor" are the ports under control.
describe('The review queue of the data requests', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let config: DsrConfig
  let secondAdmin: Actor
  let viewOnly: Actor
  // What the executor probe answers: the sweep of H2b does not exist yet, so a case turns it on to see the rest of the approval
  let executor = true

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(DSR_EXECUTOR_PROBE).useValue(() => executor)
    )
    ctx = await seedTestContext(owner, app, prefix)
    config = app.get<DsrConfig>(DSR_CONFIG, { strict: false })
    const adminRole = ctx.roleIds[RoleNames.ADMIN]
    secondAdmin = await createActor(owner, app, {
      prefix,
      name: 'secondAdminA',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: adminRole
    })
    viewOnly = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'viewOnlyDsr',
      permissions: [Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_ERASE]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    executor = true
    emailsOf(app).clear()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const addressOf = (name: string): string =>
    `${prefix}-${name}-${randomUUID().slice(0, 6)}@example.com`

  // A customer of the store with an address, as the owner
  async function customerWith(storeId: string, email: string): Promise<string> {
    const customer = await createCustomer(owner, { storeId })
    await owner.customer.update({ where: { id: customer.id }, data: { email } })
    return customer.id
  }

  // A request in a state, for the customers given, written as the intake and the verification would have left it
  async function requestOf(input: {
    storeId: string
    organizationId: string
    customerIds: string[]
    email: string
    type?: string
    status?: string
    requestedBy?: string
    erasureDueAt?: Date
  }): Promise<string> {
    const row = await owner.dataSubjectRequest.create({
      data: {
        organizationId: input.organizationId,
        storeId: input.storeId,
        type: input.type ?? DsrType.ERASURE,
        status: input.status ?? DsrStatus.MANUAL_REVIEW,
        subjectType: 'customer',
        subjectEmailHash: dsrEmailHash(input.email, config.hashKey),
        subjectCustomerIds: input.customerIds,
        notifyToEncrypted: encrypt(input.email, parseEncryptionKey(config.encryptionKeyHex)),
        ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
        ...(input.erasureDueAt === undefined ? {} : { erasureDueAt: input.erasureDueAt }),
        verifiedAt: new Date(),
        deadlineAt: new Date(Date.now() + 30 * DAY_MS)
      },
      select: { id: true }
    })
    return row.id
  }

  // A fresh person of store A with a request in review
  async function inReview(
    overrides: { type?: string; status?: string; requestedBy?: string; erasureDueAt?: Date } = {}
  ): Promise<{ id: string; customerId: string; email: string }> {
    const email = addressOf('ana')
    const customerId = await customerWith(ctx.storeA.id, email)
    const id = await requestOf({
      storeId: ctx.storeA.id,
      organizationId: ctx.orgA.id,
      customerIds: [customerId],
      email,
      ...overrides
    })
    return { id, customerId, email }
  }

  const rowOf = (id: string) => owner.dataSubjectRequest.findUniqueOrThrow({ where: { id } })
  const approve = (
    id: string,
    actor: Actor = ctx.adminA,
    body: object = { confirm: true, reason: REASON }
  ) => api(app, actor, ctx.storeA).post(ApiRoutes.compliance.dsrApprove(id)).send(body)
  const reject = (id: string, actor: Actor = ctx.adminA) =>
    api(app, actor, ctx.storeA).post(ApiRoutes.compliance.dsrReject(id)).send({ reason: REASON })
  const cancel = (id: string, actor: Actor = ctx.adminA) =>
    api(app, actor, ctx.storeA).post(ApiRoutes.compliance.dsrCancel(id)).send({ reason: REASON })
  const codeOf = (body: unknown): string | undefined => (body as ErrorBody).error?.code

  describe('who may read and decide', () => {
    it('refuses the routes to a member without customers:dsr_review', async () => {
      const { id } = await inReview()
      for (const response of [
        await api(app, viewOnly, ctx.storeA).get(ApiRoutes.compliance.dsr),
        await api(app, viewOnly, ctx.storeA).get(ApiRoutes.compliance.dsrById(id)),
        await approve(id, viewOnly),
        await reject(id, viewOnly),
        await cancel(id, viewOnly)
      ]) {
        expect(response.status).toBe(FORBIDDEN)
      }
      expect((await rowOf(id)).status).toBe(DsrStatus.MANUAL_REVIEW)
    })

    it('lists the requests of the store of the request and no other, and finds none by the id of another', async () => {
      const mine = await inReview()
      const otherEmail = addressOf('bea')
      const theirs = await requestOf({
        storeId: ctx.storeB.id,
        organizationId: ctx.orgB.id,
        customerIds: [await customerWith(ctx.storeB.id, otherEmail)],
        email: otherEmail
      })
      const siblingEmail = addressOf('cris')
      const sibling = await requestOf({
        storeId: ctx.storeA2.id,
        organizationId: ctx.orgA.id,
        customerIds: [await customerWith(ctx.storeA2.id, siblingEmail)],
        email: siblingEmail
      })

      const listed = await asAdmin().get(ApiRoutes.compliance.dsr).query({ limit: 100 })
      expect(listed.status).toBe(OK)
      const ids = (listed.body as { data: { id: string }[] }).data.map(item => item.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs)
      expect(ids).not.toContain(sibling)
      // The answer holds no address and no name
      expect(JSON.stringify(listed.body)).not.toContain(mine.email)

      // Another organization and a sibling store of the same organization: the same 404 as an id that does not exist
      for (const id of [theirs, sibling, randomUUID()]) {
        const response = await asAdmin().get(ApiRoutes.compliance.dsrById(id))
        expect(response.status).toBe(NOT_FOUND)
      }
      // A page cursor that names a request of another store finds no position, and no row
      const paged = await asAdmin().get(ApiRoutes.compliance.dsr).query({ cursor: theirs })
      expect((paged.body as { data: unknown[] }).data).toEqual([])
    })

    it('pages by the date, newest first, and filters by status and kind', async () => {
      const first = await inReview({ type: DsrType.ACCESS })
      const second = await inReview({ type: DsrType.ACCESS })
      const page = await asAdmin()
        .get(ApiRoutes.compliance.dsr)
        .query({ type: DsrType.ACCESS, status: DsrStatus.MANUAL_REVIEW, limit: 1 })
      const body = page.body as { data: { id: string }[]; nextCursor: string | null }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]?.id).toBe(second.id)
      expect(body.nextCursor).toBe(second.id)
      const next = await asAdmin().get(ApiRoutes.compliance.dsr).query({
        type: DsrType.ACCESS,
        status: DsrStatus.MANUAL_REVIEW,
        limit: 1,
        cursor: second.id
      })
      expect((next.body as { data: { id: string }[] }).data[0]?.id).toBe(first.id)
    })
  })

  describe('approving', () => {
    it('starts the grace period of an erasure, records who approved, touches no customer and keeps the person out of the audit entry', async () => {
      const { id, customerId, email } = await inReview()
      const before = Date.now()

      const response = await approve(id)

      expect(response.status).toBe(OK)
      const row = await rowOf(id)
      expect(row.status).toBe(DsrStatus.IN_PROGRESS)
      expect(row.reviewedBy).toBe(ctx.adminA.id)
      expect(row.notes).toBe(REASON)
      expect(row.approvals).toMatchObject([{ userId: ctx.adminA.id }])
      const due = row.erasureDueAt?.getTime() ?? 0
      expect(due).toBeGreaterThanOrEqual(
        before + ComplianceConfig.ERASURE_GRACE_PERIOD_DAYS * DAY_MS - 1000
      )
      expect(due).toBeLessThanOrEqual(
        Date.now() + ComplianceConfig.ERASURE_GRACE_PERIOD_DAYS * DAY_MS
      )
      // Approving erases nothing: the sweep of H2b does, after the grace period
      const customer = await owner.customer.findUniqueOrThrow({ where: { id: customerId } })
      expect(customer.erasedAt).toBeNull()
      expect(customer.email).toBe(email)

      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.DSR_APPROVED,
        resourceId: id
      })
      expect(entry).toBeDefined()
      const text = JSON.stringify(entry)
      for (const secret of [email, REASON, 'Quintanilla']) expect(text).not.toContain(secret)
    })

    it('says 409 DSR_EXECUTOR_UNAVAILABLE while nothing carries out an approval, and for a kind that erases nothing', async () => {
      executor = false
      const erasure = await inReview()
      const unavailable = await approve(erasure.id)
      expect(unavailable.status).toBe(CONFLICT)
      expect(codeOf(unavailable.body)).toBe(ErrorCodes.DSR_EXECUTOR_UNAVAILABLE)
      expect((await rowOf(erasure.id)).status).toBe(DsrStatus.MANUAL_REVIEW)

      executor = true
      const access = await inReview({ type: DsrType.ACCESS })
      const noExecutor = await approve(access.id)
      expect(noExecutor.status).toBe(CONFLICT)
      expect(codeOf(noExecutor.body)).toBe(ErrorCodes.DSR_EXECUTOR_UNAVAILABLE)
    })

    it('needs the written confirmation and a reason, and reads nothing else from the body', async () => {
      const { id } = await inReview()
      for (const body of [
        {},
        { reason: REASON },
        { confirm: true },
        { confirm: false, reason: REASON },
        { confirm: true, reason: '   ' },
        { confirm: true, reason: 'x'.repeat(ComplianceConfig.DSR_REVIEW_REASON_MAX_LENGTH + 1) },
        { confirm: true, reason: REASON, storeId: ctx.storeB.id }
      ]) {
        const response = await approve(id, ctx.adminA, body)
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect((await rowOf(id)).status).toBe(DsrStatus.MANUAL_REVIEW)
    })

    it('takes the decision only from a request in review: a pending, an approved and an ended one answer 409', async () => {
      const pending = await inReview({ status: DsrStatus.PENDING_VERIFICATION })
      const approved = await inReview({ status: DsrStatus.IN_PROGRESS })
      const done = await inReview({ status: DsrStatus.COMPLETED })
      const ended = await inReview({ status: DsrStatus.REJECTED })
      const expected: [string, string][] = [
        [pending.id, ErrorCodes.DSR_NOT_REVIEWABLE],
        [approved.id, ErrorCodes.DSR_NOT_REVIEWABLE],
        [done.id, ErrorCodes.DSR_ALREADY_COMPLETED],
        [ended.id, ErrorCodes.DSR_ALREADY_COMPLETED]
      ]
      for (const [id, code] of expected) {
        for (const response of [await approve(id), await reject(id)]) {
          expect(response.status).toBe(CONFLICT)
          expect(codeOf(response.body)).toBe(code)
        }
      }
    })

    it('does not let the admin who made the request approve it, and lets another one', async () => {
      const own = await inReview({ requestedBy: ctx.adminA.id })
      const refused = await approve(own.id)
      expect(refused.status).toBe(FORBIDDEN)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      expect((await rowOf(own.id)).status).toBe(DsrStatus.MANUAL_REVIEW)

      const accepted = await approve(own.id, secondAdmin)
      expect(accepted.status).toBe(OK)
      expect((await rowOf(own.id)).reviewedBy).toBe(secondAdmin.id)
    })

    it('goes back to review (409 DSR_SUBJECT_CHANGED) when the customer no longer is the person: another address, erased, or gone', async () => {
      const moved = await inReview()
      await owner.customer.update({
        where: { id: moved.customerId },
        data: { email: addressOf('other') }
      })
      const erased = await inReview()
      await owner.customer.update({
        where: { id: erased.customerId },
        data: { erasedAt: new Date() }
      })
      const emptied = await inReview()
      await owner.customer.update({ where: { id: emptied.customerId }, data: { email: null } })

      for (const { id } of [moved, erased, emptied]) {
        const response = await approve(id)
        expect(response.status).toBe(CONFLICT)
        expect(codeOf(response.body)).toBe(ErrorCodes.DSR_SUBJECT_CHANGED)
        const row = await rowOf(id)
        expect(row.status).toBe(DsrStatus.MANUAL_REVIEW)
        expect(row.erasureDueAt).toBeNull()
      }
    })

    it('still sees the address when it is written with other capitals or spaces around it', async () => {
      const email = addressOf('mixed')
      const customerId = await customerWith(ctx.storeA.id, `  ${email.toUpperCase()}  `)
      const id = await requestOf({
        storeId: ctx.storeA.id,
        organizationId: ctx.orgA.id,
        customerIds: [customerId],
        email
      })
      expect((await approve(id)).status).toBe(OK)
    })

    it('is blocked by open work of THESE customers, with the counts, and by none of another store', async () => {
      const { id, customerId } = await inReview()
      // An open order and a delivered order that was never paid: both belong to this customer
      const open = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.CONFIRMED
      })
      await owner.order.update({ where: { id: open.id }, data: { customerId } })
      const unpaid = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.PENDING
      })
      await owner.order.update({ where: { id: unpaid.id }, data: { customerId } })

      const blocked = await approve(id)

      expect(blocked.status).toBe(CONFLICT)
      expect(codeOf(blocked.body)).toBe(ErrorCodes.DSR_BLOCKED_BY_OPEN_WORK)
      expect((blocked.body as ErrorBody).error?.metadata).toMatchObject({
        orders: 1,
        receivables: 1
      })
      expect((await rowOf(id)).status).toBe(DsrStatus.MANUAL_REVIEW)

      // The same person's address in another store, with an open order there: it does not block the request of store A
      const email = addressOf('dana')
      const here = await customerWith(ctx.storeA.id, email)
      const there = await customerWith(ctx.storeB.id, email)
      const theirOrder = await createOrder(owner, {
        storeId: ctx.storeB.id,
        status: OrderStatus.CONFIRMED
      })
      await owner.order.update({ where: { id: theirOrder.id }, data: { customerId: there } })
      const clean = await requestOf({
        storeId: ctx.storeA.id,
        organizationId: ctx.orgA.id,
        customerIds: [here],
        email
      })
      expect((await approve(clean)).status).toBe(OK)
    })

    it('lets a finished order, shipped and delivered long ago and paid, go: only open work blocks', async () => {
      const { id, customerId } = await inReview()
      const done = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.COMPLETED
      })
      await owner.order.update({ where: { id: done.id }, data: { customerId } })
      expect((await approve(id)).status).toBe(OK)
    })

    it('shows the open work in the detail of an erasure that has not ended', async () => {
      const { id, customerId } = await inReview()
      const open = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.PREPARING
      })
      await owner.order.update({ where: { id: open.id }, data: { customerId } })

      const detail = await asAdmin().get(ApiRoutes.compliance.dsrById(id))

      expect(detail.status).toBe(OK)
      expect((detail.body as { openWork: unknown }).openWork).toMatchObject({ orders: 1 })
    })
  })

  describe('rejecting and cancelling', () => {
    it('rejects with the reason, tells the person once, and leaves neither the address nor its hash', async () => {
      const { id, customerId, email } = await inReview()

      const response = await reject(id)

      expect(response.status).toBe(OK)
      const row = await rowOf(id)
      expect(row.status).toBe(DsrStatus.REJECTED)
      expect(row.notifyToEncrypted).toBeNull()
      expect(row.subjectEmailHash).toBeNull()
      expect(row.notes).toBe(REASON)
      expect(row.reviewedBy).toBe(ctx.adminA.id)
      const mails = emailsOf(app).to(email)
      expect(mails).toHaveLength(1)
      expect(mails[0]).toMatchObject({
        template: EmailTemplates.DSR_RESULT,
        data: { outcome: 'rejected', requestType: DsrType.ERASURE }
      })
      expect(
        (await owner.customer.findUniqueOrThrow({ where: { id: customerId } })).erasedAt
      ).toBeNull()
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.DSR_REJECTED,
        resourceId: id
      })
      expect(JSON.stringify(entry)).not.toContain(REASON)

      // A second rejection is terminal: 409, and no second mail
      const again = await reject(id)
      expect(again.status).toBe(CONFLICT)
      expect(codeOf(again.body)).toBe(ErrorCodes.DSR_ALREADY_COMPLETED)
      expect(emailsOf(app).to(email)).toHaveLength(1)
    })

    it('changes nothing when the mail cannot be queued: the request stays in review with its address, and the reviewer can try again', async () => {
      const { id, email } = await inReview()
      const queue = emailsOf(app)
      const spy = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('queue is down'))

      const failed = await reject(id)
      spy.mockRestore()

      expect(failed.status).toBeGreaterThanOrEqual(500)
      const row = await rowOf(id)
      expect(row.status).toBe(DsrStatus.MANUAL_REVIEW)
      expect(row.notifyToEncrypted).not.toBeNull()
      expect(row.subjectEmailHash).not.toBeNull()
      expect((await reject(id)).status).toBe(OK)
      expect(queue.to(email)).toHaveLength(1)
    })

    it('cancels an approved erasure during its grace period and tells the person', async () => {
      const { id, email } = await inReview()
      expect((await approve(id)).status).toBe(OK)

      const response = await cancel(id)

      expect(response.status).toBe(OK)
      const row = await rowOf(id)
      expect(row.status).toBe(DsrStatus.CANCELLED)
      expect(row.erasureDueAt).toBeNull()
      expect(row.notifyToEncrypted).toBeNull()
      expect(row.subjectEmailHash).toBeNull()
      expect(emailsOf(app).to(email)).toHaveLength(1)
      await waitForAuditEntries(owner, { action: AuditAction.DSR_CANCELLED, resourceId: id })
    })

    it('cancels nothing that is not an approved erasure still inside its grace period', async () => {
      const inReviewOnly = await inReview()
      const late = await inReview({
        status: DsrStatus.IN_PROGRESS,
        erasureDueAt: new Date(Date.now() - 1000)
      })
      const done = await inReview({ status: DsrStatus.COMPLETED })
      const expected: [string, string][] = [
        [inReviewOnly.id, ErrorCodes.DSR_NOT_REVIEWABLE],
        [late.id, ErrorCodes.DSR_NOT_REVIEWABLE],
        [done.id, ErrorCodes.DSR_ALREADY_COMPLETED]
      ]
      for (const [id, code] of expected) {
        const response = await cancel(id)
        expect(response.status).toBe(CONFLICT)
        expect(codeOf(response.body)).toBe(code)
      }
      expect((await rowOf(late.id)).status).toBe(DsrStatus.IN_PROGRESS)
      expect(emailsOf(app).jobs).toHaveLength(0)
    })

    it('lets exactly one of two cancels win, and mails the person once', async () => {
      const { id, email } = await inReview({
        status: DsrStatus.IN_PROGRESS,
        erasureDueAt: new Date(Date.now() + DAY_MS)
      })

      const [first, second] = await Promise.all([cancel(id), cancel(id, secondAdmin)])

      expect([first.status, second.status].sort()).toEqual([OK, CONFLICT])
      expect(emailsOf(app).to(email)).toHaveLength(1)
      expect((await rowOf(id)).status).toBe(DsrStatus.CANCELLED)
    })

    it('lets exactly one of an approval and a rejection at the same time win', async () => {
      const { id, email } = await inReview()

      const [approval, rejection] = await Promise.all([approve(id), reject(id, secondAdmin)])

      expect([approval.status, rejection.status].sort()).toEqual([OK, CONFLICT])
      const row = await rowOf(id)
      if (approval.status === OK) {
        expect(row.status).toBe(DsrStatus.IN_PROGRESS)
        expect(emailsOf(app).to(email)).toHaveLength(0)
      } else {
        expect(row.status).toBe(DsrStatus.REJECTED)
        expect(row.erasureDueAt).toBeNull()
        expect(emailsOf(app).to(email)).toHaveLength(1)
      }
    })
  })

  it('names no customer data in a customer that another reviewer just created: a customer created later is not part of the request', async () => {
    const { id, email } = await inReview()
    // The same address on a customer made after the request: the request names the ones it had, and approving does not widen it
    const later = await customerWith(ctx.storeA.id, email)
    expect((await approve(id)).status).toBe(OK)
    expect((await rowOf(id)).subjectCustomerIds).not.toContain(later)
  })
})
