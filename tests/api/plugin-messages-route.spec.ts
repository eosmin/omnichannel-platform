import { createHash, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { MULTI_FILE_SEND_ENABLED } from '@platform/core/http'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability, PluginScopes } from '@platform/plugins/sdk'

import { buildChannelPlugin, createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const FILES_CHANNEL = 'plugin_files_channel'
const TEXT_ONLY_CHANNEL = 'plugin_text_only_channel'

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
  PluginScopes.MESSAGES_WRITE_AS_AGENT,
  PluginScopes.MESSAGES_READ_DELETED,
  PluginScopes.MEDIA_WRITE
]

// TDD_10 §6.4, Step 5.6 PR M1b: the messages a plugin writes and reads through its key. The core (who the message is from,
// `quiet`, the trace) has its own suite (plugin-messages-core.spec.ts); this one is the route: the key, the scopes, the body, the
// audit and the store.
describe('The messages of the plugin API', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-msg`
  const pluginName = 'Order Bot'
  const otherPluginId = `${prefix}-msg2`
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0
  type KeyName = 'full' | 'writeonly' | 'readonly' | 'noconv' | 'other' | 'nomedia'
  const keys: Record<KeyName, string> = {
    full: '',
    writeonly: '',
    readonly: '',
    noconv: '',
    other: '',
    nomedia: ''
  }
  // The owners of the uploads: `plugin:<installation id>` for each installation of store A
  let fullUploader = ''
  let otherUploader = ''

  // An installation as the setup exchange leaves it: active, with the hash of its key, in the store and with the scopes asked
  const installIn = async (
    name: KeyName,
    storeId: string,
    scopes: string[],
    ofPlugin = pluginId
  ) => {
    counter += 1
    const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}${name}${counter}${'x'.repeat(40)}`
    const installation = await owner.pluginInstallation.create({
      data: {
        storeId,
        pluginId: ofPlugin,
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
    app = await createTestApp([], builder =>
      builder.overrideProvider(MULTI_FILE_SEND_ENABLED).useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(
      buildChannelPlugin({
        id: FILES_CHANNEL,
        capabilities: [
          ChannelCapability.TEXT,
          ChannelCapability.IMAGE,
          ChannelCapability.MESSAGING_WINDOW
        ],
        media: {
          maxFilesPerMessage: 3,
          kinds: { image: { types: ['image/png'], maxBytes: 100 } }
        }
      })
    )
    app.get(PluginRegistry, { strict: false }).register(
      buildChannelPlugin({
        id: TEXT_ONLY_CHANNEL,
        capabilities: [ChannelCapability.TEXT, ChannelCapability.MESSAGING_WINDOW]
      })
    )
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
    await owner.plugin.create({
      data: {
        id: otherPluginId,
        name: 'Other Bot',
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.INTEGRATION,
        organizationId: ctx.orgA.id,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED
      }
    })
    fullUploader = `plugin:${(await installIn('full', ctx.storeA.id, ALL_SCOPES)).id}`
    otherUploader = `plugin:${(await installIn('other', ctx.storeA.id, ALL_SCOPES, otherPluginId)).id}`
    await installIn(
      'nomedia',
      ctx.storeA2.id,
      [PluginScopes.CONVERSATIONS_READ, PluginScopes.MESSAGES_WRITE],
      otherPluginId
    )
    await installIn('writeonly', ctx.storeA2.id, [PluginScopes.MESSAGES_WRITE])
    await installIn('readonly', ctx.storeB.id, [
      PluginScopes.CONVERSATIONS_READ,
      PluginScopes.MESSAGES_READ
    ])
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({
      where: { pluginId: { in: [pluginId, otherPluginId] } }
    })
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

    // MSG-410: `messages:write` alone writes only as the plugin; acting as a person is the scope of its own
    it('refuses to write as a person without messages:write-as-agent, the same for a real member and for one that does not exist', async () => {
      const { id } = await mk()
      const real = await post(
        text(id, { authorType: AuthorType.AGENT, userId: ctx.agentA.id }),
        keys.nomedia
      )
      const unknown = await post(
        text(id, { authorType: AuthorType.AGENT, userId: randomUUID() }),
        keys.nomedia
      )

      for (const response of [real, unknown]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
        expect(response.body).toMatchObject({
          error: { metadata: { required: [PluginScopes.MESSAGES_WRITE_AS_AGENT] } }
        })
      }
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('still writes as the plugin with messages:write alone', async () => {
      const { id } = await mk({ storeId: ctx.storeA2.id })

      const response = await post(text(id), keys.nomedia)

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        authorType: AuthorType.SYSTEM,
        authorId: null,
        authorPluginId: otherPluginId
      })
    })

    it('audits a message written as a person with the plugin, the installation and the person it wrote for', async () => {
      const { id } = await mk()

      const response = await post(text(id, { authorType: AuthorType.AGENT, userId: ctx.agentA.id }))

      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.MESSAGE_PLUGIN_SENT,
        resourceId: (response.body as MessageBody).id
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({
        pluginId,
        authorType: AuthorType.AGENT,
        userId: ctx.agentA.id
      })
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

    it('does not take a template, a file with no files, a text with files, an avatar that is a link or any field it does not know', async () => {
      const { id } = await mk()
      const attempts: Record<string, unknown>[] = [
        text(id, { type: 'template' }),
        text(id, { type: 'image' }),
        text(id, { mediaIds: [randomUUID()] }),
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
      // A plugin sends again the text of what it wrote (M1c): the message is the plugin's, and still has no file
      await owner.message.update({ where: { id: message.id }, data: { authorPluginId: pluginId } })

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
  // PR E7-2: a plugin sends the files it uploaded, with the rules of a person (the service is the same)
  describe('POST /plugin-api/messages with files', () => {
    const conversation = async (lastInboundAt: Date | null = new Date()) => {
      const created = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: FILES_CHANNEL
      })
      await owner.customerIdentity.update({
        where: { id: created.customerIdentityId },
        data: { lastInboundAt }
      })
      return created
    }
    const file = (
      uploadedBy: string,
      storeId = ctx.storeA.id,
      extra: { contentType?: string; fileSize?: number; status?: string } = {}
    ) => {
      const id = randomUUID()
      return owner.media.create({
        data: {
          id,
          storeId,
          purpose: 'message',
          key: `stores/${storeId}/messages/${id}/photo.png`,
          filename: 'photo.png',
          contentType: extra.contentType ?? 'image/png',
          fileSize: extra.fileSize ?? 10,
          status: extra.status ?? 'clean',
          uploadedBy
        },
        select: { id: true }
      })
    }
    const image = (
      conversationId: string,
      mediaIds: string[],
      extra: Record<string, unknown> = {}
    ) => ({
      type: 'image',
      conversationId,
      mediaIds,
      idempotencyKey: randomUUID(),
      ...extra
    })
    const attached = (id: string) => owner.media.findUniqueOrThrow({ where: { id } })

    it('sends the image the installation uploaded, as the plugin, linked to the message and audited with the count', async () => {
      const { id } = await conversation()
      const upload = await file(fullUploader)

      const response = await post(image(id, [upload.id], { content: 'Your receipt' }))

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        type: MessageType.IMAGE,
        authorType: AuthorType.SYSTEM,
        authorPluginId: pluginId,
        content: 'Your receipt',
        deliveryStatus: DeliveryStatus.QUEUED
      })
      expect((response.body as { media: { id: string }[] }).media.map(item => item.id)).toEqual([
        upload.id
      ])
      expect((await attached(upload.id)).messageId).toBe((response.body as MessageBody).id)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.MESSAGE_PLUGIN_SENT,
        resourceId: (response.body as MessageBody).id
      })
      expect(entry?.metadata).toMatchObject({ type: MessageType.IMAGE, files: 1 })
    })

    it('sends an album of several images with one text, as a person does', async () => {
      const { id } = await conversation()
      const first = await file(fullUploader)
      const second = await file(fullUploader)

      const response = await post(image(id, [first.id, second.id], { content: 'Both photos' }))

      expect(response.status).toBe(CREATED)
      expect((response.body as { media: { id: string; position: number }[] }).media).toHaveLength(2)
    })

    it('does not send a file that another installation, a person or another store uploaded: one 404, and the file stays free', async () => {
      const { id } = await conversation()
      const ofOther = await file(otherUploader)
      const ofPerson = await file(ctx.agentA.id)
      const ofStoreB = await file(fullUploader, ctx.storeB.id)
      const ofNobody = await file(fullUploader, ctx.storeA.id).then(async made => {
        await owner.media.update({ where: { id: made.id }, data: { uploadedBy: null } })
        return made
      })

      for (const target of [ofOther, ofPerson, ofStoreB, ofNobody]) {
        const response = await post(image(id, [target.id]))

        expect(response.status).toBe(NOT_FOUND)
        expect((await attached(target.id)).messageId).toBeNull()
      }
      // One file that is the installation's does not carry along one that is not
      const own = await file(fullUploader)
      expect((await post(image(id, [own.id, ofOther.id]))).status).toBe(NOT_FOUND)
      expect((await attached(own.id)).messageId).toBeNull()
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('holds a file to the rules of the channel: its type, its size, its kind, how many, and a file that is not clean', async () => {
      const { id } = await conversation()
      const wrongType = await file(fullUploader, ctx.storeA.id, { contentType: 'image/jpeg' })
      const tooBig = await file(fullUploader, ctx.storeA.id, { fileSize: 1000 })
      const infected = await file(fullUploader, ctx.storeA.id, { status: 'infected' })
      const pending = await file(fullUploader, ctx.storeA.id, { status: 'pending' })
      const many = await Promise.all([1, 2, 3, 4].map(() => file(fullUploader)))
      const audio = await file(fullUploader, ctx.storeA.id, { contentType: 'audio/ogg' })

      const wrongTypeAnswer = await post(image(id, [wrongType.id]))
      const tooBigAnswer = await post(image(id, [tooBig.id]))
      const manyAnswer = await post(
        image(
          id,
          many.map(item => item.id)
        )
      )
      const audioAnswer = await post(image(id, [audio.id]))
      const audioKindAnswer = await post(image(id, [audio.id], { type: 'audio' }))
      const unclean = [await post(image(id, [infected.id])), await post(image(id, [pending.id]))]

      expect(codeOf(wrongTypeAnswer.body)).toBe(ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED)
      expect(codeOf(tooBigAnswer.body)).toBe(ErrorCodes.CHANNEL_FILE_TOO_LARGE)
      expect(codeOf(manyAnswer.body)).toBe(ErrorCodes.CHANNEL_TOO_MANY_FILES)
      // The kind of the file is not the type of the message, and the channel does not carry audio
      expect(audioAnswer.status).toBe(BAD_REQUEST)
      expect(codeOf(audioKindAnswer.body)).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      for (const response of unclean) expect(response.status).toBeGreaterThanOrEqual(BAD_REQUEST)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('does not send a file to a customer whose messaging window is closed, and a quiet file changes nothing in the conversation', async () => {
      const closed = await conversation(new Date(Date.now() - 48 * 3_600_000))
      const open = await conversation()
      const before = (await row(open.id)).status
      const late = await file(fullUploader)
      const silent = await file(fullUploader)

      const refused = await post(image(closed.id, [late.id]))
      const quiet = await post(image(open.id, [silent.id], { quiet: true }))

      expect(refused.status).toBe(CONFLICT)
      expect(codeOf(refused.body)).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
      expect((await attached(late.id)).messageId).toBeNull()
      expect(quiet.status).toBe(CREATED)
      expect((await row(open.id)).status).toBe(before)
    })

    it('answers a repeated key with the message it made (200) and refuses it for other files (409)', async () => {
      const { id } = await conversation()
      const upload = await file(fullUploader)
      const another = await file(fullUploader)
      const body = image(id, [upload.id])

      const first = await post(body)
      const again = await post(body)
      const other = await post({ ...body, mediaIds: [another.id] })

      expect(first.status).toBe(CREATED)
      expect(again.status).toBe(OK)
      expect((again.body as MessageBody).id).toBe((first.body as MessageBody).id)
      expect(other.status).toBe(CONFLICT)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(1)
    })

    it('does not send an image on a channel that does not carry it, and answers 403 without the scope of writing', async () => {
      const plain = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: TEXT_ONLY_CHANNEL
      })
      await owner.customerIdentity.update({
        where: { id: plain.customerIdentityId },
        data: { lastInboundAt: new Date() }
      })
      const upload = await file(fullUploader)

      const refused = await post(image(plain.id, [upload.id]))
      const forbidden = await post(image(plain.id, [upload.id]), keys.readonly)

      expect(refused.status).toBe(CONFLICT)
      expect(codeOf(refused.body)).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      expect(forbidden.status).toBe(FORBIDDEN)
      expect((await attached(upload.id)).messageId).toBeNull()
    })

    it('refuses a file to a key that holds no media:write (the owner took it back), and still sends it a text', async () => {
      const own = await createConversationOf(owner, { storeId: ctx.storeA2.id })
      const upload = await file(otherUploader, ctx.storeA2.id)

      const refused = await post(image(own.id, [upload.id]), keys.nomedia)
      const text_ = await post(text(own.id), keys.nomedia)

      expect(refused.status).toBe(FORBIDDEN)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      expect((await attached(upload.id)).messageId).toBeNull()
      expect(text_.status).toBe(CREATED)
    })

    it('lets two installations of the same store keep their uploads apart, with the same scopes', async () => {
      const { id } = await conversation()
      const upload = await file(otherUploader)

      expect((await post(image(id, [upload.id]), keys.full)).status).toBe(NOT_FOUND)
      expect((await post(image(id, [upload.id]), keys.other)).status).toBe(CREATED)
    })
  })
  // HC-011: the answer to a write names the message that was quoted. What of it a plugin reads is what `messages:read` gives and no
  // more: without the scope only the id, and with it the kind and the text, never the id of a member of the team and never the text
  // of an internal note (which `messages:write` alone would otherwise show, because it grants writing notes).
  describe('the quote in the answer of POST /plugin-api/messages', () => {
    const SECRET = 'the card of the customer ends in 1234'
    const NOTE_TEXT = 'internal: the customer is a risk'
    // `nomedia` (store A2) holds messages:write and conversations:read but not messages:read; `full` (store A) holds all of them
    const worlds = [
      {
        label: 'without messages:read',
        key: () => keys.nomedia,
        store: () => ctx.storeA2.id,
        sees: false
      },
      { label: 'with messages:read', key: () => keys.full, store: () => ctx.storeA.id, sees: true }
    ] as const

    const seed = async (storeId: string, conversationId: string, extra: Record<string, unknown>) =>
      owner.message.create({
        data: { storeId, conversationId, type: MessageType.TEXT, ...extra } as never,
        select: { id: true }
      })

    describe.each(worlds)('a key $label', world => {
      const conversationOf = async () => {
        const { id } = await createConversationOf(owner, { storeId: world.store() })
        return id
      }
      const quoting = (
        conversationId: string,
        quoted: string,
        extra: Record<string, unknown> = {}
      ) =>
        post(
          {
            type: 'text',
            conversationId,
            content: 'answer',
            idempotencyKey: randomUUID(),
            replyToMessageId: quoted,
            ...extra
          },
          world.key()
        )

      it('answers the quote of a message of the customer with its text only when it reads messages', async () => {
        const id = await conversationOf()
        const quoted = await seed(world.store(), id, {
          authorType: AuthorType.CUSTOMER,
          content: SECRET
        })

        const response = await quoting(id, quoted.id)

        expect(response.status).toBe(CREATED)
        const body = response.body as {
          replyToMessageId: string
          replyTo: { content: string | null } | null
        }
        expect(body.replyToMessageId).toBe(quoted.id)
        if (world.sees) expect(body.replyTo?.content).toBe(SECRET)
        else {
          expect(body.replyTo).toBeNull()
          expect(JSON.stringify(response.body)).not.toContain(SECRET)
        }
      })

      it('never gives the id of the member of the team who wrote the quoted message', async () => {
        const id = await conversationOf()
        const member = ctx.agentA.id
        const quoted = await seed(world.store(), id, {
          authorType: AuthorType.AGENT,
          authorId: member,
          content: 'we will call you'
        })

        const response = await quoting(id, quoted.id)

        expect(response.status).toBe(CREATED)
        expect(JSON.stringify(response.body)).not.toContain(member)
        const body = response.body as { replyTo: { authorId: string | null } | null }
        if (world.sees)
          expect(body.replyTo).toMatchObject({ authorId: null, content: 'we will call you' })
        else expect(body.replyTo).toBeNull()
      })

      it('never gives the text of an internal note that a note quotes, even with messages:read', async () => {
        const id = await conversationOf()
        const quoted = await seed(world.store(), id, {
          type: MessageType.INTERNAL_NOTE,
          authorType: AuthorType.AGENT,
          authorId: ctx.agentA.id,
          content: NOTE_TEXT
        })

        const response = await quoting(id, quoted.id, { type: 'note' })

        expect(response.status).toBe(CREATED)
        expect(JSON.stringify(response.body)).not.toContain(NOTE_TEXT)
        const body = response.body as {
          replyToMessageId: string
          replyTo: { content: string | null; authorId: string | null } | null
        }
        expect(body.replyToMessageId).toBe(quoted.id)
        if (world.sees) expect(body.replyTo).toMatchObject({ content: null, authorId: null })
        else expect(body.replyTo).toBeNull()
      })

      it('gives the same answer when the key is repeated (200): the quote is held back on a replay too', async () => {
        const id = await conversationOf()
        const quoted = await seed(world.store(), id, {
          authorType: AuthorType.CUSTOMER,
          content: SECRET
        })
        const key = randomUUID()

        const first = await quoting(id, quoted.id, { idempotencyKey: key })
        const again = await quoting(id, quoted.id, { idempotencyKey: key })

        expect(first.status).toBe(CREATED)
        expect(again.status).toBe(OK)
        if (!world.sees) {
          expect((again.body as { replyTo: unknown }).replyTo).toBeNull()
          expect(JSON.stringify(again.body)).not.toContain(SECRET)
        }
      })

      it('does not quote a message of another store of the organization or of another organization: 404, and nothing is written', async () => {
        const id = await conversationOf()
        const sibling = await createConversationOf(owner, {
          storeId: world.sees ? ctx.storeA2.id : ctx.storeA.id
        })
        const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })
        const ofSibling = await seed(world.sees ? ctx.storeA2.id : ctx.storeA.id, sibling.id, {
          authorType: AuthorType.CUSTOMER,
          content: SECRET
        })
        const ofForeign = await seed(ctx.storeB.id, foreign.id, {
          authorType: AuthorType.CUSTOMER,
          content: SECRET
        })

        for (const quoted of [ofSibling, ofForeign]) {
          const response = await quoting(id, quoted.id)

          expect(response.status).toBe(NOT_FOUND)
          expect(JSON.stringify(response.body)).not.toContain(SECRET)
        }
        expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
      })
    })

    it('does not hand the message of a customer to a key that does not read messages, through the route that downloads a file again', async () => {
      const own = await createConversationOf(owner, { storeId: ctx.storeA2.id })
      const customerMessage = await seed(ctx.storeA2.id, own.id, {
        authorType: AuthorType.CUSTOMER,
        content: SECRET
      })

      const response = await call(
        'post',
        PluginApiRoutes.messages.refetchFile(customerMessage.id, 0),
        keys.nomedia
      ).send({})

      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      expect(JSON.stringify(response.body)).not.toContain(SECRET)
    })

    it('leaves the ids of the team out of the answer: who reacted, who edited and who deleted the message of the plugin', async () => {
      const own = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const key = randomUUID()
      const created = await post({
        type: 'text',
        conversationId: own.id,
        content: 'answer',
        idempotencyKey: key
      })
      const messageId = (created.body as MessageBody).id
      await owner.messageReaction.create({
        data: {
          storeId: ctx.storeA.id,
          messageId,
          authorType: AuthorType.AGENT,
          userId: ctx.agentA.id,
          emoji: '👍'
        }
      })
      await owner.message.update({
        where: { id: messageId },
        data: { editedById: ctx.agentA.id, editedByType: AuthorType.AGENT }
      })

      const again = await post({
        type: 'text',
        conversationId: own.id,
        content: 'answer',
        idempotencyKey: key
      })

      expect(again.status).toBe(OK)
      expect(JSON.stringify(again.body)).not.toContain(ctx.agentA.id)
    })

    it('holds the quote back from the answer of a send again, without messages:read', async () => {
      const own = await createConversationOf(owner, { storeId: ctx.storeA2.id })
      const quoted = await seed(ctx.storeA2.id, own.id, {
        authorType: AuthorType.CUSTOMER,
        content: SECRET
      })
      const failed = await seed(ctx.storeA2.id, own.id, {
        authorType: AuthorType.SYSTEM,
        authorPluginId: otherPluginId,
        content: 'answer',
        deliveryStatus: DeliveryStatus.FAILED,
        replyToMessageId: quoted.id
      })
      await owner.customerIdentity.update({
        where: { id: own.customerIdentityId },
        data: { lastInboundAt: new Date() }
      })

      const response = await call(
        'post',
        PluginApiRoutes.messages.resend(failed.id),
        keys.nomedia
      ).send({})

      expect(response.status).toBe(OK)
      expect((response.body as { replyTo: unknown }).replyTo).toBeNull()
      expect(JSON.stringify(response.body)).not.toContain(SECRET)
    })
  })
})
