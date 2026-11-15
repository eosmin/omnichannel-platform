import { randomInt, randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { Redis } from 'ioredis'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { CacheKeys } from '@platform/core/cache'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelConnectionStatus,
  MessageType,
  PluginCatalogTypes,
  PluginPricingModels,
  RemoteChannelApiLimits
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { QueueNames } from '@platform/core/queues'
import { inboundJobId, type ValidRemoteChannelEvent } from '@platform/plugins/runtime'
import { ChannelEventTypes, PluginScopes } from '@platform/plugins/sdk'

import { REDIS_URL } from '../../libs/core/redis/src/testing/test-env'
import { createConversationOf, createMessage } from '../builders'
import { referenceEvents } from '../contracts/remote-channel.contract'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue, queueOf } from '../helpers/queue'

const OK = 200
const CREATED = 201
const ACCEPTED = 202
const NO_CONTENT = 204
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const TOO_MANY_REQUESTS = 429
const PAYLOAD_TOO_LARGE = 413

interface ErrorBody {
  error: { code: string }
}
const codeOf = (body: unknown): string => (body as ErrorBody).error.code

// TDD_10 §6.7.5, Step 5.6 PR C3: what a remote channel plugin says to the platform, through its own key. Two installations of the
// same plugin, in two stores of one organization, are the adversary of each other: a key reaches its own installation's connections
// and nothing else, whatever the path, the body or the connection ids say.
describe('The channel routes of the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let redis: Redis
  let ctx: TestContext
  let counter = 0

  interface Installed {
    pluginId: string
    installationId: string
    key: string
    storeId: string
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.INBOUND)).useValue(new CapturedQueue())
    )
    // Its own client: the one of the app gives up a command after 500 ms, which a busy suite can exceed
    redis = new Redis(REDIS_URL)
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.channelConnection.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await redis.quit()
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminSibling = () => api(app, ctx.adminA2, ctx.storeA2)
  const manifestOf = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    version: '1.0.0',
    name: `Channel ${id}`,
    description: 'A messaging channel that runs outside the platform',
    author: { name: 'Acme Inc', email: 'support@acme.com' },
    type: PluginCatalogTypes.CHANNEL,
    pricing: { model: PluginPricingModels.FREE },
    capabilities: ['text'],
    channel: { label: 'Acme', commandsUrl: 'https://acme.com/platform/commands' },
    scopes: [PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS],
    ui: { settings: 'https://acme.com/plugin/settings' },
    ...over
  })
  const http = () => supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
  const fromAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`

  // Registers a channel and installs it in a store as the owner does, then trades the code for the key
  async function install(
    agent: typeof asAdmin,
    storeId: string,
    pluginId?: string
  ): Promise<Installed> {
    let id = pluginId
    if (id === undefined) {
      counter += 1
      id = `${prefix}-ch${counter}`
      await asAdmin().post(ApiRoutes.plugins.register).send(manifestOf(id)).expect(CREATED)
    }
    const consent = (await agent().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
      scopes: string[]
    }
    const installed = await agent()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: consent.scopes })
      .expect(CREATED)
    const code = (installed.body as { setup: { code: string } }).setup.code
    const exchanged = await http()
      .post(`${API_PREFIX}${PluginApiRoutes.setupExchange}`)
      .set('x-forwarded-for', fromAddress())
      .send({ code })
      .expect(OK)
    const setup = exchanged.body as { apiKey: string; installationId: string }
    return { pluginId: id, installationId: setup.installationId, key: setup.apiKey, storeId }
  }

  const call = (
    method: 'put' | 'delete' | 'post',
    path: string,
    key: string | undefined
  ): supertest.Test => {
    const request = http()[method](`${API_PREFIX}${path}`).set('x-forwarded-for', fromAddress())
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }
  const put = (account: string, key: string, body: object = { displayName: 'Main line' }) =>
    call('put', PluginApiRoutes.channel.connection(account), key).send(body)
  const remove = (account: string, key: string) =>
    call('delete', PluginApiRoutes.channel.connection(account), key)
  const report = (key: string, events: object[]) =>
    call('post', PluginApiRoutes.channel.events, key).send({ events })
  const rowOf = (pluginId: string, account: string) =>
    owner.channelConnection.findUnique({
      where: { pluginId_connectionId: { pluginId, connectionId: account } }
    })
  const jobs = () => queueOf(app, QueueNames.INBOUND).jobs

  const now = () => new Date().toISOString()
  const received = (account: string, over: object = {}): object => ({
    type: ChannelEventTypes.MESSAGE_RECEIVED,
    connectionId: account,
    channelIdentity: 'customer-1',
    message: {
      externalId: `m-${randomUUID()}`,
      type: MessageType.TEXT,
      content: 'hello',
      timestamp: now()
    },
    timestamp: now(),
    ...over
  })

  describe('the key and the scopes', () => {
    let a: Installed

    beforeAll(async () => {
      a = await install(asAdmin, ctx.storeA.id)
    })

    it('needs a key: with none, or with one that does not exist, every route is a 401', async () => {
      const bogus = 'plg_live_does-not-exist'
      for (const key of [undefined, bogus]) {
        expect(
          (
            await call('put', PluginApiRoutes.channel.connection('x'), key).send({
              displayName: 'x'
            })
          ).status
        ).toBe(UNAUTHORIZED)
        expect((await call('delete', PluginApiRoutes.channel.connection('x'), key)).status).toBe(
          UNAUTHORIZED
        )
        expect(
          (await call('post', PluginApiRoutes.channel.events, key).send({ events: [] })).status
        ).toBe(UNAUTHORIZED)
      }
    })

    it('takes the channel scopes alone: the routes name no permission and the key holds no human one', async () => {
      const created = await put('acct-scopes', a.key)
      expect(created.status).toBe(CREATED)
    })

    it('answers 403 PLUGIN_SCOPE_DENIED to a key that lacks the scope of the route', async () => {
      // An installation whose key holds only the scope of the connections cannot report events, and the reverse
      const only = await owner.pluginInstallation.update({
        where: { id: a.installationId },
        data: { scopes: [PluginScopes.CHANNEL_CONNECTIONS] }
      })
      expect(only.scopes).toEqual([PluginScopes.CHANNEL_CONNECTIONS])
      try {
        const events = await report(a.key, [received('acct-scopes')])
        expect(events.status).toBe(FORBIDDEN)
        expect(codeOf(events.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
        await owner.pluginInstallation.update({
          where: { id: a.installationId },
          data: { scopes: [PluginScopes.CHANNEL_EVENTS] }
        })
        const connections = await put('acct-scopes', a.key)
        expect(connections.status).toBe(FORBIDDEN)
        expect(codeOf(connections.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
        expect((await remove('acct-scopes', a.key)).status).toBe(FORBIDDEN)
      } finally {
        await owner.pluginInstallation.update({
          where: { id: a.installationId },
          data: { scopes: [PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS] }
        })
      }
    })

    it('answers 401 to a key whose installation was suspended: no cache to wait for', async () => {
      const row = await owner.pluginInstallation.update({
        where: { id: a.installationId },
        data: { status: 'suspended' }
      })
      try {
        expect(row.status).toBe('suspended')
        expect((await put('acct-suspended', a.key)).status).toBe(UNAUTHORIZED)
      } finally {
        await owner.pluginInstallation.update({
          where: { id: a.installationId },
          data: { status: 'active' }
        })
      }
      expect(await rowOf(a.pluginId, 'acct-suspended')).toBeNull()
    })
  })

  describe('PUT and DELETE /connections/:connectionId', () => {
    let a: Installed
    let b: Installed

    beforeAll(async () => {
      a = await install(asAdmin, ctx.storeA.id)
      b = await install(asAdminSibling, ctx.storeA2.id, a.pluginId)
    })

    it('makes the connection of the installation: 201, the store and the plugin of the key, empty credentials, one audit entry', async () => {
      const response = await put('acct-new', a.key, {
        displayName: 'Main line',
        metadata: { region: 'sv' }
      })
      expect(response.status).toBe(CREATED)

      const row = await rowOf(a.pluginId, 'acct-new')
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        installationId: a.installationId,
        pluginId: a.pluginId,
        displayName: 'Main line',
        status: ChannelConnectionStatus.ACTIVE,
        metadata: { region: 'sv' }
      })
      // Empty credentials: sealed `{}`, so the column is there and holds nothing of the provider
      expect(row?.credentials.length).toBeGreaterThan(0)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.CHANNEL_CONNECTED,
        resourceId: row?.id ?? ''
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.metadata).toMatchObject({
        pluginId: a.pluginId,
        pluginInstallationId: a.installationId
      })
    })

    it('answers 200 and updates the name when it exists, and leaves everything else as it was', async () => {
      await put('acct-same', a.key, { displayName: 'First', metadata: { keep: true } }).expect(
        CREATED
      )
      const again = await put('acct-same', a.key, { displayName: 'Second' })
      expect(again.status).toBe(OK)
      expect(await rowOf(a.pluginId, 'acct-same')).toMatchObject({
        displayName: 'Second',
        metadata: { keep: true },
        status: ChannelConnectionStatus.ACTIVE
      })
    })

    it('refuses what a plugin has no business saying: a store, credentials, an installation, an unknown field', async () => {
      for (const body of [
        { displayName: 'x', storeId: ctx.storeA2.id },
        { displayName: 'x', credentials: { token: 'secret' } },
        { displayName: 'x', installationId: b.installationId },
        { displayName: 'x', status: 'active' },
        { displayName: '' },
        { displayName: 'x'.repeat(RemoteChannelApiLimits.DISPLAY_NAME_MAX_LENGTH + 1) },
        {
          displayName: 'x',
          metadata: { big: 'x'.repeat(RemoteChannelApiLimits.CONNECTION_METADATA_MAX_BYTES) }
        }
      ]) {
        const response = await put('acct-bad', a.key, body)
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      }
      expect(await rowOf(a.pluginId, 'acct-bad')).toBeNull()
    })

    it('refuses a connectionId that is not 128 characters of A-Za-z0-9._:+@-', async () => {
      for (const account of ['has space', 'semi;colon', 'a'.repeat(129), 'ñandú']) {
        const response = await put(account, a.key)
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect((await put('a'.repeat(128) + '', a.key)).status).toBe(CREATED)
      expect((await put('Aa0._:+@-', a.key)).status).toBe(CREATED)
    })

    it('answers 409 when the account is linked to another store and does not touch it, nor say whose it is', async () => {
      await put('acct-taken', a.key, { displayName: 'Of store A' }).expect(CREATED)

      const response = await put('acct-taken', b.key, {
        displayName: 'Hijack',
        metadata: { hijacked: true }
      })
      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect(JSON.stringify(response.body)).not.toContain(ctx.storeA.id)
      expect(JSON.stringify(response.body)).not.toContain(a.installationId)
      expect(await rowOf(a.pluginId, 'acct-taken')).toMatchObject({
        storeId: ctx.storeA.id,
        installationId: a.installationId,
        displayName: 'Of store A',
        metadata: null
      })
      // Not even when its store let it go: the plugin uses a new connectionId to move an account
      await remove('acct-taken', a.key).expect(NO_CONTENT)
      expect((await put('acct-taken', b.key)).status).toBe(CONFLICT)
      expect((await rowOf(a.pluginId, 'acct-taken'))?.storeId).toBe(ctx.storeA.id)
    })

    it('holds 20 connections that are not disconnected, and the ones that are do not count', async () => {
      const limit = RemoteChannelApiLimits.MAX_ACTIVE_CONNECTIONS
      for (let index = 0; index < limit; index += 1) {
        await put(`full-${index}`, b.key).expect(CREATED)
      }
      const over = await put('full-over', b.key)
      expect(over.status).toBe(CONFLICT)
      expect(await rowOf(b.pluginId, 'full-over')).toBeNull()
      // One goes down: there is room for another, and the one that went can come back only when there is room
      await remove('full-0', b.key).expect(NO_CONTENT)
      expect((await put('full-over', b.key)).status).toBe(CREATED)
      const reactivate = await put('full-0', b.key)
      expect(reactivate.status).toBe(CONFLICT)
      expect((await rowOf(b.pluginId, 'full-0'))?.status).toBe(ChannelConnectionStatus.DISCONNECTED)
    })

    it('disconnects: 204, the row and its conversations stay, the credentials are emptied, and again is 204', async () => {
      await put('acct-down', a.key).expect(CREATED)
      const row = await rowOf(a.pluginId, 'acct-down')
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: a.pluginId,
        channelConnectionId: row?.id ?? ''
      })

      await remove('acct-down', a.key).expect(NO_CONTENT)

      const down = await rowOf(a.pluginId, 'acct-down')
      expect(down?.status).toBe(ChannelConnectionStatus.DISCONNECTED)
      expect(down?.credentials.length).toBeGreaterThan(0)
      expect(await owner.conversation.count({ where: { id: conversation.id } })).toBe(1)
      await remove('acct-down', a.key).expect(NO_CONTENT)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.CHANNEL_DISCONNECTED,
        resourceId: row?.id ?? ''
      })
      // The second call changed nothing and left no second entry
      expect(entries).toHaveLength(1)
    })

    it('reactivates a connection that was disconnected: 200, active again', async () => {
      await put('acct-back', a.key).expect(CREATED)
      await remove('acct-back', a.key).expect(NO_CONTENT)
      const back = await put('acct-back', a.key, { displayName: 'Back' })
      expect(back.status).toBe(OK)
      expect(await rowOf(a.pluginId, 'acct-back')).toMatchObject({
        status: ChannelConnectionStatus.ACTIVE,
        displayName: 'Back',
        lastError: null
      })
    })

    it('answers 404 CHANNEL_CONNECTION_NOT_FOUND to a connection of another installation, and to one that does not exist, alike', async () => {
      await put('acct-private', a.key).expect(CREATED)
      const theirs = await remove('acct-private', b.key)
      const nobody = await remove('acct-nobody', b.key)
      expect(theirs.status).toBe(NOT_FOUND)
      expect(nobody.status).toBe(NOT_FOUND)
      expect(codeOf(theirs.body)).toBe(ErrorCodes.CHANNEL_CONNECTION_NOT_FOUND)
      expect(theirs.body).toEqual({
        ...(nobody.body as object),
        correlationId: (theirs.body as { correlationId?: string }).correlationId
      })
      expect((await rowOf(a.pluginId, 'acct-private'))?.status).toBe(ChannelConnectionStatus.ACTIVE)
    })
  })

  describe('POST /events', () => {
    let a: Installed
    let b: Installed

    beforeAll(async () => {
      a = await install(asAdmin, ctx.storeA.id)
      b = await install(asAdminSibling, ctx.storeA2.id, a.pluginId)
      await put('acct-a', a.key).expect(CREATED)
      await put('acct-b', b.key).expect(CREATED)
    })
    beforeEach(() => {
      jobs().length = 0
    })

    it('queues each event on INBOUND under the plugin of the key, with a job id that makes a repeat one job: 202', async () => {
      const first = received('acct-a')
      const second = received('acct-a', { channelIdentity: 'customer-2' })

      const response = await report(a.key, [first, second])

      expect(response.status).toBe(ACCEPTED)
      expect(response.body).toEqual({ accepted: 2 })
      expect(jobs().map(job => job.opts?.jobId)).toEqual([
        inboundJobId(a.pluginId, first as ValidRemoteChannelEvent),
        inboundJobId(a.pluginId, second as ValidRemoteChannelEvent)
      ])
      expect(jobs().every(job => (job.data as { pluginId: string }).pluginId === a.pluginId)).toBe(
        true
      )
    })

    // The events of the reference plugin of the contract suite (`tests/contracts/remote-channel.contract.ts`), at the door
    describe('what the reference plugin reports', () => {
      it("queues an echo of the owner's own account: no capability is needed to say it", async () => {
        const events = referenceEvents('acct-a')

        const response = await report(a.key, [events['echo'] as object])

        expect(response.status).toBe(ACCEPTED)
        expect(response.body).toEqual({ accepted: 1 })
        expect((jobs()[0]?.data as { event: { type: string } }).event.type).toBe(
          ChannelEventTypes.MESSAGE_ECHO
        )
      })

      it('drops a reaction, an edit and a deletion, and says it dropped them: a remote plugin cannot declare those capabilities', async () => {
        const events = referenceEvents('acct-a')

        const response = await report(a.key, [
          events['reaction'] as object,
          events['edited'] as object,
          events['deleted'] as object
        ])

        expect(response.status).toBe(ACCEPTED)
        expect(response.body).toEqual({ accepted: 0 })
        expect(jobs()).toHaveLength(0)
      })

      it('drops the receipts and the typing of a channel that did not declare them', async () => {
        const events = referenceEvents('acct-a')

        const response = await report(a.key, [
          events['delivered'] as object,
          events['read'] as object,
          events['typing'] as object
        ])

        expect(response.body).toEqual({ accepted: 0 })
        expect(jobs()).toHaveLength(0)
      })
    })

    it('takes a batch of fifty events past 100 KB, up to 1 MiB, from a caller with a key', async () => {
      const long = (index: number): object =>
        received('acct-a', {
          channelIdentity: `customer-${index}`,
          message: {
            externalId: `m-${randomUUID()}`,
            type: MessageType.TEXT,
            content: 'x'.repeat(RemoteChannelApiLimits.MESSAGE_CONTENT_MAX_LENGTH),
            timestamp: now()
          }
        })
      const events = Array.from({ length: RemoteChannelApiLimits.MAX_EVENTS_PER_REQUEST }, (_, i) =>
        long(i)
      )
      expect(JSON.stringify({ events }).length).toBeGreaterThan(100 * 1024)

      const response = await report(a.key, events)

      expect(response.status).toBe(ACCEPTED)
      expect(response.body).toEqual({ accepted: events.length })
      expect(jobs()).toHaveLength(events.length)
    })

    it('refuses a body past 1 MiB with 413, and a body past 100 KB from a caller with no key', async () => {
      const padding = 'x'.repeat(RemoteChannelApiLimits.EVENTS_BODY_MAX_BYTES)
      const tooBig = await call('post', PluginApiRoutes.channel.events, a.key).send({
        events: [received('acct-a')],
        padding
      })
      const noKey = await call('post', PluginApiRoutes.channel.events, undefined).send({
        events: [received('acct-a')],
        padding: padding.slice(0, 200 * 1024)
      })

      expect(tooBig.status).toBe(PAYLOAD_TOO_LARGE)
      expect(codeOf(tooBig.body)).toBe(ErrorCodes.PAYLOAD_TOO_LARGE)
      expect(noKey.status).toBe(PAYLOAD_TOO_LARGE)
      expect(jobs()).toHaveLength(0)
    })

    it('refuses the WHOLE request with 404 when one event names a connection of another store, and queues none', async () => {
      const response = await report(a.key, [received('acct-a'), received('acct-b')])
      expect(response.status).toBe(NOT_FOUND)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CONNECTION_NOT_FOUND)
      expect(jobs()).toHaveLength(0)
    })

    it('gives the same 404 for a connection that does not exist and for one that is disconnected', async () => {
      await put('acct-gone', a.key).expect(CREATED)
      await remove('acct-gone', a.key).expect(NO_CONTENT)
      const gone = await report(a.key, [received('acct-gone')])
      const never = await report(a.key, [received('acct-never')])
      expect(gone.status).toBe(NOT_FOUND)
      expect(never.status).toBe(NOT_FOUND)
      expect(jobs()).toHaveLength(0)
    })

    it('refuses with 400 and the paths of what is wrong when one event is invalid, and queues none of the others', async () => {
      const response = await report(a.key, [
        received('acct-a'),
        received('acct-a', { timestamp: '2020-01-01T00:00:00.000Z' })
      ])
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(JSON.stringify(response.body)).toContain('events.1.timestamp')
      expect(jobs()).toHaveLength(0)
    })

    it('does not take a store, a plugin or an installation from the body', async () => {
      const response = await report(a.key, [
        received('acct-a', { storeId: ctx.storeA2.id, pluginId: 'official' })
      ])
      expect(response.status).toBe(BAD_REQUEST)
      expect(jobs()).toHaveLength(0)
    })

    it('refuses an empty list, more than 50 events, and a file that points at a private address', async () => {
      expect((await report(a.key, [])).status).toBe(BAD_REQUEST)
      const many = Array.from({ length: 51 }, () => received('acct-a'))
      expect((await report(a.key, many)).status).toBe(BAD_REQUEST)
      const hostile = received('acct-a', {
        message: {
          externalId: 'm-file',
          type: MessageType.IMAGE,
          content: null,
          media: [
            {
              ref: 'https://169.254.169.254/latest/meta-data',
              contentType: 'image/png',
              filename: null
            }
          ],
          timestamp: now()
        }
      })
      const response = await report(a.key, [hostile])
      expect(response.status).toBe(BAD_REQUEST)
      expect(JSON.stringify(response.body)).toContain('events.0.message.media.0.ref')
      expect(jobs()).toHaveLength(0)
    })

    it('drops a status event about a message that is not on a connection of this installation, and counts the rest', async () => {
      const rowA = await rowOf(a.pluginId, 'acct-a')
      const own = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: a.pluginId,
        channelConnectionId: rowA?.id ?? ''
      })
      const ownMessage = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: own.id,
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id
      })
      // A message of the other installation, in the other store
      const rowB = await rowOf(b.pluginId, 'acct-b')
      const theirConversation = await createConversationOf(owner, {
        storeId: ctx.storeA2.id,
        channelType: b.pluginId,
        channelConnectionId: rowB?.id ?? ''
      })
      const theirMessage = await createMessage(owner, {
        storeId: ctx.storeA2.id,
        conversationId: theirConversation.id,
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id
      })
      const failed = (messageId: string): object => ({
        type: ChannelEventTypes.MESSAGE_FAILED,
        connectionId: 'acct-a',
        channelIdentity: 'customer-1',
        status: { externalId: 'ext-1' },
        messageId,
        timestamp: now()
      })

      const response = await report(a.key, [
        failed(ownMessage.id),
        failed(theirMessage.id),
        failed(randomUUID())
      ])

      expect(response.status).toBe(ACCEPTED)
      expect(response.body).toEqual({ accepted: 1 })
      expect(jobs()).toHaveLength(1)
      expect((jobs()[0]?.data as { event: { messageId: string } }).event.messageId).toBe(
        ownMessage.id
      )
    })

    it('answers 429 with Retry-After past 3000 events a minute, before it looks at anything else', async () => {
      const key = CacheKeys.plugin.channelEventsWindow(a.installationId)
      await redis.set(key, String(RemoteChannelApiLimits.MAX_EVENTS_PER_MINUTE - 1), 'EX', 60)
      try {
        const response = await report(a.key, [received('acct-a'), received('acct-a')])
        expect(response.status).toBe(TOO_MANY_REQUESTS)
        expect(codeOf(response.body)).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
        expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1)
        expect(jobs()).toHaveLength(0)
        // The ceiling is the installation's own: the other one is not slowed down
        expect((await report(b.key, [received('acct-b')])).status).toBe(ACCEPTED)
      } finally {
        await redis.del(key)
      }
    })
  })

  describe('installing a channel', () => {
    it('refuses a scope that is not in the manifest of the channel, and one that is missing, and writes nothing', async () => {
      counter += 1
      const id = `${prefix}-ch${counter}`
      await asAdmin().post(ApiRoutes.plugins.register).send(manifestOf(id)).expect(CREATED)

      const more = await asAdmin()
        .post(ApiRoutes.plugins.install)
        .send({
          pluginId: id,
          scopes: [
            PluginScopes.CHANNEL_CONNECTIONS,
            PluginScopes.CHANNEL_EVENTS,
            PluginScopes.ORDERS_READ
          ]
        })
      const fewer = await asAdmin()
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: id, scopes: [PluginScopes.CHANNEL_CONNECTIONS] })
      const none = await asAdmin()
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: id, scopes: [] })

      for (const response of [more, fewer, none]) {
        expect(response.status).toBe(CONFLICT)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_CONSENT_MISMATCH)
      }
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })

    it('does not register a channel with no scopes: it is installed with them like an integration, so it is a 400, not a 409', async () => {
      counter += 1
      const response = await asAdmin()
        .post(ApiRoutes.plugins.register)
        .send(manifestOf(`${prefix}-ch${counter}`, { scopes: [] }))
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })
  })
})
