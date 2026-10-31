import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelType, ConversationStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createConversation, createCustomer, createCustomerIdentity, createTag } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface Entry {
  type: string
  id: string
  at: string
  authorName?: string | null
  content?: string
  status?: string
}
interface Page {
  data: Entry[]
  nextCursor: string | null
  hasMore: boolean
}
interface PreviewBody {
  counts: Record<string, { survivor: number; absorbed: number; merged: number }>
  conflicts: string[]
  error?: { code: string }
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const HOUR_MS = 3_600_000

describe('The activity of a customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const storeId = (): string => ctx.storeA.id
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)

  async function customerWithConversation(
    input: { status?: ConversationStatus; assignedTo?: string | null } = {}
  ) {
    const customer = await createCustomer(owner, { storeId: storeId() })
    const identity = await createCustomerIdentity(owner, {
      storeId: storeId(),
      customerId: customer.id,
      channelType: ChannelType.INSTAGRAM
    })
    const conversation = await createConversation(owner, {
      storeId: storeId(),
      customerId: customer.id,
      customerIdentityId: identity.id,
      channelType: ChannelType.INSTAGRAM,
      ...input
    })
    return { customer, identity, conversation }
  }

  describe('GET /customers/:id/timeline', () => {
    it('mixes conversations, notes and merges, the newest first, with the name of who wrote a note', async () => {
      const { customer, conversation } = await customerWithConversation()
      const note = await owner.customerNote.create({
        data: {
          customerId: customer.id,
          authorId: ctx.adminA.id,
          content: 'VIP',
          createdAt: new Date(Date.now() + HOUR_MS)
        }
      })

      const response = await asAdmin().get(ApiRoutes.customers.timeline(customer.id))

      expect(response.status).toBe(OK)
      const page = response.body as Page
      expect(page.data.map(entry => [entry.type, entry.id])).toEqual([
        ['note', note.id],
        ['conversation', conversation.id]
      ])
      expect(page.data[0]?.authorName).toEqual(expect.any(String))
      expect(page.hasMore).toBe(false)
    })

    it('pages by cursor without repeating or skipping an entry, and filters by type', async () => {
      const { customer } = await customerWithConversation()
      for (let index = 0; index < 3; index += 1) {
        await owner.customerNote.create({
          data: {
            customerId: customer.id,
            authorId: ctx.adminA.id,
            content: `note ${index}`,
            createdAt: new Date(Date.now() - index * HOUR_MS)
          }
        })
      }

      const first = (
        await asAdmin().get(ApiRoutes.customers.timeline(customer.id)).query({ limit: 2 })
      ).body as Page
      const second = (
        await asAdmin()
          .get(ApiRoutes.customers.timeline(customer.id))
          .query({ limit: 2, cursor: first.nextCursor })
      ).body as Page
      const notesOnly = (
        await asAdmin().get(ApiRoutes.customers.timeline(customer.id)).query({ type: 'note' })
      ).body as Page

      expect(first.hasMore).toBe(true)
      expect(second.hasMore).toBe(false)
      const ids = [...first.data, ...second.data].map(entry => entry.id)
      expect(new Set(ids).size).toBe(4)
      expect(notesOnly.data).toHaveLength(3)
      expect(notesOnly.data.every(entry => entry.type === 'note')).toBe(true)
    })

    it('shows a merge of the customer with who made it and until when it can be undone', async () => {
      const survivor = await createCustomer(owner, { storeId: storeId() })
      const absorbed = await createCustomer(owner, { storeId: storeId() })

      const merged = await asAdmin()
        .post(ApiRoutes.customers.merge(survivor.id))
        .send({ absorbedId: absorbed.id })
      const response = await asAdmin().get(ApiRoutes.customers.timeline(survivor.id))

      expect(merged.status).toBe(OK)
      const entry = (response.body as Page).data.find(item => item.type === 'merge')
      expect(entry).toMatchObject({ absorbedId: absorbed.id, unmergedAt: null })
    })

    it('leaves out the conversations the viewer may not see and the ones that are hidden', async () => {
      const { customer, conversation } = await customerWithConversation()
      const other = await createConversation(owner, {
        storeId: storeId(),
        customerId: customer.id,
        customerIdentityId: (
          await createCustomerIdentity(owner, { storeId: storeId(), customerId: customer.id })
        ).id,
        channelType: ChannelType.INSTAGRAM,
        assignedTo: ctx.adminA.id
      })
      const spam = await createConversation(owner, {
        storeId: storeId(),
        customerId: customer.id,
        customerIdentityId: (
          await createCustomerIdentity(owner, { storeId: storeId(), customerId: customer.id })
        ).id,
        channelType: ChannelType.INSTAGRAM,
        status: ConversationStatus.SPAM
      })

      const asOwner = (await asAdmin().get(ApiRoutes.customers.timeline(customer.id))).body as Page
      const asAgentBody = (await asAgent().get(ApiRoutes.customers.timeline(customer.id)))
        .body as Page

      const adminIds = asOwner.data.map(entry => entry.id)
      expect(adminIds).toEqual(expect.arrayContaining([conversation.id, other.id]))
      const agentIds = asAgentBody.data.map(entry => entry.id)
      expect(agentIds).toContain(conversation.id)
      expect(agentIds).not.toContain(other.id)
      expect(agentIds).not.toContain(spam.id)
    })

    it('answers 404 for a customer that does not exist, is absorbed, or is another store', async () => {
      const survivor = await createCustomer(owner, { storeId: storeId() })
      const absorbed = await createCustomer(owner, { storeId: storeId() })
      await asAdmin().post(ApiRoutes.customers.merge(survivor.id)).send({ absorbedId: absorbed.id })
      const stranger = await createCustomer(owner, { storeId: ctx.storeB.id })

      for (const id of [absorbed.id, stranger.id, '7f5c0f0e-0000-4000-8000-000000000000']) {
        const response = await asAdmin().get(ApiRoutes.customers.timeline(id))
        expect(response.status).toBe(NOT_FOUND)
      }
    })

    it('refuses a malformed cursor', async () => {
      const { customer } = await customerWithConversation()
      const bad = await asAdmin()
        .get(ApiRoutes.customers.timeline(customer.id))
        .query({ cursor: 'nope' })

      expect(bad.status).toBe(BAD_REQUEST)
    })
  })

