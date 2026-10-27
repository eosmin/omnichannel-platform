import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { RoleNames } from '@platform/core/auth'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelType,
  ConversationAssignedFilters,
  ConversationStatus,
  MessageType
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { encodeConversationCursor } from '@platform/core/messaging'

import { createChannelConnection } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// The "done when" of Step 2.3: the list answers in under 300 ms (p95) over 10 000 conversations
const ROWS = 10_000
const CUSTOMERS = 200
const REQUESTS = 60
const MESSAGES_PER_CONVERSATION = 5
const P95_LIMIT_MS = 300
const STATUSES = [
  ConversationStatus.OPEN,
  ConversationStatus.OPEN,
  ConversationStatus.OPEN,
  ConversationStatus.PENDING,
  ConversationStatus.RESOLVED,
  ConversationStatus.SNOOZED
]

// A real inbox is not all live: some conversations are archived, and some have no date of last message
const isHidden = (i: number): boolean => i % 7 === 3
const hasNoDate = (i: number): boolean => i % 11 === 5
const range = Array.from({ length: ROWS }, (_, i) => i)
const VISIBLE = range.filter(i => !isHidden(i)).length
const VISIBLE_MINE = range.filter(i => !isHidden(i) && i % 5 === 0).length

const percentile95 = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity
}

