import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { ComplianceConfig } from '@platform/core/compliance'
import type { OwnerClient } from '@platform/core/database-testing'

import {
  createConversationOf,
  createCustomer,
  createCustomerIdentity,
  createCustomerMerge,
  createOrder
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

// The name, the address and the phone of a person: none of them may be copied into the audit entry
const NAME = 'Maria Elena Quintanilla'
const EMAIL = 'maria.quintanilla@example.com'
const PHONE_DIGITS = '50370001234'
const HANDLE = 'ig-maria-quintanilla'
const NOTE = 'Prefers calls after six'
const REASON = 'Refused two packages in a row'

describe('The erasure of a customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let editorOnly: Actor
  let eraser: Actor

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    // Editing and deleting a customer is not erasing one: the erasure has its own permission
    editorOnly = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'editorOnlyErasure',
      permissions: [
        Permissions.CUSTOMERS_VIEW,
        Permissions.CUSTOMERS_EDIT,
        Permissions.CUSTOMERS_DELETE
      ]
    })
    eraser = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'eraserA',
      permissions: [Permissions.CUSTOMERS_ERASE]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const erase = (actor: Actor, id: string) =>
    api(app, actor, ctx.storeA).post(ApiRoutes.customers.erasure(id)).send({})
  const eraser_ = (id: string) => erase(eraser, id)

  // A customer with everything a person leaves in the store: contact data, a caution, a channel handle with
  // its profile, a note, an address, a consent and fiscal data
  async function fullCustomer(): Promise<{ id: string; identityId: string }> {
    const customer = await createCustomer(owner, { storeId: ctx.storeA.id, name: NAME })
    await owner.customer.update({
      where: { id: customer.id },
      data: {
        email: EMAIL,
        phone: '+503 7000 1234',
        phoneNormalized: PHONE_DIGITS,
        locale: 'es',
        isCaution: true,
        cautionReason: REASON,
        cautionSetBy: ctx.adminA.id,
        cautionSetAt: new Date()
      }
    })
    const identity = await createCustomerIdentity(owner, {
      storeId: ctx.storeA.id,
      customerId: customer.id,
      handle: HANDLE
    })
    await owner.customerIdentity.update({
      where: { id: identity.id },
      data: {
        displayName: NAME,
        username: 'maria.q',
        avatarUrl: 'https://cdn.example.com/maria.jpg',
        channelMetadata: { profile: NAME }
      }
    })
    await owner.customerNote.create({
      data: { customerId: customer.id, authorId: ctx.adminA.id, content: NOTE }
    })
    await owner.address.create({
      data: { customerId: customer.id, line1: '5 Calle Poniente', city: 'San Salvador' }
    })
    await owner.consentRecord.create({
      data: {
        storeId: ctx.storeA.id,
        customerId: customer.id,
        purpose: 'marketing',
        legalBasis: 'consent',
        granted: true,
        grantedAt: new Date(),
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        source: 'test'
      }
    })
    await owner.customerFiscalData.create({
      data: {
        storeId: ctx.storeA.id,
        customerId: customer.id,
        dataEncrypted: Buffer.from('sealed-fixture')
      }
    })
    return { id: customer.id, identityId: identity.id }
  }

  describe('POST /customers/:id/erasure', () => {
    it('blanks the personal data of the customer and of everything that hangs from it', async () => {
      const customer = await fullCustomer()

      const response = await eraser_(customer.id)

      expect(response.status).toBe(OK)
      const row = await owner.customer.findUniqueOrThrow({ where: { id: customer.id } })
      expect(row).toMatchObject({
        name: ComplianceConfig.ERASED_CONTENT_PLACEHOLDER,
        email: null,
        phone: null,
        phoneNormalized: null,
        locale: null,
        cautionReason: null,
        cautionSetBy: null,
        cautionSetAt: null
      })
      expect(row.erasedAt).not.toBeNull()
      // The handle is no longer the person's: a new message from it makes a new customer
      const identity = await owner.customerIdentity.findUniqueOrThrow({
        where: { id: customer.identityId }
      })
      expect(identity.channelIdentity).not.toBe(HANDLE)
      expect(identity).toMatchObject({
        displayName: null,
        username: null,
        avatarUrl: null,
        channelMetadata: null
      })
      expect(
        await owner.customerIdentity.count({
          where: { storeId: ctx.storeA.id, channelIdentity: HANDLE }
        })
      ).toBe(0)
      expect(await owner.customerNote.count({ where: { customerId: customer.id } })).toBe(0)
      expect(await owner.address.count({ where: { customerId: customer.id } })).toBe(0)
      expect(await owner.customerFiscalData.count({ where: { customerId: customer.id } })).toBe(0)
      // The consent stays as proof, revoked, with no address or browser of the person
      const consents = await owner.consentRecord.findMany({ where: { customerId: customer.id } })
      expect(consents).toHaveLength(1)
      expect(consents[0]).toMatchObject({ ipAddress: null, userAgent: null })
      expect(consents[0]?.revokedAt).not.toBeNull()
    })

    it('answers what it did and what it kept, with no personal data', async () => {
      const customer = await fullCustomer()

      const response = await eraser_(customer.id)

      expect(response.body).toMatchObject({
        erased: true,
        deleted: { notes: 1, addresses: 1, fiscalData: 1 },
        anonymized: { identities: 1, consents: 1 }
      })
      for (const personal of [NAME, EMAIL, PHONE_DIGITS, HANDLE, NOTE, REASON]) {
        expect(JSON.stringify(response.body)).not.toContain(personal)
      }
    })

    it('keeps the orders and the conversations of the customer, which the law and the books need', async () => {
      const customer = await fullCustomer()
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      await owner.order.update({ where: { id: order.id }, data: { customerId: customer.id } })
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      await owner.conversation.update({
        where: { id: conversation.id },
        data: { customerId: customer.id, customerIdentityId: customer.identityId }
      })

      const response = await eraser_(customer.id)

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ retained: { orders: 1, conversations: 1 } })
      expect((await owner.order.findUniqueOrThrow({ where: { id: order.id } })).customerId).toBe(
        customer.id
      )
      expect(
        (await owner.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).customerId
      ).toBe(customer.id)
    })

    it('is audited once, with counts and no personal data', async () => {
      const customer = await fullCustomer()

      await eraser_(customer.id)

      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: customer.id,
        action: AuditAction.CUSTOMER_ERASED
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.userId).toBe(eraser.id)
      for (const personal of [NAME, EMAIL, PHONE_DIGITS, HANDLE, NOTE, REASON]) {
        expect(JSON.stringify(entries[0]?.metadata)).not.toContain(personal)
      }
      expect(entries[0]?.metadata).toMatchObject({ deleted: { notes: 1 } })
    })

    it('answers the same again for a customer already erased, and changes and audits nothing more', async () => {
      const customer = await fullCustomer()
      await eraser_(customer.id)
      const first = await owner.customer.findUniqueOrThrow({
        where: { id: customer.id },
        select: { erasedAt: true }
      })

      const again = await eraser_(customer.id)

      expect(again.status).toBe(OK)
      expect(again.body).toMatchObject({ erased: true })
      const second = await owner.customer.findUniqueOrThrow({
        where: { id: customer.id },
        select: { erasedAt: true }
      })
      expect(second.erasedAt).toEqual(first.erasedAt)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: customer.id,
        action: AuditAction.CUSTOMER_ERASED
      })
      expect(entries).toHaveLength(1)
    })

    it('takes the personal data out of a merge that is past its window, and refuses one that can still be undone', async () => {
      const merge = await createCustomerMerge(owner, { storeId: ctx.storeA.id })
      await owner.customer.update({
        where: { id: merge.survivorId },
        data: { name: NAME, email: EMAIL }
      })
      await owner.customerMerge.update({
        where: { id: merge.id },
        data: {
          snapshot: {
            survivorBefore: { name: NAME, email: EMAIL },
            survivorAfter: { name: NAME, email: EMAIL },
            survivorTagIdsBefore: [],
            absorbedTagIds: [],
            identityIds: [],
            conversationIds: [],
            orderIds: [],
            addressIds: [],
            defaultedAddressIds: [],
            noteIds: [],
            mediaIds: [],
            consentIds: [],
            fieldChoices: {}
          }
        }
      })

      const refused = await eraser_(merge.survivorId)
      expect(refused.status).toBe(CONFLICT)
      expect(
        (await owner.customer.findUniqueOrThrow({ where: { id: merge.survivorId } })).erasedAt
      ).toBeNull()

      // The time to undo has passed: what the merge remembers of the survivor is personal data too
      await owner.customerMerge.update({
        where: { id: merge.id },
        data: { unmergeUntil: new Date(Date.now() - 60_000) }
      })
      const done = await eraser_(merge.survivorId)

      expect(done.status).toBe(OK)
      const kept = await owner.customerMerge.findUniqueOrThrow({ where: { id: merge.id } })
      expect(JSON.stringify(kept.snapshot)).not.toContain(NAME)
      expect(JSON.stringify(kept.snapshot)).not.toContain(EMAIL)
    })

    it('needs customers:erase: who edits or deletes customers cannot', async () => {
      const customer = await fullCustomer()

      const refused = await erase(editorOnly, customer.id)

      expect(refused.status).toBe(FORBIDDEN)
      expect(
        (await owner.customer.findUniqueOrThrow({ where: { id: customer.id } })).erasedAt
      ).toBeNull()
      expect((await erase(ctx.adminA, customer.id)).status).toBe(OK)
    })

    it('does not exist for a customer of another store, and leaves it as it was', async () => {
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id, name: NAME })

      const response = await erase(ctx.adminA, foreign.id)

      // The same answer as for a customer that does not exist
      expect(response.status).toBe(NOT_FOUND)
      expect((await owner.customer.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(
        NAME
      )
    })

    it('does not exist for an unknown customer', async () => {
      expect((await erase(ctx.adminA, randomUUID())).status).toBe(NOT_FOUND)
    })

    it('hides the erased customer from the list of customers', async () => {
      const customer = await fullCustomer()
      const before = await asAdmin().get(ApiRoutes.customers.list)
      expect(JSON.stringify(before.body)).toContain(customer.id)

      await eraser_(customer.id)

      const list = await asAdmin().get(ApiRoutes.customers.list)
      expect(list.status).toBe(OK)
      expect(JSON.stringify(list.body)).not.toContain(customer.id)
    })

    it('tells the profile and the conversation that the customer was erased, which the web draws as read only', async () => {
      const customer = await fullCustomer()
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      await owner.conversation.update({
        where: { id: conversation.id },
        data: { customerId: customer.id, customerIdentityId: customer.identityId }
      })
      const profileBefore = await asAdmin().get(ApiRoutes.customers.byId(customer.id))
      const threadBefore = await asAdmin().get(ApiRoutes.conversations.byId(conversation.id))
      expect(profileBefore.body).toMatchObject({ erasedAt: null })
      expect(threadBefore.body).toMatchObject({ customer: { isErased: false } })

      await eraser_(customer.id)

      const profile = await asAdmin().get(ApiRoutes.customers.byId(customer.id))
      const thread = await asAdmin().get(ApiRoutes.conversations.byId(conversation.id))
      expect(profile.status).toBe(OK)
      expect(typeof (profile.body as { erasedAt: unknown }).erasedAt).toBe('string')
      expect(thread.body).toMatchObject({ customer: { isErased: true } })
    })

    it('refuses every later write on the erased customer, so no personal data comes back', async () => {
      const customer = await fullCustomer()
      await eraser_(customer.id)

      const edit = await asAdmin()
        .patch(ApiRoutes.customers.byId(customer.id))
        .send({ name: NAME, email: EMAIL })
      const note = await asAdmin()
        .post(ApiRoutes.customers.notes(customer.id))
        .send({ content: NOTE })
      const flag = await asAdmin()
        .put(ApiRoutes.customers.caution(customer.id))
        .send({ reason: REASON })

      for (const response of [edit, note, flag]) expect(response.status).toBe(CONFLICT)
      const row = await owner.customer.findUniqueOrThrow({ where: { id: customer.id } })
      expect(row).toMatchObject({
        name: ComplianceConfig.ERASED_CONTENT_PLACEHOLDER,
        email: null,
        cautionReason: null
      })
      expect(await owner.customerNote.count({ where: { customerId: customer.id } })).toBe(0)
    })

    it('empties the values of a merge snapshot that does not follow the current shape too', async () => {
      const merge = await createCustomerMerge(owner, { storeId: ctx.storeA.id })
      await owner.customerMerge.update({
        where: { id: merge.id },
        data: {
          unmergeUntil: new Date(Date.now() - 60_000),
          // Written by an older version: no lists of ids, only the values
          snapshot: { survivorBefore: { name: NAME }, survivorAfter: { email: EMAIL } }
        }
      })

      const done = await eraser_(merge.survivorId)

      expect(done.status).toBe(OK)
      const kept = await owner.customerMerge.findUniqueOrThrow({ where: { id: merge.id } })
      expect(JSON.stringify(kept.snapshot)).not.toContain(NAME)
      expect(JSON.stringify(kept.snapshot)).not.toContain(EMAIL)
    })
  })
})