  describe('GET /customers/:id/conversations', () => {
    it('lists the conversations of that customer only, with the visibility of the inbox', async () => {
      const mine = await customerWithConversation()
      await customerWithConversation()
      await createConversation(owner, {
        storeId: storeId(),
        customerId: mine.customer.id,
        customerIdentityId: mine.identity.id,
        channelType: ChannelType.INSTAGRAM,
        assignedTo: ctx.adminA.id
      })

      const admin = (await asAdmin().get(ApiRoutes.customers.conversations(mine.customer.id)))
        .body as { data: { id: string }[] }
      const agent = (await asAgent().get(ApiRoutes.customers.conversations(mine.customer.id)))
        .body as { data: { id: string }[] }

      expect(admin.data).toHaveLength(2)
      expect(agent.data.map(row => row.id)).toEqual([mine.conversation.id])
    })

    it('refuses countsOnly, which is the business of GET /conversations', async () => {
      const { customer } = await customerWithConversation()

      const response = await asAdmin()
        .get(ApiRoutes.customers.conversations(customer.id))
        .query({ countsOnly: 'true' })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('answers 404 for a customer of another store', async () => {
      const stranger = await createCustomer(owner, { storeId: ctx.storeB.id })

      const response = await asAdmin().get(ApiRoutes.customers.conversations(stranger.id))

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('GET /customers/:id/merge-preview', () => {
    it('counts what each side has and what the merged customer would have', async () => {
      const a = await customerWithConversation()
      const b = await customerWithConversation()
      await owner.customerNote.create({
        data: { customerId: b.customer.id, authorId: ctx.adminA.id, content: 'x' }
      })
      const shared = await createTag(owner, { storeId: storeId() })
      const own = await createTag(owner, { storeId: storeId() })
      await owner.customer.update({
        where: { id: a.customer.id },
        data: { tags: { connect: [{ id: shared.id }] } }
      })
      await owner.customer.update({
        where: { id: b.customer.id },
        data: { tags: { connect: [{ id: shared.id }, { id: own.id }] } }
      })

      const response = await asAdmin()
        .get(ApiRoutes.customers.mergePreview(a.customer.id))
        .query({ absorbedId: b.customer.id })

      expect(response.status).toBe(OK)
      const body = response.body as PreviewBody
      expect(body.counts.conversations).toEqual({ survivor: 1, absorbed: 1, merged: 2 })
      expect(body.counts.notes).toEqual({ survivor: 0, absorbed: 1, merged: 1 })
      expect(body.counts.tags).toEqual({ survivor: 1, absorbed: 2, merged: 2 })
      expect(body.counts.identities).toEqual({ survivor: 1, absorbed: 1, merged: 2 })
      // Both have a different generated name
      expect(body.conflicts).toEqual(['name'])
    })

    it('does not call a conflict the same email in another case or the same phone written another way', async () => {
      const a = await owner.customer.create({
        data: {
          storeId: storeId(),
          name: 'Ana',
          email: 'Ana@Example.com',
          phone: '+503 7000 0000',
          phoneNormalized: '50370000000'
        }
      })
      const b = await owner.customer.create({
        data: {
          storeId: storeId(),
          name: 'Ana',
          email: 'ana@example.com',
          phone: '+50370000000',
          phoneNormalized: '50370000000'
        }
      })

      const response = await asAdmin()
        .get(ApiRoutes.customers.mergePreview(a.id))
        .query({ absorbedId: b.id })

      expect((response.body as PreviewBody).conflicts).toEqual([])
    })

    it('writes nothing', async () => {
      const a = await createCustomer(owner, { storeId: storeId() })
      const b = await createCustomer(owner, { storeId: storeId() })

      await asAdmin().get(ApiRoutes.customers.mergePreview(a.id)).query({ absorbedId: b.id })

      expect(
        (await owner.customer.findUnique({ where: { id: b.id }, select: { mergedIntoId: true } }))
          ?.mergedIntoId
      ).toBeNull()
      expect(await owner.customerMerge.count({ where: { survivorId: a.id } })).toBe(0)
    })

    it('refuses a customer merged with itself and a missing or malformed absorbedId', async () => {
      const a = await createCustomer(owner, { storeId: storeId() })

      const same = await asAdmin()
        .get(ApiRoutes.customers.mergePreview(a.id))
        .query({ absorbedId: a.id })
      const missing = await asAdmin().get(ApiRoutes.customers.mergePreview(a.id))

      expect(same.status).toBe(BAD_REQUEST)
      expect((same.body as PreviewBody).error?.code).toBe(ErrorCodes.CUSTOMER_MERGE_SAME_ID)
      expect(missing.status).toBe(BAD_REQUEST)
    })

    it('needs customers:merge: a viewer reads the timeline but not the preview', async () => {
      const a = await createCustomer(owner, { storeId: storeId() })
      const b = await createCustomer(owner, { storeId: storeId() })
      const viewer = () => api(app, ctx.viewerA, ctx.storeA)

      const preview = await viewer()
        .get(ApiRoutes.customers.mergePreview(a.id))
        .query({ absorbedId: b.id })
      const timeline = await viewer().get(ApiRoutes.customers.timeline(a.id))

      expect(preview.status).toBe(FORBIDDEN)
      expect(timeline.status).toBe(OK)
    })

    it('answers 404 when either customer is of another store', async () => {
      const a = await createCustomer(owner, { storeId: storeId() })
      const stranger = await createCustomer(owner, { storeId: ctx.storeB.id })

      const absorbed = await asAdmin()
        .get(ApiRoutes.customers.mergePreview(a.id))
        .query({ absorbedId: stranger.id })
      const survivor = await asAdmin()
        .get(ApiRoutes.customers.mergePreview(stranger.id))
        .query({ absorbedId: a.id })

      expect(absorbed.status).toBe(NOT_FOUND)
      expect(survivor.status).toBe(NOT_FOUND)
    })
  })
})