describe('The list of conversations at the size of a real inbox', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let storeId: string
  let admin: ReturnType<typeof api>
  let agent: ReturnType<typeof api>
  let adminId: string

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    storeId = (await ensureStore(owner, ctx.orgA.id, `${prefix}-big`)).id
    const adminActor = await createActor(owner, app, {
      prefix,
      name: 'big-admin',
      organizationId: ctx.orgA.id,
      storeId,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    const agentActor = await createActor(owner, app, {
      prefix,
      name: 'big-agent',
      organizationId: ctx.orgA.id,
      storeId,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
    adminId = adminActor.id
    admin = api(app, adminActor, { id: storeId })
    agent = api(app, agentActor, { id: storeId })

    const customers = Array.from({ length: CUSTOMERS }, () => ({
      id: randomUUID(),
      identityId: randomUUID()
    }))
    await owner.customer.createMany({
      data: customers.map((customer, i) => ({
        id: customer.id,
        storeId,
        name: `${prefix}-customer-${i}`
      }))
    })
    await owner.customerIdentity.createMany({
      data: customers.map((customer, i) => ({
        id: customer.identityId,
        storeId,
        customerId: customer.id,
        channelType: ChannelType.WHATSAPP,
        channelIdentity: `${prefix}-${i}`
      }))
    })
    const connection = await createChannelConnection(owner, {
      storeId,
      channelType: ChannelType.WHATSAPP
    })
    const now = Date.now()
    const ids = Array.from({ length: ROWS }, () => randomUUID())
    for (let from = 0; from < ROWS; from += 2000) {
      await owner.conversation.createMany({
        data: ids.slice(from, from + 2000).map((id, offset) => {
          const i = from + offset
          const customer = customers[i % CUSTOMERS]
          return {
            id,
            storeId,
            customerId: customer?.id ?? '',
            customerIdentityId: customer?.identityId ?? '',
            channelConnectionId: connection.id,
            channelType: ChannelType.WHATSAPP,
            status: isHidden(i)
              ? ConversationStatus.ARCHIVED
              : (STATUSES[i % STATUSES.length] ?? ConversationStatus.OPEN),
            assignedTo: i % 5 === 0 ? adminId : null,
            lastMessageAt: hasNoDate(i) ? null : new Date(now - i * 60_000)
          }
        })
      })
    }
    // A real inbox has several messages per conversation: the last one of each page is looked up
    // among them
    const messages = ids.flatMap((id, i) =>
      Array.from({ length: MESSAGES_PER_CONVERSATION }, (_, n) => ({
        storeId,
        conversationId: id,
        type: MessageType.TEXT,
        content: `message ${i}.${n}`,
        authorType: AuthorType.CUSTOMER,
        createdAt: new Date(now - i * 60_000 - n * 1000)
      }))
    )
    for (let from = 0; from < messages.length; from += 10_000) {
      await owner.message.createMany({ data: messages.slice(from, from + 10_000) })
    }
    // A real database has statistics; a table that was just filled has none until this runs
    await owner.$executeRawUnsafe('ANALYZE conversations')
    await owner.$executeRawUnsafe('ANALYZE messages')
  }, 120_000)

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  }, 120_000)

  async function measure(request: () => Promise<{ status: number }>): Promise<number[]> {
    await request() // The first call warms the connection and the plan
    const times: number[] = []
    for (let i = 0; i < REQUESTS; i += 1) {
      const started = performance.now()
      const response = await request()
      times.push(performance.now() - started)
      expect(response.status).toBe(HttpStatusCodes.OK)
    }
    return times
  }

  it('answers the first page in under 300 ms at the 95th percentile', async () => {
    const first = await admin.get(ApiRoutes.conversations.list)
    const times = await measure(() => admin.get(ApiRoutes.conversations.list))

    const page = first.body as {
      data: { lastMessage: { contentPreview: string } | null }[]
      hasMore: boolean
    }
    expect(page.data).toHaveLength(25)
    expect(page.hasMore).toBe(true)
    expect(page.data[0]?.lastMessage?.contentPreview).toBe('message 0.0')
    expect(percentile95(times)).toBeLessThan(P95_LIMIT_MS)
  })

  it('answers a deep page, filters and an agent without VIEW_ALL just as fast', async () => {
    const first = await admin.get(ApiRoutes.conversations.list).query({ limit: 100 })
    let cursor = (first.body as { nextCursor: string }).nextCursor
    const firstPageIds = new Set(
      (first.body as { data: { id: string }[] }).data.map(item => item.id)
    )
    for (let i = 0; i < 20; i += 1) {
      const page = await admin.get(ApiRoutes.conversations.list).query({ limit: 100, cursor })
      expect(page.status).toBe(HttpStatusCodes.OK)
      expect((page.body as { hasMore: boolean }).hasMore).toBe(true)
      cursor = (page.body as { nextCursor: string }).nextCursor
    }
    const deepPage = await admin.get(ApiRoutes.conversations.list).query({ cursor })
    const deepRows = (deepPage.body as { data: { id: string }[] }).data
    expect(deepRows).toHaveLength(25)
    expect(deepRows.some(item => firstPageIds.has(item.id))).toBe(false)

    const deep = await measure(() => admin.get(ApiRoutes.conversations.list).query({ cursor }))
    const filtered = await measure(() =>
      admin
        .get(ApiRoutes.conversations.list)
        .query({ status: ConversationStatus.OPEN, assigned: ConversationAssignedFilters.ME })
    )
    const restricted = await measure(() => agent.get(ApiRoutes.conversations.list))

    const mine = await admin.get(ApiRoutes.conversations.list).query({
      status: ConversationStatus.OPEN,
      assigned: ConversationAssignedFilters.ME,
      limit: 100
    })
    const mineRows = (mine.body as { data: { assignedTo: string; status: string }[] }).data
    const restrictedRows = (await agent.get(ApiRoutes.conversations.list).query({ limit: 100 }))
      .body as { data: { assignedTo: string | null }[] }
    expect(mineRows.length).toBeGreaterThan(0)
    expect(
      mineRows.every(
        item =>
          item.assignedTo === adminId && String(item.status) === String(ConversationStatus.OPEN)
      )
    ).toBe(true)
    // An agent without VIEW_ALL sees the unassigned ones, and none of the admin's
    expect(restrictedRows.data.length).toBeGreaterThan(0)
    expect(restrictedRows.data.every(item => item.assignedTo === null)).toBe(true)
    expect(percentile95(deep)).toBeLessThan(P95_LIMIT_MS)
    expect(percentile95(filtered)).toBeLessThan(P95_LIMIT_MS)
    expect(percentile95(restricted)).toBeLessThan(P95_LIMIT_MS)
  })

  it('answers the page where the conversations without a date begin just as fast', async () => {
    const cursor = encodeConversationCursor({ lastMessageAt: new Date(0), id: randomUUID() })

    const page = await admin.get(ApiRoutes.conversations.list).query({ cursor })
    const times = await measure(() => admin.get(ApiRoutes.conversations.list).query({ cursor }))

    const rows = (page.body as { data: { lastMessageAt: string | null }[] }).data
    expect(rows).toHaveLength(25)
    expect(rows.every(item => item.lastMessageAt === null)).toBe(true)
    expect(percentile95(times)).toBeLessThan(P95_LIMIT_MS)
  })

  it('answers the counts of the filters in under 300 ms too', async () => {
    const answer = await admin.get(ApiRoutes.conversations.list).query({ countsOnly: 'true' })
    const times = await measure(() =>
      admin.get(ApiRoutes.conversations.list).query({ countsOnly: 'true' })
    )

    const counts = answer.body as { all: number; mine: number; unassigned: number }
    expect(counts.all).toBe(VISIBLE)
    expect(counts.mine).toBe(VISIBLE_MINE)
    expect(counts.unassigned).toBe(VISIBLE - VISIBLE_MINE)
    expect(percentile95(times)).toBeLessThan(P95_LIMIT_MS)
  })
})
