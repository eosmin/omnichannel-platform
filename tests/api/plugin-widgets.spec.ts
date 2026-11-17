import { createHash, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  PluginBridgeMessages,
  PluginBridgeOperations,
  PluginInstallationStatus,
  PluginWidgetLimits
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { REDIS_CLIENT } from '@platform/core/redis'
import { PluginScopes } from '@platform/plugins/sdk'

import { createConversationOf, createRole, ensureWidgetPlugin } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const GONE = 410
const BAD_REQUEST = 400
const TOO_MANY_REQUESTS = 429

interface ErrorBody {
  error: { code: string }
}
interface WidgetBody {
  installationId: string
  pluginId: string
  widgetId: string
  url: string
  origin: string
}
interface SessionBody {
  token: string
  expiresInSeconds: number
  origin: string
}
interface BridgeBody {
  ok: boolean
  id: string
  data: Record<string, unknown>
}

const WIDGET_URL = 'https://widgets.acme.example/panel'

describe('the widgets of the plugins in the agent sidebar', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-acme-widget`.slice(0, 60)
  const readOnlyPluginId = `${prefix}-acme-conversations-only`.slice(0, 60)
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let installationId: string
  let readOnlyInstallationId: string
  let conversationId: string
  let customerId: string

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    installationId = (
      await ensureWidgetPlugin(owner, {
        storeId: ctx.storeA.id,
        pluginId,
        widgetUrl: WIDGET_URL,
        scopes: [PluginScopes.CONVERSATIONS_READ, PluginScopes.CUSTOMERS_READ]
      })
    ).id
    readOnlyInstallationId = (
      await ensureWidgetPlugin(owner, {
        storeId: ctx.storeA.id,
        pluginId: readOnlyPluginId,
        widgetUrl: WIDGET_URL,
        scopes: [PluginScopes.CONVERSATIONS_READ]
      })
    ).id
    const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
    conversationId = conversation.id
    customerId = conversation.customerId
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { in: [pluginId, readOnlyPluginId] } } })
    await app.close()
    await owner.$disconnect()
  })

  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const open = async (id = installationId, conversation = conversationId): Promise<string> => {
    const response = await asAgent()
      .post(ApiRoutes.pluginWidgets.sessions)
      .send({ installationId: id, conversationId: conversation })
    expect(response.status).toBe(CREATED)
    return (response.body as SessionBody).token
  }
  const ask = (token: string, operation: string, id = 'req-1') =>
    asAgent()
      .post(ApiRoutes.pluginWidgets.bridge)
      .send({ token, request: { type: PluginBridgeMessages.REQUEST, id, operation } })

  it('lists the widgets of the store with their origin and never a key', async () => {
    const response = await asAgent().get(ApiRoutes.pluginWidgets.list)
    expect(response.status).toBe(OK)
    const mine = (response.body as WidgetBody[]).filter(widget => widget.pluginId === pluginId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      installationId,
      widgetId: 'info',
      url: WIDGET_URL,
      origin: 'https://widgets.acme.example'
    })
    expect(JSON.stringify(response.body)).not.toMatch(/apiKey|api_key|secret/i)
  })

  it('does not list the widgets of another store', async () => {
    const response = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.pluginWidgets.list)
    expect(response.status).toBe(OK)
    expect((response.body as WidgetBody[]).map(widget => widget.pluginId)).not.toContain(pluginId)
  })

  it('answers the conversation and the customer of the session, and nothing more than the minimum', async () => {
    const token = await open()
    const conversation = await ask(token, PluginBridgeOperations.CONVERSATION_GET)
    expect(conversation.status).toBe(OK)
    expect((conversation.body as BridgeBody).data).toMatchObject({ id: conversationId })
    expect(Object.keys((conversation.body as BridgeBody).data).sort()).toEqual([
      'channelType',
      'createdAt',
      'id',
      'lastInboundAt',
      'status',
      'tags'
    ])
    const customer = await ask(token, PluginBridgeOperations.CUSTOMER_GET)
    expect(customer.status).toBe(OK)
    expect((customer.body as BridgeBody).data).toMatchObject({ id: customerId })
    expect(Object.keys((customer.body as BridgeBody).data).sort()).toEqual([
      'email',
      'id',
      'locale',
      'name',
      'phone'
    ])
  })

  it('refuses with 403 what the installation holds no scope for', async () => {
    const token = await open(readOnlyInstallationId)
    expect((await ask(token, PluginBridgeOperations.CONVERSATION_GET)).status).toBe(OK)
    const denied = await ask(token, PluginBridgeOperations.CUSTOMER_GET)
    expect(denied.status).toBe(FORBIDDEN)
    expect((denied.body as ErrorBody).error.code).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
  })

  it('refuses a session for a conversation of another store, as a conversation that does not exist', async () => {
    const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })
    const response = await asAgent()
      .post(ApiRoutes.pluginWidgets.sessions)
      .send({ installationId, conversationId: foreign.id })
    expect(response.status).toBe(NOT_FOUND)
  })

  it('refuses a session for an installation of another store', async () => {
    const response = await api(app, ctx.adminB, ctx.storeB)
      .post(ApiRoutes.pluginWidgets.sessions)
      .send({ installationId, conversationId })
    expect(response.status).toBe(NOT_FOUND)
  })

  it('does not honour a session in another store or for another person', async () => {
    const token = await open()
    const otherStore = await api(app, ctx.adminB, ctx.storeB)
      .post(ApiRoutes.pluginWidgets.bridge)
      .send({
        token,
        request: {
          type: PluginBridgeMessages.REQUEST,
          id: 'x',
          operation: PluginBridgeOperations.CONVERSATION_GET
        }
      })
    expect(otherStore.status).toBe(GONE)
    const otherPerson = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.pluginWidgets.bridge)
      .send({
        token,
        request: {
          type: PluginBridgeMessages.REQUEST,
          id: 'x',
          operation: PluginBridgeOperations.CONVERSATION_GET
        }
      })
    expect(otherPerson.status).toBe(GONE)
    expect((otherPerson.body as ErrorBody).error.code).toBe(
      ErrorCodes.PLUGIN_WIDGET_SESSION_INVALID
    )
  })

  it('refuses an unknown token and an operation the bridge does not have', async () => {
    const unknown = await ask(randomUUID(), PluginBridgeOperations.CONVERSATION_GET)
    expect(unknown.status).toBe(GONE)
    const token = await open()
    const invented = await ask(token, 'orders.list')
    expect(invented.status).toBe(BAD_REQUEST)
  })

  it('stops a session at once when the installation is revoked', async () => {
    const token = await open()
    expect((await ask(token, PluginBridgeOperations.CONVERSATION_GET)).status).toBe(OK)
    await owner.pluginInstallation.update({
      where: { id: installationId },
      data: { status: PluginInstallationStatus.REVOKED, revokedAt: new Date() }
    })
    try {
      expect((await ask(token, PluginBridgeOperations.CONVERSATION_GET)).status).toBe(GONE)
      const list = await asAgent().get(ApiRoutes.pluginWidgets.list)
      expect((list.body as WidgetBody[]).map(widget => widget.pluginId)).not.toContain(pluginId)
    } finally {
      await owner.pluginInstallation.update({
        where: { id: installationId },
        data: { status: PluginInstallationStatus.ACTIVE, revokedAt: null }
      })
    }
  })

  it('ends the sessions already open when the manifest moves the widget onto a platform host', async () => {
    const token = await open()
    expect((await ask(token, PluginBridgeOperations.CONVERSATION_GET)).status).toBe(OK)
    await owner.plugin.update({
      where: { id: pluginId },
      data: {
        manifest: {
          ui: { widget: 'https://localhost/panel' },
          widgets: [{ id: 'info', name: 'Info' }]
        }
      }
    })
    try {
      expect((await ask(token, PluginBridgeOperations.CONVERSATION_GET)).status).toBe(GONE)
    } finally {
      await ensureWidgetPlugin(owner, {
        storeId: ctx.storeA.id,
        pluginId,
        widgetUrl: WIDGET_URL,
        scopes: [PluginScopes.CONVERSATIONS_READ, PluginScopes.CUSTOMERS_READ]
      })
    }
  })

  it('treats a value that is not a session as no session, never as a 500', async () => {
    const token = await open()
    const redis = app.get<Redis>(REDIS_CLIENT, { strict: false })
    const key = CacheKeys.pluginWidget.session(
      ctx.storeA.id,
      createHash('sha256').update(token).digest('hex')
    )
    await redis.set(key, '{not json', 'EX', 60)
    expect((await ask(token, PluginBridgeOperations.CONVERSATION_GET)).status).toBe(GONE)
  })

  it('never lets the plugin read what the person could not: the scope is held, the permission is not', async () => {
    const roleId = (
      await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW]
      })
    ).id
    const limited = await createActor(owner, app, {
      prefix,
      name: 'limited',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId
    })
    const asLimited = () => api(app, limited, ctx.storeA)
    const session = await asLimited()
      .post(ApiRoutes.pluginWidgets.sessions)
      .send({ installationId, conversationId })
    expect(session.status).toBe(CREATED)
    const token = (session.body as SessionBody).token
    const send = (operation: string) =>
      asLimited()
        .post(ApiRoutes.pluginWidgets.bridge)
        .send({ token, request: { type: PluginBridgeMessages.REQUEST, id: 'p', operation } })
    expect((await send(PluginBridgeOperations.CONVERSATION_GET)).status).toBe(OK)
    const denied = await send(PluginBridgeOperations.CUSTOMER_GET)
    expect(denied.status).toBe(FORBIDDEN)
    expect((denied.body as ErrorBody).error.code).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
  })

  it('refuses a session for a conversation the person may not see, in their own store', async () => {
    const roleId = (
      await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW]
      })
    ).id
    const limited = await createActor(owner, app, {
      prefix,
      name: 'limited-view',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId
    })
    // Assigned to somebody else, and the person does not hold CONVERSATIONS_VIEW_ALL
    const others = await createConversationOf(owner, {
      storeId: ctx.storeA.id,
      assignedTo: ctx.adminA.id
    })
    const response = await api(app, limited, ctx.storeA)
      .post(ApiRoutes.pluginWidgets.sessions)
      .send({ installationId, conversationId: others.id })
    expect(response.status).toBe(NOT_FOUND)
  })

  it('limits the sessions a person opens for one installation in a minute', async () => {
    let last = CREATED
    for (let i = 0; i <= PluginWidgetLimits.SESSIONS_PER_MINUTE; i += 1) {
      last = (
        await asAgent()
          .post(ApiRoutes.pluginWidgets.sessions)
          .send({ installationId: readOnlyInstallationId, conversationId })
      ).status
    }
    expect(last).toBe(TOO_MANY_REQUESTS)
  })

  it('refuses once the budget of the bridge of a person for an installation is used, and counts it by itself (WID-053)', async () => {
    const token = await open()
    const redis = app.get<Redis>(REDIS_CLIENT, { strict: false })
    const key = CacheKeys.pluginWidget.bridgeRequests(ctx.storeA.id, ctx.agentA.id, installationId)
    try {
      // One request left in the window
      await redis.set(
        key,
        PluginWidgetLimits.BRIDGE_REQUESTS_PER_MINUTE - 1,
        'EX',
        PluginWidgetLimits.BRIDGE_WINDOW_SECONDS
      )

      expect((await ask(token, PluginBridgeOperations.CONVERSATION_GET, 'last')).status).toBe(OK)
      const refused = await ask(token, PluginBridgeOperations.CONVERSATION_GET, 'over')

      expect(refused.status).toBe(TOO_MANY_REQUESTS)
      expect((refused.body as { error: { code: string; message: string } }).error).toMatchObject({
        code: ErrorCodes.RATE_LIMIT_EXCEEDED,
        message: 'too many widget requests'
      })
      // Both requests were counted by the bridge, the refused one too
      expect(Number(await redis.get(key))).toBe(PluginWidgetLimits.BRIDGE_REQUESTS_PER_MINUTE + 1)
    } finally {
      await redis.del(key)
    }
  })

  it('does not keep the token at rest and ends it by itself', async () => {
    const token = await open()
    const redis = app.get<Redis>(REDIS_CLIENT, { strict: false })
    const keys = await redis.keys(`store:${ctx.storeA.id}:plugin-widget:*`)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.some(key => key.includes(token))).toBe(false)
    // It ends by itself, within its five minutes
    const ttl = await redis.ttl(
      CacheKeys.pluginWidget.session(
        ctx.storeA.id,
        createHash('sha256').update(token).digest('hex')
      )
    )
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(PluginWidgetLimits.SESSION_TTL_SECONDS)
  })
})
