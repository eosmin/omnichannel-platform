import { createHash, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  MessageType,
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginScopes } from '@platform/plugins/sdk'

import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404

interface ErrorBody {
  error: { code: string }
}
interface MessageBody {
  id: string
  authorType: string
  authorId: string | null
  authorPluginId?: string | null
  authorNickname?: string | null
  content: string | null
}

const ALL_SCOPES = [
  PluginScopes.CONVERSATIONS_READ,
  PluginScopes.MESSAGES_READ,
  PluginScopes.MESSAGES_WRITE,
  PluginScopes.MESSAGES_READ_DELETED
]

// TDD_10 §6.4, Step 5.6 PR M1b: the messages a plugin writes and reads through its key. The core (who the message is from,
// `quiet`, the trace) has its own suite (plugin-messages-core.spec.ts); this one is the route: the key, the scopes, the body, the
// audit and the store.
describe('The messages of the plugin API', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-msg`
  const pluginName = 'Order Bot'
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0
  type KeyName = 'full' | 'writeonly' | 'readonly' | 'noconv'
  const keys: Record<KeyName, string> = { full: '', writeonly: '', readonly: '', noconv: '' }

  // An installation as the setup exchange leaves it: active, with the hash of its key, in the store and with the scopes asked
  const installIn = async (name: KeyName, storeId: string, scopes: string[]) => {
    counter += 1
    const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}${name}${counter}${'x'.repeat(40)}`
    const installation = await owner.pluginInstallation.create({
      data: {
        storeId,
        pluginId,
        scopes,
        status: 'active',
        apiKeyPrefix: key.slice(0, 12),
        apiKeyHash: createHash('sha256').update(key).digest('hex'),
        installedBy: 'suite'
      }
    })
    keys[name] = key
    return installation
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    await owner.plugin.create({
      data: {
        id: pluginId,
        name: pluginName,
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.INTEGRATION,
        organizationId: ctx.orgA.id,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED
      }
    })
    await installIn('full', ctx.storeA.id, ALL_SCOPES)
    await installIn('writeonly', ctx.storeA2.id, [PluginScopes.MESSAGES_WRITE])
    await installIn('readonly', ctx.storeB.id, [
      PluginScopes.CONVERSATIONS_READ,
      PluginScopes.MESSAGES_READ
    ])
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId } })
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })

  const call = (method: 'get' | 'post', path: string, key: string | undefined) => {
    const request = supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }
  const post = (body: Record<string, unknown>, key: string = keys.full) =>
    call('post', PluginApiRoutes.messages.create, key).send(body)
  const postWithoutKey = (body: Record<string, unknown>) =>
    call('post', PluginApiRoutes.messages.create, undefined).send(body)
  const text = (conversationId: string, extra: Record<string, unknown> = {}) => ({
    type: 'text',
    conversationId,
    content: 'Your order is on its way',
    idempotencyKey: randomUUID(),
    ...extra
  })
  const mk = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
  const row = (id: string) => owner.conversation.findUniqueOrThrow({ where: { id } })
  const codeOf = (body: unknown) => (body as ErrorBody).error.code

  describe('POST /plugin-api/messages', () => {
    it('writes a message of the system by default, with the plugin on its trace and its name as the nickname', async () => {
      const { id } = await mk()

      const response = await post(text(id))

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        authorType: AuthorType.SYSTEM,
        authorId: null,
        authorPluginId: pluginId,
        authorNickname: pluginName
      })
      const conversation = await row(id)
      // An automatic answer is never the first response of the team
      expect(conversation.firstResponseAt).toBeNull()
      expect(conversation.firstAutomatedResponseAt).not.toBeNull()
    })

    it('answers 200 with the same message to a retry with the same key, and audits the first write only', async () => {
      const { id } = await mk()
      const body = text(id)

      const first = await post(body)
      const second = await post(body)

      expect(first.status).toBe(CREATED)
      expect(second.status).toBe(OK)
      expect((second.body as MessageBody).id).toBe((first.body as MessageBody).id)
      const where = {
        action: AuditAction.MESSAGE_PLUGIN_SENT,
        resourceId: (first.body as MessageBody).id
      }
      await waitForAuditEntries(owner, where)
      // Long enough for a second entry, were it written
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(await owner.auditLog.count({ where })).toBe(1)
    })

    it('audits with the platform as the actor and the plugin on the metadata, never the text', async () => {
      const { id } = await mk()

      const response = await post(text(id, { content: 'a secret text of the customer order' }))

      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.MESSAGE_PLUGIN_SENT,
        resourceId: (response.body as MessageBody).id
      })
      expect(entry).toMatchObject({
        userId: null,
        storeId: ctx.storeA.id,
        resourceType: 'message'
      })
      expect(entry?.metadata).toMatchObject({
        pluginId,
        conversationId: id,
        type: MessageType.TEXT,
        authorType: AuthorType.SYSTEM,
        quiet: false
      })
      expect(JSON.stringify(entry)).not.toContain('secret text')
    })

    it('cuts the nickname, removes the control characters and falls back to the name of the plugin when nothing is left', async () => {
      const { id } = await mk()

      const cut = await post(text(id, { nickname: `  Bo\u0000t\n${'x'.repeat(200)}  ` }))
      const blank = await post(text(id, { nickname: ' \u0000\n ' }))

      const nickname = (cut.body as MessageBody).authorNickname ?? ''
      expect(cut.status).toBe(CREATED)
      expect(nickname.startsWith('Bo t xxx')).toBe(true)
      expect(Array.from(nickname).length).toBeLessThanOrEqual(64)
      expect(Array.from(nickname).some(character => character.charCodeAt(0) < 32)).toBe(false)
      expect((blank.body as MessageBody).authorNickname).toBe(pluginName)
    })

    it('writes as a person of the store when it says so, and that is the answer of that person', async () => {
      const { id } = await mk()

      const response = await post(text(id, { authorType: AuthorType.AGENT, userId: ctx.agentA.id }))

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        authorPluginId: pluginId
      })
      expect((await row(id)).firstResponseAt).not.toBeNull()
    })

    it('refuses to write as a user of another store, and writes nothing', async () => {
      const { id } = await mk()

      const response = await post(text(id, { authorType: AuthorType.AGENT, userId: ctx.adminB.id }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('refuses an agent message without a userId, a system one with a userId and a nickname on an agent one', async () => {
      const { id } = await mk()

      const noUser = await post(text(id, { authorType: AuthorType.AGENT }))
      const systemWithUser = await post(text(id, { userId: ctx.agentA.id }))
      const agentWithNickname = await post(
        text(id, { authorType: AuthorType.AGENT, userId: ctx.agentA.id, nickname: 'Bot' })
      )

      for (const response of [noUser, systemWithUser, agentWithNickname]) {
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('keeps the conversation as it was when it is quiet, and still stores and sends the message', async () => {
      const lastMessageAt = new Date(Date.now() - 3_600_000)
      const { id } = await mk({ status: ConversationStatus.RESOLVED, lastMessageAt })

      const response = await post(text(id, { quiet: true }))

      expect(response.status).toBe(CREATED)
      const after = await row(id)
      expect(after.status).toBe(ConversationStatus.RESOLVED)
      expect(after.lastMessageAt).toEqual(lastMessageAt)
      expect(after.firstAutomatedResponseAt).toBeNull()
      expect(after.lastOutboundAt).toBeNull()
      // The message is there and goes to the customer: quiet changes the conversation, not the message
      const stored = await owner.message.findUniqueOrThrow({
        where: { id: (response.body as MessageBody).id }
      })
      expect(stored).toMatchObject({ conversationId: id, deliveryStatus: 'queued' })
    })

    it('writes an internal note that changes nothing in the conversation, and takes no mentions', async () => {
      const { id } = await mk()

      const note = await post({
        type: 'note',
        conversationId: id,
        content: 'The bot saw a delay',
        idempotencyKey: randomUUID()
      })
      const mentioned = await post({
        type: 'note',
        conversationId: id,
        content: 'Look',
        idempotencyKey: randomUUID(),
        mentions: [ctx.agentA.id]
      })

      expect(note.status).toBe(CREATED)
      expect(note.body).toMatchObject({ type: MessageType.INTERNAL_NOTE, authorPluginId: pluginId })
      expect(mentioned.status).toBe(BAD_REQUEST)
      expect((await row(id)).firstAutomatedResponseAt).toBeNull()
    })

    it('does not take a file, a template, an avatar that is a link or any field it does not know', async () => {
      const { id } = await mk()
      const attempts: Record<string, unknown>[] = [
        text(id, { type: 'image', mediaIds: [randomUUID()] }),
        text(id, { type: 'template' }),
        text(id, { avatar: 'https://evil.example.com/a.png' }),
        text(id, { authorId: ctx.agentA.id }),
        text(id, { quiet: 'yes' }),
        text(id, { authorType: AuthorType.CUSTOMER }),
        (({ idempotencyKey: _dropped, ...rest }) => rest)(text(id))
      ]

      for (const attempt of attempts) {
        expect((await post(attempt)).status).toBe(BAD_REQUEST)
      }
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('answers 403 without the scope of writing, and 403 without the scope of seeing the conversation', async () => {
      const own = await createConversationOf(owner, { storeId: ctx.storeA2.id })
      const read = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const withoutWrite = await post(text(read.id), keys.readonly)
      const withoutRead = await post(text(own.id), keys.writeonly)

      expect(withoutWrite.status).toBe(FORBIDDEN)
      expect(codeOf(withoutWrite.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      expect(withoutRead.status).toBe(FORBIDDEN)
      expect(codeOf(withoutRead.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      expect(
        await owner.message.count({ where: { conversationId: { in: [own.id, read.id] } } })
      ).toBe(0)
    })

    it('answers 401 to a call with no key or a wrong one', async () => {
      const { id } = await mk()

      expect((await postWithoutKey(text(id))).status).toBe(401)
      expect((await post(text(id), `${PLUGIN_API_KEY_TOKEN_PREFIX}nope`)).status).toBe(401)
    })

    it('does not reach a conversation of another store, whatever the call carries: a 404, and nothing is written', async () => {
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const response = await post(text(foreign.id)).set('x-store-id', ctx.storeB.id)

      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.message.count({ where: { conversationId: foreign.id } })).toBe(0)
    })
  })

  describe('reading the edits and the deleted text of a message', () => {
    const messageIn = async (conversationId: string, extra: Record<string, unknown> = {}) =>
      owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId,
          type: MessageType.TEXT,
          authorType: AuthorType.AGENT,
          content: 'the text that was deleted',
          ...extra
        }
      })

    it('gives the kept text of a deleted message to a key with the scope, and audits the read with the plugin', async () => {
      const { id } = await mk()
      const message = await messageIn(id, { deletedAt: new Date() })

      const response = await call(
        'get',
        PluginApiRoutes.messages.deletedContent(message.id),
        keys.full
      )

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ content: 'the text that was deleted' })
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.MESSAGE_DELETED_CONTENT_VIEWED,
        resourceId: message.id
      })
      expect(entry).toMatchObject({ userId: null, storeId: ctx.storeA.id })
      expect(entry?.metadata).toMatchObject({ pluginId })
    })

    it('refuses the kept text to a key without messages:read-deleted', async () => {
      const { id } = await mk()
      const message = await messageIn(id, { deletedAt: new Date() })

      const response = await call(
        'get',
        PluginApiRoutes.messages.deletedContent(message.id),
        keys.readonly
      )

      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
    })

    it('does not give the text or the edits of a message of another store: a 404', async () => {
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })
      const message = await owner.message.create({
        data: {
          storeId: ctx.storeB.id,
          conversationId: foreign.id,
          type: MessageType.TEXT,
          authorType: AuthorType.AGENT,
          content: 'of the other store',
          deletedAt: new Date()
        }
      })

      const deleted = await call(
        'get',
        PluginApiRoutes.messages.deletedContent(message.id),
        keys.full
      )
      const revisions = await call('get', PluginApiRoutes.messages.revisions(message.id), keys.full)

      expect(deleted.status).toBe(NOT_FOUND)
      expect(revisions.status).toBe(NOT_FOUND)
    })

    it('answers 404 for the kept text of a message that was not deleted, and 403 without conversations:read', async () => {
      const { id } = await mk()
      const message = await messageIn(id)
      await owner.pluginInstallation.deleteMany({ where: { pluginId, storeId: ctx.storeA2.id } })
      await installIn('noconv', ctx.storeA2.id, [PluginScopes.MESSAGES_READ_DELETED])

      const live = await call('get', PluginApiRoutes.messages.deletedContent(message.id), keys.full)
      const noConversations = await call(
        'get',
        PluginApiRoutes.messages.deletedContent(message.id),
        keys.noconv
      )

      expect(live.status).toBe(NOT_FOUND)
      expect(noConversations.status).toBe(FORBIDDEN)
      expect(codeOf(noConversations.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
    })

    it('refuses to send again the text of a message that has no file, or to download a file the customer did not lose, and audits neither', async () => {
      const { id } = await mk()
      const message = await messageIn(id)

      const caption = await call(
        'post',
        PluginApiRoutes.messages.resendCaption(message.id),
        keys.full
      )
      const refetch = await call(
        'post',
        PluginApiRoutes.messages.refetchFile(message.id, 0),
        keys.full
      )
      const readOnly = await call(
        'post',
        PluginApiRoutes.messages.resendCaption(message.id),
        keys.readonly
      )

      expect(caption.status).toBe(409)
      expect(refetch.status).toBe(409)
      expect(readOnly.status).toBe(FORBIDDEN)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.MESSAGE_PLUGIN_CHANGED, resourceId: message.id }
        })
      ).toBe(0)
    })

    it('lists the earlier texts of an edited message', async () => {
      const { id } = await mk()
      const message = await messageIn(id, { version: 2, content: 'now' })
      await owner.messageRevision.create({
        data: {
          storeId: ctx.storeA.id,
          messageId: message.id,
          version: 1,
          content: 'before',
          editedByType: AuthorType.AGENT,
          editedById: ctx.agentA.id
        }
      })

      const response = await call('get', PluginApiRoutes.messages.revisions(message.id), keys.full)

      expect(response.status).toBe(OK)
      expect((response.body as { content: string }[]).map(entry => entry.content)).toEqual([
        'before'
      ])
      // The person who edited is not told to a plugin
      expect(JSON.stringify(response.body)).not.toContain('editedById')
    })
  })
})
