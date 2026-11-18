import { randomInt } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { RemoteChannelSync } from '@platform/channels/remote'
import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import { PluginCatalogTypes, PluginPricingModels, RemoteChannelLimits } from '@platform/core/domain'
import { PluginRegistry } from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface SetupBody {
  commandSecret?: string
  apiKey: string
  installationId: string
}
interface RotationBody {
  commandSecret: string
  rotatedAt: string
  previousValidUntil: string
}

// TDD_10 §6.7.3, Step 5.6 PR C2: a remote channel is installed like an integration plugin, gets the secret of its commands
// when it sets itself up, and the owner rotates it; the previous secret signs for ten minutes
describe('The command secret of a remote channel plugin', () => {
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
  const manifestOf = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    version: '1.0.0',
    name: `Channel ${id}`,
    description: 'A messaging channel that runs outside the platform',
    author: { name: 'Acme Inc', email: 'support@acme.com' },
    type: PluginCatalogTypes.CHANNEL,
    pricing: { model: PluginPricingModels.FREE },
    capabilities: ['text', 'typing_indicator'],
    channel: { label: 'Acme', commandsUrl: 'https://acme.com/platform/commands' },
    scopes: [PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS],
    ui: { settings: 'https://acme.com/plugin/settings' },
    ...over
  })
  const exchange = (code: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      .post(`${API_PREFIX}${PluginApiRoutes.setupExchange}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .send({ code })
  }
  const setUp = async (over: Record<string, unknown> = {}) => {
    counter += 1
    const id = `${prefix}-ch${counter}`
    await asAdmin().post(ApiRoutes.plugins.register).send(manifestOf(id, over)).expect(CREATED)
    const consent = (await asAdmin().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
      scopes: string[]
    }
    const installed = await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: consent.scopes })
      .expect(CREATED)
    const offer = (installed.body as { setup: { code: string } }).setup
    const setup = (await exchange(offer.code).expect(OK)).body as SetupBody
    return { id, setup }
  }
  const rotate = (installationId: string, agent = asAdmin) =>
    agent().post(ApiRoutes.plugins.commandSecret(installationId))

  it('gives the secret once, when the channel sets itself up, and keeps it sealed', async () => {
    const { id, setup } = await setUp()

    expect(setup.commandSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const row = await owner.pluginInstallation.findUniqueOrThrow({
      where: { id: setup.installationId }
    })
    expect(row.status).toBe('active')
    expect(row.commandSecret).not.toBeNull()
    // Sealed: the bytes are not the secret, in any encoding
    const stored = Buffer.from(row.commandSecret ?? []).toString('latin1')
    expect(stored).not.toContain(setup.commandSecret ?? 'x')
    // The process reads it back for the store of the installation, and for no other
    const sync = app.get(RemoteChannelSync)
    await expect(sync.secretsOf(ctx.storeA.id, id)).resolves.toMatchObject({
      current: setup.commandSecret,
      previous: null
    })
    await expect(sync.secretsOf(ctx.storeA2.id, id)).resolves.toBeNull()
  })

  it('does not give a command secret to an integration plugin', async () => {
    counter += 1
    const id = `${prefix}-int${counter}`
    await asAdmin()
      .post(ApiRoutes.plugins.register)
      .send({
        id,
        version: '1.0.0',
        name: 'Integration',
        description: 'An integration plugin',
        author: { name: 'Acme Inc', email: 'support@acme.com' },
        type: PluginCatalogTypes.INTEGRATION,
        pricing: { model: PluginPricingModels.FREE },
        scopes: [PluginScopes.ORDERS_READ]
      })
      .expect(CREATED)
    // No webhooks: nothing to challenge
    const installed = await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: [PluginScopes.ORDERS_READ] })
      .expect(CREATED)
    const code = (installed.body as { setup: { code: string } }).setup.code
    const setup = (await exchange(code).expect(OK)).body as SetupBody
    expect(setup.commandSecret).toBeUndefined()
    const row = await owner.pluginInstallation.findUniqueOrThrow({
      where: { id: setup.installationId }
    })
    expect(row.commandSecret).toBeNull()
  })

  it('makes the remote plugin of the registry private to the store that installed it', async () => {
    const { id } = await setUp()
    await app.get(RemoteChannelSync).refresh()
    const registry = app.get(PluginRegistry)

    expect(registry.isRemote(id)).toBe(true)
    expect(registry.isVisibleTo(id, ctx.storeA.id)).toBe(true)
    expect(registry.isVisibleTo(id, ctx.storeA2.id)).toBe(false)
    expect(registry.isVisibleTo(id, ctx.storeB.id)).toBe(false)
  })

  describe('rotating it', () => {
    it('makes a new one, keeps the old one as the previous for ten minutes and audits it without the secret', async () => {
      const { id, setup } = await setUp()

      const response = await rotate(setup.installationId).expect(OK)

      const body = response.body as RotationBody
      expect(body.commandSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(body.commandSecret).not.toBe(setup.commandSecret)
      expect(new Date(body.previousValidUntil).getTime() - new Date(body.rotatedAt).getTime()).toBe(
        RemoteChannelLimits.ROTATION_GRACE_SECONDS * 1000
      )
      expect(response.headers['cache-control']).toMatch(/no-store/)
      const sync = app.get(RemoteChannelSync)
      await sync.refresh()
      await expect(sync.secretsOf(ctx.storeA.id, id)).resolves.toMatchObject({
        current: body.commandSecret,
        previous: setup.commandSecret
      })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.PLUGIN_COMMAND_SECRET_ROTATED,
        resourceId: setup.installationId
      })
      expect(JSON.stringify(entries)).not.toContain(body.commandSecret)
      expect(JSON.stringify(entries)).not.toContain(setup.commandSecret ?? 'x')
    })

    it('lets one of two rotations at once through: the other finds the window open', async () => {
      const { setup } = await setUp()

      const answers = await Promise.all([
        rotate(setup.installationId),
        rotate(setup.installationId),
        rotate(setup.installationId)
      ])

      expect(answers.map(answer => answer.status).sort()).toEqual([OK, CONFLICT, CONFLICT].sort())
    })

    it('refuses a second rotation while the first one is open: the plugin has not replaced its secret yet', async () => {
      const { id, setup } = await setUp()
      const first = (await rotate(setup.installationId).expect(OK)).body as RotationBody

      await rotate(setup.installationId).expect(CONFLICT)

      // Nothing changed: the secret of the first rotation is the current one and the original is still the previous
      const sync = app.get(RemoteChannelSync)
      await sync.refresh()
      await expect(sync.secretsOf(ctx.storeA.id, id)).resolves.toMatchObject({
        current: first.commandSecret,
        previous: setup.commandSecret
      })
    })

    it('rotates again once the ten minutes have passed', async () => {
      const { setup } = await setUp()
      await rotate(setup.installationId).expect(OK)
      await owner.pluginInstallation.update({
        where: { id: setup.installationId },
        data: {
          commandSecretRotatedAt: new Date(
            Date.now() - (RemoteChannelLimits.ROTATION_GRACE_SECONDS + 5) * 1000
          )
        }
      })

      await rotate(setup.installationId).expect(OK)
    })

    it('needs the permission to manage plugins', async () => {
      const { setup } = await setUp()

      await rotate(setup.installationId, asAgent).expect(FORBIDDEN)
    })

    it('is "not found" for another store of the same organization and for another organization', async () => {
      const { setup } = await setUp()

      await rotate(setup.installationId, asAdminSibling).expect(NOT_FOUND)
      await rotate(setup.installationId, asAdminB).expect(NOT_FOUND)
      await rotate(`${prefix}-nothing`).expect(400)
    })

    it('is not for an installation that was revoked', async () => {
      const { setup } = await setUp()
      await asAdmin().post(ApiRoutes.plugins.revoke(setup.installationId)).expect(OK)

      await rotate(setup.installationId).expect(NOT_FOUND)
    })
  })

  it('answers 409 with the settings page of the plugin when someone tries to connect it from the platform', async () => {
    const { id } = await setUp()
    await app.get(RemoteChannelSync).refresh()

    const response = await asAdmin().post(ApiRoutes.channels.connect(id)).send({ credentials: {} })

    expect(response.status).toBe(CONFLICT)
    expect(response.body).toMatchObject({
      error: {
        code: 'RESOURCE_CONFLICT',
        metadata: { settingsUrl: 'https://acme.com/plugin/settings' }
      }
    })
  })

  it('lets a second store of the organization install a channel the first one already runs', async () => {
    const { id } = await setUp()
    await app.get(RemoteChannelSync).refresh()

    const consent = (await asAdminSibling().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
      scopes: string[]
    }
    await asAdminSibling()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: consent.scopes })
      .expect(CREATED)
  })

  it('stops giving the secret of an installation that was revoked', async () => {
    const { id, setup } = await setUp()
    await asAdmin().post(ApiRoutes.plugins.revoke(setup.installationId)).expect(OK)
    const sync = app.get(RemoteChannelSync)
    await sync.refresh()

    await expect(sync.secretsOf(ctx.storeA.id, id)).resolves.toBeNull()
    expect(app.get(PluginRegistry).isRemote(id)).toBe(false)
  })
})
