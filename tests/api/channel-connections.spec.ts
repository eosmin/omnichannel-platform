import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { CONNECTION_ROW_SELECT, ChannelHealthService } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { CredentialCipher } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelConnectionStatus, ChannelHealthErrors } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginRegistry } from '@platform/plugins/runtime'
import { type ChannelPlugin, PluginError } from '@platform/plugins/sdk'

import { buildChannelPlugin, ensurePluginInstallation } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const SECRET = 'EAAB-super-secret-token'

interface ErrorBody {
  error: { code: string; message?: string }
}
interface ConnectionBody {
  id: string
  pluginId: string
  displayName: string
  status: string
  lastError: string | null
  capabilities: string[]
}

describe('The channel connections of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let registry: PluginRegistry
  let counter = 0
  const disconnected: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(PluginRegistry, { strict: false })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code

  // A plugin of its own for each test: the registry refuses an id twice
  function register(over: Partial<ChannelPlugin> = {}, connectionId = `acct-${randomUUID()}`) {
    counter += 1
    const id = `conn_${counter}`
    const plugin = buildChannelPlugin({
      id,
      connect: input =>
        Promise.resolve({
          connectionId,
          displayName: 'Acme account',
          credentials: input.credentials,
          metadata: { region: 'sv' }
        }),
      disconnect: () => {
        disconnected.push(id)
        return Promise.resolve()
      },
      ...over
    })
    registry.register(plugin)
    return { id, plugin, connectionId }
  }
  // The plugin is installed in both stores first, as the catalog would do: connecting needs it
  const connect = async (pluginId: string, agent = asAdmin) => {
    await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId })
    await ensurePluginInstallation(owner, { storeId: ctx.storeB.id, pluginId })
    return agent()
      .post(ApiRoutes.channels.connect(pluginId))
      .send({ credentials: { token: SECRET } })
  }

  async function auditCount(action: string, resourceId: string, expected: number) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = await owner.auditLog.count({ where: { action, resourceId } })
      if (count >= expected) return count
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return owner.auditLog.count({ where: { action, resourceId } })
  }

  describe('connecting', () => {
    it('stores it active, with the credentials encrypted, and audits it', async () => {
      const { id } = register()

      const response = await connect(id)

      expect(response.status).toBe(CREATED)
      const body = response.body as ConnectionBody
      expect(body).toMatchObject({ pluginId: id, displayName: 'Acme account', status: 'active' })
      expect(JSON.stringify(body)).not.toContain(SECRET)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(Buffer.from(row.credentials).toString('utf8')).not.toContain(SECRET)
      const cipher = app.get(CredentialCipher, { strict: false })
      expect(cipher.open(row.credentials)).toEqual({ token: SECRET })
      expect(await auditCount(AuditAction.CHANNEL_CONNECTED, body.id, 1)).toBe(1)
    })

    it('updates the same account of the same store instead of making another', async () => {
      const { id } = register()

      const first = await connect(id)
      const second = await connect(id)

      expect((second.body as ConnectionBody).id).toBe((first.body as ConnectionBody).id)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
    })

    it('refuses an account that another store already connected, and leaves it as it was', async () => {
      const { id } = register()
      const theirs = await connect(id, asAdminB)

      const response = await connect(id)

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      const row = await owner.channelConnection.findUniqueOrThrow({
        where: { id: (theirs.body as ConnectionBody).id }
      })
      expect(row.storeId).toBe(ctx.storeB.id)
    })

    it('does not say what the provider said when it refuses the credentials', async () => {
      const { id } = register({
        connect: () => Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID))
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      expect(JSON.stringify(response.body)).not.toContain(SECRET)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })

    it('gives the same new account to one of two stores that ask at the same moment, never a 500', async () => {
      const { id } = register()

      const [a, b] = await Promise.all([connect(id), connect(id, asAdminB)])

      expect([a.status, b.status].sort()).toEqual([CREATED, CONFLICT])
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
    })

    it('makes one connection of two clicks of the same store', async () => {
      const { id } = register()

      const [a, b] = await Promise.all([connect(id), connect(id)])

      expect([a.status, b.status]).toEqual([CREATED, CREATED])
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
    })

    it('gives an account that its store disconnected to another store, keeping the old row', async () => {
      const { id } = register()
      const first = (await connect(id)).body as ConnectionBody
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id))

      const second = await connect(id, asAdminB)

      expect(second.status).toBe(CREATED)
      const old = await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })
      expect(old).toMatchObject({
        storeId: ctx.storeA.id,
        status: ChannelConnectionStatus.DISCONNECTED
      })
      expect(old.connectionId).toContain('~released~')
      const fresh = await owner.channelConnection.findUniqueOrThrow({
        where: { id: (second.body as ConnectionBody).id }
      })
      expect(fresh.storeId).toBe(ctx.storeB.id)
    })

    it.each([
      ['an account id with a NUL character', { connectionId: 'acct\u0000x' }],
      ['metadata with a NUL character', { metadata: { name: 'a\u0000b' } }]
    ])('answers 400, not 500, for %s', async (_label, over) => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-nul',
            displayName: 'x',
            credentials: {},
            metadata: {},
            ...over
          })
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })

    it('uses the account id when nothing is left of the name after it is cleaned', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-blank',
            displayName: '\u200B\u200B',
            credentials: {},
            metadata: {}
          })
      })

      const response = await connect(id)

      expect((response.body as ConnectionBody).displayName).toBe('acct-blank')
    })

    it('cleans the name that a plugin gives to the account before it is kept', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-name',
            displayName: 'Acme\u202E evil\u200B name',
            credentials: {},
            metadata: {}
          })
      })

      const response = await connect(id)

      expect((response.body as ConnectionBody).displayName).toBe('Acme evil name')
    })

    it('refuses credentials that cannot be written down, as a plugin that answered badly', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-big',
            displayName: 'x',
            credentials: { n: BigInt(1) },
            metadata: {}
          })
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    })

    it('does not keep what a plugin returns that does not fit', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: '',
            displayName: 'x',
            credentials: {},
            metadata: {}
          })
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })

    it('is not there for a channel nobody registered, or one private to another store', async () => {
      counter += 1
      const privateId = `conn_${counter}`
      registry.register(buildChannelPlugin({ id: privateId }), { storeIds: [ctx.storeA2.id] })

      const unknown = await connect('telegram')
      const foreign = await connect(privateId)

      expect(unknown.status).toBe(NOT_FOUND)
      expect(foreign.status).toBe(NOT_FOUND)
    })

    it('needs the permission to change settings', async () => {
      const { id } = register()

      const response = await connect(id, asAgent)

      expect(response.status).toBe(FORBIDDEN)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })
  })

  describe('seeing them', () => {
    it('lists those of the store only, with no credentials', async () => {
      const mine = register()
      const theirs = register()
      await connect(mine.id)
      await connect(theirs.id, asAdminB)

      const list = await asAdmin().get(ApiRoutes.channels.connections)

      const items = list.body as ConnectionBody[]
      const ids = items.map(item => item.pluginId)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
      expect(JSON.stringify(list.body)).not.toContain('credentials')
    })

    it('says what each channel can do, so that the web app draws only that', async () => {
      const { id, plugin } = register()
      await connect(id)

      const list = await asAdmin().get(ApiRoutes.channels.connections)

      const item = (list.body as ConnectionBody[]).find(each => each.pluginId === id)
      expect(item?.capabilities.slice().sort()).toEqual([...plugin.capabilities].sort())
    })
  })

  describe('testing one', () => {
    it('puts it in error when the plugin says it is not well, and back when it is', async () => {
      let healthy = false
      const { id } = register({
        healthCheck: () =>
          Promise.resolve({
            healthy,
            checkedAt: new Date().toISOString(),
            ...(healthy ? {} : { error: `the token ${SECRET}\nwas revoked` })
          })
      })
      const made = (await connect(id)).body as ConnectionBody

      const down = await asAdmin().post(ApiRoutes.channels.test(made.id))
      const afterDown = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      healthy = true
      const up = await asAdmin().post(ApiRoutes.channels.test(made.id))
      const afterUp = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })

      expect(down.status).toBe(OK)
      expect(down.body).toMatchObject({ healthy: false })
      expect(afterDown.status).toBe(ChannelConnectionStatus.ERROR)
      expect(afterDown.lastError).not.toContain('\n')
      expect(up.body).toMatchObject({ healthy: true })
      expect(afterUp).toMatchObject({ status: ChannelConnectionStatus.ACTIVE, lastError: null })
    })

    it('counts a plugin that throws or answers nonsense as not well, and keeps what it said out', async () => {
      const throwing = register({ healthCheck: () => Promise.reject(new Error(`bad ${SECRET}`)) })
      const nonsense = register({ healthCheck: () => Promise.resolve({ ok: true } as never) })
      const a = (await connect(throwing.id)).body as ConnectionBody
      const b = (await connect(nonsense.id)).body as ConnectionBody

      const first = await asAdmin().post(ApiRoutes.channels.test(a.id))
      const second = await asAdmin().post(ApiRoutes.channels.test(b.id))

      expect(first.body).toMatchObject({ healthy: false })
      expect(second.body).toMatchObject({ healthy: false })
      expect(JSON.stringify([first.body, second.body])).not.toContain(SECRET)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: a.id } })
      expect(row.lastError ?? '').not.toContain(SECRET)
    })

    it('keeps the code too when the reason is only invisible characters', async () => {
      const { id } = register({
        healthCheck: () =>
          Promise.resolve({
            healthy: false,
            checkedAt: new Date().toISOString(),
            error: '\u200B\u200B  '
          })
      })
      const made = (await connect(id)).body as ConnectionBody

      await asAdmin().post(ApiRoutes.channels.test(made.id))

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.lastError).toBe(ChannelHealthErrors.UNSPECIFIED)
    })

    it('keeps a code, not an English sentence, when the plugin gave no reason', async () => {
      const { id } = register({
        healthCheck: () => Promise.resolve({ healthy: false, checkedAt: new Date().toISOString() })
      })
      const made = (await connect(id)).body as ConnectionBody

      await asAdmin().post(ApiRoutes.channels.test(made.id))

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.lastError).toBe(ChannelHealthErrors.UNSPECIFIED)
    })

    it('does not reach the connection of another store', async () => {
      const { id } = register()
      const theirs = (await connect(id, asAdminB)).body as ConnectionBody

      const response = await asAdmin().post(ApiRoutes.channels.test(theirs.id))

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('the round of the scheduler', () => {
    it('checks every connection that is up or in error and says how many were not well', async () => {
      const well = register()
      const ill = register({
        healthCheck: () => Promise.resolve({ healthy: false, checkedAt: new Date().toISOString() })
      })
      const a = (await connect(well.id)).body as ConnectionBody
      const b = (await connect(ill.id)).body as ConnectionBody
      const plugins = new Map([well, ill].map(entry => [entry.id, entry.plugin]))

      const result = await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(pluginId => plugins.get(pluginId))

      expect(result.checked).toBeGreaterThanOrEqual(2)
      expect(result.unhealthy).toBeGreaterThanOrEqual(1)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: a.id } })).status
      ).toBe(ChannelConnectionStatus.ACTIVE)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: b.id } })).status
      ).toBe(ChannelConnectionStatus.ERROR)
    })

    it('does not undo a disconnect that happened while the check was running', async () => {
      const { id, plugin } = register()
      const made = (await connect(id)).body as ConnectionBody
      const stale = await owner.channelConnection.findUniqueOrThrow({
        where: { id: made.id },
        select: CONNECTION_ROW_SELECT
      })
      await asAdmin().post(ApiRoutes.channels.disconnect(made.id))
      const health = app.get(ChannelHealthService, { strict: false })

      await health.record(stale, { healthy: true })
      await health.record(stale, { healthy: false, error: 'late' })
      await health.checkAll(() => plugin, 0)

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
    })

    it('does not change a connection whose credentials cannot be opened: the fault is ours', async () => {
      const { id, plugin } = register()
      // Written by a builder with bytes that this key never sealed, as after a change of key
      const installation = await ensurePluginInstallation(owner, {
        storeId: ctx.storeA.id,
        pluginId: id
      })
      const row = await owner.channelConnection.create({
        data: {
          storeId: ctx.storeA.id,
          pluginId: id,
          installationId: installation.id,
          connectionId: `broken-${randomUUID()}`,
          displayName: 'broken',
          credentials: Buffer.from('not a sealed value')
        }
      })

      const result = await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(pluginId => (pluginId === id ? plugin : undefined))

      expect(result.checked).toBeGreaterThanOrEqual(0)
      const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: row.id } })
      expect(after).toMatchObject({ status: ChannelConnectionStatus.ACTIVE, lastError: null })
    })

    it('starts no check when the budget of the round is spent', async () => {
      const { id, plugin } = register()
      await connect(id)

      const result = await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(() => plugin, 0)

      expect(result).toEqual({ checked: 0, unhealthy: 0 })
    })

    it('leaves a connection alone when its plugin is not registered any more', async () => {
      const { id } = register()
      const made = (await connect(id)).body as ConnectionBody

      await app.get(ChannelHealthService, { strict: false }).checkAll(() => undefined)

      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })).status
      ).toBe(ChannelConnectionStatus.ACTIVE)
    })

    it('does not bring a disconnected connection back', async () => {
      const { id, plugin } = register()
      const made = (await connect(id)).body as ConnectionBody
      await asAdmin().post(ApiRoutes.channels.disconnect(made.id))

      await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(pluginId => (pluginId === id ? plugin : undefined))

      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })).status
      ).toBe(ChannelConnectionStatus.DISCONNECTED)
    })
  })

  describe('disconnecting', () => {
    it('tells the provider, empties the credentials and keeps the row, once however often it is asked', async () => {
      const { id } = register()
      const made = (await connect(id)).body as ConnectionBody

      const first = await asAdmin().post(ApiRoutes.channels.disconnect(made.id))
      const second = await asAdmin().post(ApiRoutes.channels.disconnect(made.id))

      expect(first.status).toBe(OK)
      expect(first.body).toMatchObject({ status: 'disconnected' })
      expect(second.status).toBe(OK)
      expect(disconnected.filter(entry => entry === id)).toHaveLength(1)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
      expect(app.get(CredentialCipher, { strict: false }).open(row.credentials)).toEqual({})
      expect(await auditCount(AuditAction.CHANNEL_DISCONNECTED, made.id, 1)).toBe(1)
    })

    it('audits and announces one disconnect when two arrive at the same moment', async () => {
      const { id } = register()
      const made = (await connect(id)).body as ConnectionBody

      const [a, b] = await Promise.all([
        asAdmin().post(ApiRoutes.channels.disconnect(made.id)),
        asAdmin().post(ApiRoutes.channels.disconnect(made.id))
      ])

      expect([a.status, b.status]).toEqual([OK, OK])
      expect(await auditCount(AuditAction.CHANNEL_DISCONNECTED, made.id, 1)).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.CHANNEL_DISCONNECTED, resourceId: made.id }
        })
      ).toBe(1)
    })

    it('goes down here even when the provider does not answer', async () => {
      const { id } = register({ disconnect: () => Promise.reject(new Error(`down ${SECRET}`)) })
      const made = (await connect(id)).body as ConnectionBody

      const response = await asAdmin().post(ApiRoutes.channels.disconnect(made.id))

      expect(response.status).toBe(OK)
      expect(JSON.stringify(response.body)).not.toContain(SECRET)
    })

    it('does not reach the connection of another store', async () => {
      const { id } = register()
      const theirs = (await connect(id, asAdminB)).body as ConnectionBody

      const response = await asAdmin().post(ApiRoutes.channels.disconnect(theirs.id))

      expect(response.status).toBe(NOT_FOUND)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: theirs.id } })).status
      ).toBe(ChannelConnectionStatus.ACTIVE)
    })
  })
})
