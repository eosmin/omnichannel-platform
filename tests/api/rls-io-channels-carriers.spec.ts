import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { CarrierId, ChannelConnectionStatus } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { CarrierRegistry, PluginRegistry } from '@platform/plugins/runtime'

import {
  buildChannelPlugin,
  buildFakeCarrier,
  createCarrierConnection,
  type FakeCarrier,
  ensurePluginInstallation
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = HttpStatusCodes.OK
const CREATED = HttpStatusCodes.CREATED
const TOKEN = 'io-token'

// RLS phase 6: the routes that ask the provider of a channel or a carrier (the check of a connection, the replacement of its token) are
// @NoTenantTransaction. With the interceptor ON and the guard of PrismaService ON, the provider must be asked with NO tenant context open
// (no connection of the pool waits for it), and the rows it reads and writes are in short units of the store that work.
describe('RLS phase 6: the provider is asked with no context open', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let registry: PluginRegistry
  let fake: FakeCarrier
  let carrierConnectionId = ''
  let counter = 0
  // The account the next call to `connect` names: a plugin that now names another one is refused
  let account: string | undefined
  const opened: { call: string; tenantOpen: boolean }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(PluginRegistry, { strict: false })
    fake = buildFakeCarrier({ id: CarrierId.FORZA })
    const check = fake.plugin.healthCheck.bind(fake.plugin)
    app.get(CarrierRegistry, { strict: false }).register({
      ...fake.plugin,
      healthCheck: context => {
        opened.push({ call: 'carrier.healthCheck', tenantOpen: guarded.hasTenantContext() })
        return check(context)
      }
    })
    carrierConnectionId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.FORZA })
    ).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    opened.length = 0
    account = undefined
  })

  const admin = () => api(app, ctx.adminA, ctx.storeA)

  // A channel that records whether a context was open when each of its calls arrived
  function register(): string {
    counter += 1
    const id = `conn_io_${counter}`
    registry.register(
      buildChannelPlugin({
        id,
        connect: input => {
          opened.push({ call: 'connect', tenantOpen: guarded.hasTenantContext() })
          return Promise.resolve({
            connectionId: account ?? `acct-${id}`,
            displayName: 'Acme account',
            credentials: input.credentials,
            metadata: {}
          })
        },
        healthCheck: () => {
          opened.push({ call: 'healthCheck', tenantOpen: guarded.hasTenantContext() })
          return Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() })
        }
      })
    )
    return id
  }
  async function connected(): Promise<string> {
    const id = register()
    await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId: id })
    const made = await admin()
      .post(ApiRoutes.channels.connect(id))
      .send({ credentials: { token: TOKEN } })
    expect(made.status).toBe(CREATED)
    opened.length = 0
    return (made.body as { id: string }).id
  }

  it('checks a channel connection: the provider is asked with no context, and the verdict is written in a unit', async () => {
    const connectionId = await connected()

    const response = await admin().post(ApiRoutes.channels.test(connectionId))

    expect(response.status).toBe(OK)
    expect(response.body).toMatchObject({ healthy: true })
    expect(opened).toEqual([{ call: 'healthCheck', tenantOpen: false }])
    const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })
    expect(row.status).toBe(ChannelConnectionStatus.ACTIVE)
    expect(row.lastHealthyAt).not.toBeNull()
  })

  it('replaces the token of a connection: the provider is asked twice with no context, and the new credentials are written', async () => {
    const connectionId = await connected()
    const before = await owner.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })

    const response = await admin()
      .post(ApiRoutes.channels.updateToken(connectionId))
      .send({ credentials: { token: `${TOKEN}-2` } })

    expect(response.status).toBe(OK)
    expect(opened).toEqual([
      { call: 'healthCheck', tenantOpen: false },
      { call: 'connect', tenantOpen: false }
    ])
    const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })
    expect(Buffer.from(after.credentials).equals(Buffer.from(before.credentials))).toBe(false)
    // The entry of the audit is queued with the unit of the write: it exists once the unit committed
    const entries = await waitForAuditEntries(owner, {
      action: AuditAction.CHANNEL_TOKEN_UPDATED,
      resourceId: connectionId
    })
    expect(entries).toHaveLength(1)
  })

  it('writes nothing and no entry when the provider names another account for the new token', async () => {
    const connectionId = await connected()
    const before = await owner.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })
    account = 'another-account'

    const response = await admin()
      .post(ApiRoutes.channels.updateToken(connectionId))
      .send({ credentials: { token: `${TOKEN}-3` } })

    expect(response.status).toBe(HttpStatusCodes.BAD_REQUEST)
    expect(opened.every(call => !call.tenantOpen)).toBe(true)
    const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })
    expect(Buffer.from(after.credentials).equals(Buffer.from(before.credentials))).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.CHANNEL_TOKEN_UPDATED, resourceId: connectionId }
      })
    ).toBe(0)
  })

  it('does not touch the connection of another store: the same answer as one that does not exist', async () => {
    const connectionId = await connected()

    const response = await api(app, ctx.adminB, ctx.storeB).post(
      ApiRoutes.channels.test(connectionId)
    )

    expect(response.status).toBe(HttpStatusCodes.NOT_FOUND)
    expect(opened).toEqual([])
  })

  it('checks a carrier connection: the carrier is asked with no context open', async () => {
    const response = await admin().post(ApiRoutes.carriers.test(carrierConnectionId))

    expect(response.status).toBe(OK)
    expect(opened).toEqual([{ call: 'carrier.healthCheck', tenantOpen: false }])
  })
})
