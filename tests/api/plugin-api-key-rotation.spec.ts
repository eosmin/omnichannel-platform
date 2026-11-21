import { randomInt } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { hashToken } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PLUGIN_REVOKE_CONFIRMATION,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginInstallLimits,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { PluginScopes } from '@platform/plugins/sdk'

import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404

interface SetupBody {
  apiKey: string
  installationId: string
}
interface RotationBody {
  apiKey: string
  apiKeyPrefix: string
  rotatedAt: string
}

// TDD_10 §6.7.3, Step 7.3 (HC-216): the owner rotates the API key of an installation. The new key is shown once and the old one
// stops opening the door at that very call (no grace window: a key that is rotated is a key that may be exposed)
describe('Rotating the API key of a plugin installation', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminSibling = () => api(app, ctx.adminA2, ctx.storeA2)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const withKey = (key: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      .get(`${API_PREFIX}${PluginApiRoutes.installation}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .set('authorization', `Bearer ${key}`)
  }
  const exchange = (code: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      .post(`${API_PREFIX}${PluginApiRoutes.setupExchange}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .send({ code })
  }
  const manifestOf = (id: string, type: string) => ({
    id,
    version: '1.0.0',
    name: `Plugin ${id}`,
    description: 'A plugin that runs outside the platform',
    author: { name: 'Acme Inc', email: 'support@acme.com' },
    type,
    pricing: { model: PluginPricingModels.FREE },
    ...(type === String(PluginCatalogTypes.CHANNEL)
      ? {
          capabilities: ['text'],
          channel: { label: 'Acme', commandsUrl: 'https://acme.com/platform/commands' },
          scopes: [PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS],
          ui: { settings: 'https://acme.com/plugin/settings' }
        }
      : { scopes: [PluginScopes.ORDERS_READ] })
  })
  const install = async (type: string = PluginCatalogTypes.INTEGRATION) => {
    counter += 1
    const id = `${prefix}-k${counter}`
    await asAdmin().post(ApiRoutes.plugins.register).send(manifestOf(id, type)).expect(CREATED)
    const consent = (await asAdmin().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
      scopes: string[]
    }
    const installed = await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: consent.scopes })
      .expect(CREATED)
    const offer = (installed.body as { setup: { code: string } }).setup
    return { id, code: offer.code }
  }
  const setUp = async (type?: string) => {
    const { id, code } = await install(type)
    const setup = (await exchange(code).expect(OK)).body as SetupBody
    return { id, setup }
  }
  const rotate = (installationId: string, agent = asAdmin) =>
    agent().post(ApiRoutes.plugins.apiKey(installationId))

  it('gives a new key once, and the old one stops opening the door at once', async () => {
    const { setup } = await setUp()
    await withKey(setup.apiKey).expect(OK)

    const response = await rotate(setup.installationId).expect(OK)

    const body = response.body as RotationBody
    expect(body.apiKey.startsWith(PLUGIN_API_KEY_TOKEN_PREFIX)).toBe(true)
    expect(body.apiKey).not.toBe(setup.apiKey)
    expect(body.apiKeyPrefix).toBe(
      body.apiKey.slice(0, PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH)
    )
    expect(response.headers['cache-control']).toMatch(/no-store/)
    await withKey(setup.apiKey).expect(UNAUTHORIZED)
    const ok = await withKey(body.apiKey).expect(OK)
    expect((ok.body as { installationId: string }).installationId).toBe(setup.installationId)
  })

  it('keeps only the hash and the display prefix, never the key', async () => {
    const { setup } = await setUp()

    const body = (await rotate(setup.installationId).expect(OK)).body as RotationBody

    const row = await owner.pluginInstallation.findUniqueOrThrow({
      where: { id: setup.installationId }
    })
    expect(row.apiKeyPrefix).toBe(body.apiKeyPrefix)
    expect(row.apiKeyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(body.apiKey)
    expect(JSON.stringify(row)).not.toContain(setup.apiKey)
  })

  it('audits who rotated which installation, without either key', async () => {
    const { id, setup } = await setUp()

    const body = (await rotate(setup.installationId).expect(OK)).body as RotationBody

    const entries = await waitForAuditEntries(owner, {
      action: AuditAction.PLUGIN_API_KEY_ROTATED,
      resourceId: setup.installationId
    })
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries)).toContain(id)
    expect(JSON.stringify(entries)).not.toContain(body.apiKey)
    expect(JSON.stringify(entries)).not.toContain(setup.apiKey)
    expect(JSON.stringify(entries)).not.toContain(
      body.apiKey.slice(PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH)
    )
  })

  it('rotates the key of a remote channel too, and leaves its command secret as it was', async () => {
    const { setup } = await setUp(PluginCatalogTypes.CHANNEL)
    const before = await owner.pluginInstallation.findUniqueOrThrow({
      where: { id: setup.installationId }
    })

    await rotate(setup.installationId).expect(OK)

    const after = await owner.pluginInstallation.findUniqueOrThrow({
      where: { id: setup.installationId }
    })
    expect(
      Buffer.from(after.commandSecret ?? []).equals(Buffer.from(before.commandSecret ?? []))
    ).toBe(true)
    expect(after.commandSecretRotatedAt).toBeNull()
    expect(after.status).toBe(PluginInstallationStatus.ACTIVE)
  })

  it('opens the door to the key of the last rotation only when several happen at once', async () => {
    const { setup } = await setUp()

    const answers = await Promise.all([
      rotate(setup.installationId),
      rotate(setup.installationId),
      rotate(setup.installationId)
    ])

    const keys = answers
      .filter(answer => answer.status === OK)
      .map(a => (a.body as RotationBody).apiKey)
    expect(keys.length).toBeGreaterThan(0)
    const row = await owner.pluginInstallation.findUniqueOrThrow({
      where: { id: setup.installationId }
    })
    const statuses = await Promise.all(keys.map(async key => (await withKey(key)).status))
    // Exactly one key of the ones handed out is the stored one
    expect(statuses.filter(status => status === OK)).toHaveLength(1)
    expect(row.apiKeyPrefix).toHaveLength(PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH)
    await withKey(setup.apiKey).expect(UNAUTHORIZED)
  })

  it('refuses an installation that is not set up yet, and one that was revoked', async () => {
    const pending = await install()
    const pendingRow = await owner.pluginInstallation.findFirstOrThrow({
      where: { pluginId: pending.id, storeId: ctx.storeA.id }
    })
    await rotate(pendingRow.id).expect(NOT_FOUND)
    // The key was not made by the rotation: the setup code still works and makes the first one
    await exchange(pending.code).expect(OK)

    const { setup } = await setUp()
    await asAdmin()
      .post(ApiRoutes.plugins.revoke(setup.installationId))
      .send({ confirmation: PLUGIN_REVOKE_CONFIRMATION })
      .expect(OK)
    await rotate(setup.installationId).expect(NOT_FOUND)
  })

  it('refuses the installation of a suspended plugin and keeps its key as it was', async () => {
    const { id, setup } = await setUp()
    await owner.plugin.update({ where: { id }, data: { status: PluginStatus.SUSPENDED } })

    await rotate(setup.installationId).expect(NOT_FOUND)

    const row = await owner.pluginInstallation.findUniqueOrThrow({
      where: { id: setup.installationId }
    })
    expect(row.apiKeyHash).toBe(hashToken(setup.apiKey))
  })

  it('needs the permission to manage plugins', async () => {
    const { setup } = await setUp()

    await rotate(setup.installationId, asAgent).expect(FORBIDDEN)

    await withKey(setup.apiKey).expect(OK)
  })

  it('is "not found" for another store of the same organization and for another organization, and changes nothing', async () => {
    const { setup } = await setUp()

    await rotate(setup.installationId, asAdminSibling).expect(NOT_FOUND)
    await rotate(setup.installationId, asAdminB).expect(NOT_FOUND)

    await withKey(setup.apiKey).expect(OK)
  })

  it('answers 401 with no sign-in and does not take a key as a credential', async () => {
    const { setup } = await setUp()
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]

    await supertest(server)
      .post(`${API_PREFIX}${ApiRoutes.plugins.apiKey(setup.installationId)}`)
      .expect(UNAUTHORIZED)
    await supertest(server)
      .post(`${API_PREFIX}${ApiRoutes.plugins.apiKey(setup.installationId)}`)
      .set('authorization', `Bearer ${setup.apiKey}`)
      .expect(UNAUTHORIZED)
    await withKey(setup.apiKey).expect(OK)
  })
})
