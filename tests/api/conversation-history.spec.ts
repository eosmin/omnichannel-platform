import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ConversationLimits } from '@platform/core/domain'

import { createConversationOf, createMessage, createMessageRevisionOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404

interface OriginBody {
  id: string
  messageId: string
  kind: string
  sourceId: string | null
  sourceUrl: string | null
  title: string | null
  mediaUrl: string | null
  thumbnailUrl: string | null
}
interface RevisionBody {
  version: number
  content: string | null
  editedByType: string
  editedById: string | null
}

describe('The history of a conversation and of a message', () => {
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

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asViewer = () => api(app, ctx.viewerA, ctx.storeA)

  // A conversation whose customer wrote from the given ads, oldest first
  async function conversationFromAds(
    ads: { title: string; sourceUrl?: string; mediaUrl?: string }[]
  ): Promise<string> {
    const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
    for (const [index, ad] of ads.entries()) {
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id
      })
      await owner.conversationOrigin.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          messageId: message.id,
          kind: 'ad',
          sourceId: `ad-${index}`,
          title: ad.title,
          sourceUrl: ad.sourceUrl ?? null,
          mediaUrl: ad.mediaUrl ?? null,
          clickId: 'click-secret',
          referral: { tracking: 'referral-secret' },
          createdAt: new Date(Date.UTC(2026, 9, 1 + index))
        }
      })
    }
    return conversation.id
  }

  describe('the origins of a conversation', () => {
    it('come newest first, and the first contact is the last of the list', async () => {
      const id = await conversationFromAds([{ title: 'First ad' }, { title: 'Second ad' }])

      const response = await asAdmin().get(ApiRoutes.conversations.origins(id))

      expect(response.status).toBe(OK)
      expect((response.body as OriginBody[]).map(origin => origin.title)).toEqual([
        'Second ad',
        'First ad'
      ])
    })

    it('leave out the click id and the raw referral of the provider', async () => {
      const id = await conversationFromAds([{ title: 'Ad' }])

      const response = await asViewer().get(ApiRoutes.conversations.origins(id))

      expect(response.status).toBe(OK)
      expect(JSON.stringify(response.body)).not.toContain('click-secret')
      expect(JSON.stringify(response.body)).not.toContain('referral-secret')
    })

    it('carry a link only when it is a plain http link', async () => {
      const id = await conversationFromAds([
        {
          title: 'Ad',
          sourceUrl: 'https://www.facebook.com/ads/1',
          mediaUrl: 'javascript:alert(1)'
        }
      ])

      const response = await asAdmin().get(ApiRoutes.conversations.origins(id))

      const [origin] = response.body as OriginBody[]
      expect(origin?.sourceUrl).toBe('https://www.facebook.com/ads/1')
      expect(origin?.mediaUrl).toBeNull()
    })

    it('are an empty list for a conversation that came from nowhere', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })

      const response = await asAdmin().get(ApiRoutes.conversations.origins(conversation.id))

      expect(response.status).toBe(OK)
      expect(response.body).toEqual([])
    })

    it('keep the first contact when there are more than the list holds', async () => {
      const total = ConversationLimits.MAX_ORIGINS_LISTED + 3
      const id = await conversationFromAds(
        Array.from({ length: total }, (_, index) => ({ title: `Ad ${index}` }))
      )

      const response = await asAdmin().get(ApiRoutes.conversations.origins(id))

      const titles = (response.body as OriginBody[]).map(origin => origin.title)
      expect(titles).toHaveLength(ConversationLimits.MAX_ORIGINS_LISTED + 1)
      expect(titles[0]).toBe(`Ad ${total - 1}`)
      expect(titles.at(-1)).toBe('Ad 0')
    })

    it('are a 404 for a conversation that does not exist', async () => {
      const response = await asAdmin().get(ApiRoutes.conversations.origins(randomUUID()))

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('a role that cannot see conversations', () => {
    it('is refused the origins and the revisions', async () => {
      const role = await owner.role.create({
        data: {
          storeId: ctx.storeA.id,
          name: `${prefix}-team-only`,
          permissions: { create: [{ name: Permissions.TEAM_VIEW }] }
        }
      })
      const actor = await createActor(owner, app, {
        prefix,
        name: 'teamOnly',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: role.id
      })
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })

      const origins = await api(app, actor, ctx.storeA).get(
        ApiRoutes.conversations.origins(conversation.id)
      )
      const revisions = await api(app, actor, ctx.storeA).get(
        ApiRoutes.messages.revisions(randomUUID())
      )

      expect(origins.status).toBe(FORBIDDEN)
      expect(revisions.status).toBe(FORBIDDEN)
    })
  })

  describe('the revisions of a message', () => {
    it('give the earlier text of a note and who changed it, newest first', async () => {
      const revision = await createMessageRevisionOf(owner, {
        storeId: ctx.storeA.id,
        userId: ctx.adminA.id
      })
      const { messageId } = await owner.messageRevision.findUniqueOrThrow({
        where: { id: revision.id },
        select: { messageId: true }
      })

      const response = await asAdmin().get(ApiRoutes.messages.revisions(messageId))

      expect(response.status).toBe(OK)
      expect(response.body as RevisionBody[]).toEqual([
        expect.objectContaining({
          version: 1,
          content: 'note v1',
          editedByType: 'agent',
          editedById: ctx.adminA.id
        })
      ])
    })

    it('are not given for a note to who may not read notes', async () => {
      const revision = await createMessageRevisionOf(owner, {
        storeId: ctx.storeA.id,
        userId: ctx.adminA.id
      })
      const { messageId } = await owner.messageRevision.findUniqueOrThrow({
        where: { id: revision.id },
        select: { messageId: true }
      })

      const response = await asViewer().get(ApiRoutes.messages.revisions(messageId))

      expect(response.status).toBe(NOT_FOUND)
    })

    it('keep their text back once the message was deleted: it has a route of its own', async () => {
      const revision = await createMessageRevisionOf(owner, {
        storeId: ctx.storeA.id,
        userId: ctx.adminA.id
      })
      const { messageId } = await owner.messageRevision.findUniqueOrThrow({
        where: { id: revision.id },
        select: { messageId: true }
      })
      await owner.message.update({ where: { id: messageId }, data: { deletedAt: new Date() } })

      const response = await asAdmin().get(ApiRoutes.messages.revisions(messageId))

      expect(response.status).toBe(OK)
      expect((response.body as RevisionBody[]).map(item => item.content)).toEqual([null])
    })

    it('are a 404 for a message that does not exist', async () => {
      const response = await asAdmin().get(ApiRoutes.messages.revisions(randomUUID()))

      expect(response.status).toBe(NOT_FOUND)
    })
  })
})
