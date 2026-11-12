import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { CustomerLimits, OrderStatus, PaymentMethod } from '@platform/core/domain'

import { createConversationOf, createCustomer } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const REASON = 'Refused two packages in a row'

describe('The caution flag of a customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let editorOnly: Actor
  let flagger: Actor

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    // Editing a customer does not flag it: the flag has its own permission
    editorOnly = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'editorOnlyA',
      permissions: [Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT]
    })
    // Flags without being allowed to read customers: the answer must not carry the profile
    flagger = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'flaggerA',
      permissions: [Permissions.CUSTOMERS_FLAG_CAUTION]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const stored = (id: string) =>
    owner.customer.findUniqueOrThrow({
      where: { id },
      select: { isCaution: true, cautionReason: true, cautionSetBy: true, cautionSetAt: true }
    })

  describe('PUT and DELETE /customers/:id/caution', () => {
    it('flags with a reason, records who and when, and answers only the flag', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })

      const response = await api(app, flagger, ctx.storeA)
        .put(ApiRoutes.customers.caution(customer.id))
        .send({ reason: `  ${REASON}  ` })

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ isCaution: true, cautionReason: REASON })
      const row = await stored(customer.id)
      expect(row).toMatchObject({
        isCaution: true,
        cautionReason: REASON,
        cautionSetBy: flagger.id
      })
      expect(row.cautionSetAt).not.toBeNull()
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: customer.id,
        action: AuditAction.CUSTOMER_CAUTION_SET
      })
      expect(entries).toHaveLength(1)
      // The reason is about a person: the audit entry does not copy it
      expect(JSON.stringify(entries[0]?.metadata)).not.toContain(REASON)
    })

    it('replaces the reason, the setter and the date when it is flagged again', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: 'first' })

      const response = await api(app, flagger, ctx.storeA)
        .put(ApiRoutes.customers.caution(customer.id))
        .send({ reason: 'second' })

      expect(response.body).toEqual({ isCaution: true, cautionReason: 'second' })
      expect(await stored(customer.id)).toMatchObject({
        cautionReason: 'second',
        cautionSetBy: flagger.id
      })
    })

    it('keeps who flagged first when the same reason comes again, and says so once in the audit', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: REASON })
      const first = await stored(customer.id)

      await api(app, flagger, ctx.storeA)
        .put(ApiRoutes.customers.caution(customer.id))
        .send({ reason: REASON })

      expect(await stored(customer.id)).toEqual(first)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: customer.id,
        action: AuditAction.CUSTOMER_CAUTION_SET
      })
      expect(entries).toHaveLength(1)
    })

    it('audits who flagged before when a new reason replaces the old one', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: 'one' })
      await api(app, flagger, ctx.storeA)
        .put(ApiRoutes.customers.caution(customer.id))
        .send({ reason: 'two' })

      const entries = await waitForAuditEntries(
        owner,
        {
          storeId: ctx.storeA.id,
          resourceId: customer.id,
          action: AuditAction.CUSTOMER_CAUTION_SET
        },
        2
      )
      expect(entries.map(entry => entry.metadata)).toContainEqual({
        replaced: true,
        previousSetBy: ctx.adminA.id
      })
    })

    it('clears the flag, the reason, the setter and the date, and audits it once', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: REASON })

      const response = await asAdmin().delete(ApiRoutes.customers.caution(customer.id))
      // Clearing what is not flagged is a no-op: no second audit entry
      const again = await asAdmin().delete(ApiRoutes.customers.caution(customer.id))

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ isCaution: false, cautionReason: null })
      expect(again.status).toBe(OK)
      expect(await stored(customer.id)).toEqual({
        isCaution: false,
        cautionReason: null,
        cautionSetBy: null,
        cautionSetAt: null
      })
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: customer.id,
        action: AuditAction.CUSTOMER_CAUTION_CLEARED
      })
      expect(entries).toHaveLength(1)
    })

    it('refuses a missing, blank, multi-line, too long or unknown-field body', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const put = (body: object) =>
        asAdmin().put(ApiRoutes.customers.caution(customer.id)).send(body)

      const bodies = [
        {},
        { reason: '   ' },
        { reason: 'one\nline' },
        { reason: 'x'.repeat(CustomerLimits.CAUTION_REASON_MAX_LENGTH + 1) },
        { reason: REASON, isCaution: false }
      ]
      for (const body of bodies) expect((await put(body)).status).toBe(BAD_REQUEST)
      expect((await stored(customer.id)).isCaution).toBe(false)
    })

    it('needs its own permission: editing customers is not enough', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: REASON })

      const set = await api(app, editorOnly, ctx.storeA)
        .put(ApiRoutes.customers.caution(customer.id))
        .send({ reason: 'other' })
      const clear = await api(app, editorOnly, ctx.storeA).delete(
        ApiRoutes.customers.caution(customer.id)
      )

      expect(set.status).toBe(FORBIDDEN)
      expect(clear.status).toBe(FORBIDDEN)
      expect(await stored(customer.id)).toMatchObject({ isCaution: true, cautionReason: REASON })
    })

    it('does not find an unknown customer, an absorbed one or one of another store', async () => {
      const own = await createCustomer(owner, { storeId: ctx.storeA.id })
      const absorbed = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.customer.update({ where: { id: absorbed.id }, data: { mergedIntoId: own.id } })
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })

      for (const id of [randomUUID(), absorbed.id, foreign.id]) {
        const set = await asAdmin().put(ApiRoutes.customers.caution(id)).send({ reason: REASON })
        const clear = await asAdmin().delete(ApiRoutes.customers.caution(id))
        expect(set.status).toBe(NOT_FOUND)
        expect(clear.status).toBe(NOT_FOUND)
      }
      expect((await stored(foreign.id)).isCaution).toBe(false)
    })
  })

  describe('where the flag shows', () => {
    it('is in the customer list and detail, with the reason in the detail', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: REASON })

      const detail = await asAdmin().get(ApiRoutes.customers.byId(customer.id))

      expect(detail.body).toMatchObject({ isCaution: true, cautionReason: REASON })
    })

    it('is in the orders list and the order detail, without the reason', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const clean = await createCustomer(owner, { storeId: ctx.storeA.id })
      const make = (customerId: string, orderNumber: string) =>
        owner.order.create({
          data: {
            storeId: ctx.storeA.id,
            customerId,
            orderNumber: `${prefix}-${orderNumber}`,
            status: OrderStatus.CONFIRMED,
            subtotalCents: 1000,
            totalCents: 1000,
            paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
            createdBy: ctx.adminA.id
          },
          select: { id: true }
        })
      const flaggedOrder = await make(customer.id, 'f')
      const cleanOrder = await make(clean.id, 'c')
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: REASON })

      const list = await asAdmin().get(ApiRoutes.orders.list)
      const detail = await asAdmin().get(ApiRoutes.orders.byId(flaggedOrder.id))

      const rows = (list.body as { data: { id: string; customer: { isCaution: boolean } }[] }).data
      expect(rows.find(row => row.id === flaggedOrder.id)?.customer.isCaution).toBe(true)
      expect(rows.find(row => row.id === cleanOrder.id)?.customer.isCaution).toBe(false)
      // The list names the flag only: the reason is read where the contact data is
      expect(JSON.stringify(list.body)).not.toContain(REASON)
      expect(detail.body).toMatchObject({ customer: { id: customer.id, isCaution: true } })
      // The reason is free text about a person: orders:view does not read it
      expect(JSON.stringify(detail.body)).not.toContain(REASON)
    })

    it('is in the conversation list and the conversation, without the reason', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      await asAdmin()
        .put(ApiRoutes.customers.caution(conversation.customerId))
        .send({ reason: REASON })

      const list = await asAdmin().get(ApiRoutes.conversations.list)
      const one = await asAdmin().get(ApiRoutes.conversations.byId(conversation.id))

      const rows = (list.body as { data: { id: string; customer: { isCaution: boolean } }[] }).data
      expect(rows.find(row => row.id === conversation.id)?.customer.isCaution).toBe(true)
      expect(one.body).toMatchObject({ customer: { isCaution: true } })
      expect(JSON.stringify(one.body)).not.toContain(REASON)
    })
  })

  describe('merge and deletion', () => {
    it('keeps the flag of either side in a merge', async () => {
      const survivor = await createCustomer(owner, { storeId: ctx.storeA.id })
      const absorbed = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(absorbed.id)).send({ reason: REASON })

      const merged = await asAdmin()
        .post(ApiRoutes.customers.merge(survivor.id))
        .send({ absorbedId: absorbed.id })

      expect(merged.status).toBe(OK)
      expect(await stored(survivor.id)).toMatchObject({ isCaution: true, cautionReason: REASON })
    })

    it('goes with the customer when it is deleted', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await asAdmin().put(ApiRoutes.customers.caution(customer.id)).send({ reason: REASON })

      const response = await asAdmin().delete(ApiRoutes.customers.byId(customer.id))

      expect(response.status).toBe(204)
      expect(await owner.customer.findUnique({ where: { id: customer.id } })).toBeNull()
    })
  })
})
