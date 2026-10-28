import type { INestApplication } from '@nestjs/common'

import { ChannelHealthService } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChannelConnectionStatus,
  ChannelIds,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ChannelConnectionResolver } from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import { PluginCatalogSync } from '../../apps/api/src/modules/plugins/plugin-catalog-sync.service'
import { buildChannelPlugin, createConversationOf, ensurePluginInstallation } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const SECRET = 'EAAB-secret-of-the-store'

interface ErrorBody {
  error: { code: string }
}
interface EntryBody {
  id: string
  isOfficial: boolean
  installed: boolean
  installationId: string | null
  activeConnections: number
}
interface ConnectionBody {
  id: string
  status: string
}

describe('The plugin catalog and the installations of a store', () => {
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
    // After the stores: an installation keeps its plugin row
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const catalogOf = async (agent = asAdmin) => {
    const response = await agent().get(ApiRoutes.plugins.available)
    expect(response.status).toBe(OK)
    return response.body as EntryBody[]
  }
  const entryOf = async (id: string, agent = asAdmin) => {
    const entry = (await catalogOf(agent)).find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`${id} is not in the catalog`)
    return entry
  }
  const install = (pluginId: string, agent = asAdmin) =>
    agent().post(ApiRoutes.plugins.install).send({ pluginId })
  const connect = (pluginId: string, agent = asAdmin) =>
    agent()
      .post(ApiRoutes.channels.connect(pluginId))
      .send({ credentials: { token: SECRET } })

  // The audit log is written after the response
  async function auditCount(action: string, resourceId: string): Promise<number> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = await owner.auditLog.count({ where: { action, resourceId } })
      if (count > 0) return count
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return 0
  }

  // A plugin the registry runs and the catalog lists, with a name of its own for each test
  async function publish(over: Partial<ChannelPlugin> = {}, storeIds?: string[]) {
    counter += 1
    const id = `${prefix}-p${counter}`
    registry.register(
      buildChannelPlugin({
        id,
        connect: input =>
          Promise.resolve({
            connectionId: `acct-${id}`,
            displayName: 'Acme account',
            credentials: input.credentials,
            metadata: {}
          }),
        disconnect: () => {
          disconnected.push(id)
          return Promise.resolve()
        },
        ...over
      }),
      storeIds === undefined ? {} : { storeIds }
    )
    await owner.plugin.create({
      data: {
        id,
        name: `Plugin ${id}`,
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.CHANNEL,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED
      }
    })
    return id
  }

  describe('the catalog', () => {
    it('writes the official plugins at boot, and writing them again changes nothing', async () => {
      const read = () =>
        owner.plugin.findUniqueOrThrow({
          where: { id: ChannelIds.WHATSAPP },
          omit: { updatedAt: true }
        })
      const first = await read()

      await app.get(PluginCatalogSync, { strict: false }).sync()

      expect(await read()).toEqual(first)
      expect(first).toMatchObject({
        isOfficial: true,
        type: PluginCatalogTypes.CHANNEL,
        status: PluginStatus.APPROVED,
        pricingModel: PluginPricingModels.FREE
      })
      expect(await owner.plugin.count({ where: { id: ChannelIds.WHATSAPP } })).toBe(1)
    })

    it('lists the official plugins that the boot wrote and a private one together', async () => {
      const privateId = await publish()

      const catalog = await catalogOf()

      const whatsapp = catalog.find(entry => entry.id === ChannelIds.WHATSAPP)
      expect(whatsapp).toMatchObject({ isOfficial: true })
      expect(catalog.find(entry => entry.id === privateId)).toMatchObject({
        isOfficial: false,
        installed: false,
        installationId: null,
        activeConnections: 0
      })
    })

    it('does not list a plugin that is not approved', async () => {
      const id = await publish()
      await owner.plugin.update({ where: { id }, data: { status: PluginStatus.SUBMITTED } })

      expect((await catalogOf()).some(entry => entry.id === id)).toBe(false)
    })

    it('is for those who can see the settings', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.plugins.available)

      expect(response.status).toBe(FORBIDDEN)
    })
  })

  describe('visibility and moderation', () => {
    it('keeps the private plugin of another store out of the catalog and out of reach', async () => {
      const id = await publish({}, [ctx.storeB.id])

      const mine = await catalogOf()
      const theirs = await catalogOf(asAdminB)
      const response = await install(id)

      expect(mine.some(entry => entry.id === id)).toBe(false)
      expect(theirs.some(entry => entry.id === id)).toBe(true)
      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })

    it('does not show a row that no code backs', async () => {
      const id = `${prefix}-orphan`
      await owner.plugin.create({
        data: {
          id,
          name: id,
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.CHANNEL,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED
        }
      })

      expect((await catalogOf()).some(entry => entry.id === id)).toBe(false)
    })

    it('refuses to connect a plugin that was suspended after the install', async () => {
      const id = await publish()
      await install(id)
      await owner.plugin.update({ where: { id }, data: { status: PluginStatus.SUSPENDED } })

      const response = await connect(id)

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
    })

    it('does not approve again at boot a plugin the owner suspended', async () => {
      const before = await owner.plugin.findUniqueOrThrow({
        where: { id: ChannelIds.WHATSAPP },
        select: { status: true }
      })
      await owner.plugin.update({
        where: { id: ChannelIds.WHATSAPP },
        data: { status: PluginStatus.SUSPENDED }
      })
      try {
        await app.get(PluginCatalogSync, { strict: false }).sync()

        const row = await owner.plugin.findUniqueOrThrow({ where: { id: ChannelIds.WHATSAPP } })
        expect(row.status).toBe(PluginStatus.SUSPENDED)
      } finally {
        await owner.plugin.update({
          where: { id: ChannelIds.WHATSAPP },
          data: { status: before.status }
        })
      }
    })
  })

  describe('installing', () => {
    it('installs the plugin in the store, audits it, and the other store does not see it', async () => {
      const id = await publish()

      const response = await install(id)

      expect(response.status).toBe(CREATED)
      const entry = response.body as EntryBody
      expect(entry).toMatchObject({ id, installed: true, activeConnections: 0 })
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: entry.installationId ?? '' }
      })
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        pluginId: id,
        status: PluginInstallationStatus.ACTIVE,
        apiKeyHash: null,
        installedBy: ctx.adminA.id
      })
      expect(await auditCount(AuditAction.PLUGIN_INSTALLED, row.id)).toBe(1)
      expect(await entryOf(id, asAdminB)).toMatchObject({ installed: false, installationId: null })
    })

    it('refuses to install it twice', async () => {
      const id = await publish()
      await install(id)

      const again = await install(id)

      expect(again.status).toBe(CONFLICT)
      expect(codeOf(again.body)).toBe(ErrorCodes.PLUGIN_ALREADY_INSTALLED)
    })

    it('is for those who manage plugins', async () => {
      const id = await publish()

      const response = await install(id, asAgent)

      expect(response.status).toBe(FORBIDDEN)
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })

    it('does not know a plugin that is not in the catalog, and cannot install one with no code', async () => {
      const missing = await install(`${prefix}-none`)
      const integration = await publish()
      await owner.plugin.update({
        where: { id: integration },
        data: { type: PluginCatalogTypes.INTEGRATION }
      })
      const response = await install(integration)

      expect(missing.status).toBe(NOT_FOUND)
      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_INSTALLATION_FAILED)
    })
  })

  describe('connecting', () => {
    it('needs the plugin installed, and the connection hangs from the installation', async () => {
      const id = await publish()

      const before = await connect(id)
      const writtenBefore = await owner.channelConnection.count({ where: { pluginId: id } })
      const installed = (await install(id)).body as EntryBody
      const after = await connect(id)

      expect(before.status).toBe(CONFLICT)
      expect(codeOf(before.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
      expect(writtenBefore).toBe(0)
      expect(after.status).toBe(CREATED)
      const row = await owner.channelConnection.findUniqueOrThrow({
        where: { id: (after.body as ConnectionBody).id }
      })
      expect(row.installationId).toBe(installed.installationId)
      expect(await entryOf(id)).toMatchObject({ activeConnections: 1 })
    })

    it('counts only the connections of the store in the catalog', async () => {
      const id = await publish()
      await install(id)
      await install(id, asAdminB)
      await connect(id)

      expect(await entryOf(id)).toMatchObject({ activeConnections: 1 })
      expect(await entryOf(id, asAdminB)).toMatchObject({ installed: true, activeConnections: 0 })
    })

    it('does not use the installation of another store', async () => {
      const id = await publish()
      await install(id, asAdminB)

      const response = await connect(id)

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
    })
  })

  describe('a connection that outlives its installation', () => {
    // As after an uninstall that failed half way: the installation is revoked, the connection is up
    async function strandedConnection() {
      const id = await publish()
      const entry = (await install(id)).body as EntryBody
      const connection = (await connect(id)).body as ConnectionBody
      await owner.pluginInstallation.update({
        where: { id: entry.installationId ?? '' },
        data: { status: PluginInstallationStatus.REVOKED, revokedAt: new Date() }
      })
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })
      return { id, row }
    }

    it('receives nothing: the webhook resolves it as inactive', async () => {
      const { id, row } = await strandedConnection()

      const resolved = await new ChannelConnectionResolver(
        app.get(PrismaService, { strict: false })
      ).resolve(id, row.connectionId)

      expect(resolved).toMatchObject({ id: row.id, active: false })
    })

    it('is not checked by the health round', async () => {
      const { id } = await strandedConnection()
      const healthCheck = jest.fn(() => Promise.resolve({ healthy: true, checkedAt: '' }))

      await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(pluginId =>
          pluginId === id ? buildChannelPlugin({ id, healthCheck }) : undefined
        )

      expect(healthCheck).not.toHaveBeenCalled()
    })
  })

  describe('connecting while the plugin is uninstalled', () => {
    // The provider answers connect() only when the test says so, and the plugin is uninstalled
    // meanwhile. `holder` is a store that already holds the same account.
    async function raceConnect(options: { disconnectFails?: boolean; holder?: boolean } = {}) {
      const id = `${prefix}-p-race${(counter += 1)}`
      const account = `acct-${id}`
      let reachProvider: () => void = () => undefined
      let answerProvider: () => void = () => undefined
      const atProvider = new Promise<void>(resolve => (reachProvider = resolve))
      const released: string[] = []
      registry.register(
        buildChannelPlugin({
          id,
          connect: input =>
            new Promise(resolve => {
              reachProvider()
              answerProvider = () =>
                resolve({
                  connectionId: account,
                  displayName: 'Acme account',
                  credentials: input.credentials,
                  metadata: {}
                })
            }),
          disconnect: ctx => {
            released.push(ctx.connectionId)
            return options.disconnectFails === true
              ? Promise.reject(new Error('provider down'))
              : Promise.resolve()
          }
        })
      )
      await owner.plugin.create({
        data: {
          id,
          name: id,
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.CHANNEL,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED
        }
      })
      const entry = (await install(id)).body as EntryBody
      if (options.holder === true) {
        const other = await ensurePluginInstallation(owner, {
          storeId: ctx.storeB.id,
          pluginId: id
        })
        await owner.channelConnection.create({
          data: {
            storeId: ctx.storeB.id,
            pluginId: id,
            installationId: other.id,
            connectionId: account,
            displayName: 'held by B',
            credentials: Buffer.from('not a secret')
          }
        })
      }

      // A supertest request starts when it is awaited: this one is started now
      const pending = Promise.resolve(connect(id))
      await atProvider
      await asAdmin().post(ApiRoutes.plugins.revoke(entry.installationId ?? ''))
      answerProvider()
      return { id, account, released, response: await pending }
    }

    it('lets the provider go of the account and keeps no connection', async () => {
      const { id, account, released, response } = await raceConnect()

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
      expect(released).toEqual([account])
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })

    it('still answers that the plugin is not installed when the provider does not let go', async () => {
      const { response, released } = await raceConnect({ disconnectFails: true })

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
      expect(released).toHaveLength(1)
    })

    it('does not let go of an account that a connection of another store holds', async () => {
      const { response, released } = await raceConnect({ holder: true })

      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
      expect(released).toEqual([])
    })
  })

  describe('installing again after an uninstall that failed half way', () => {
    it('disconnects what was left up before the installation is active again', async () => {
      const id = await publish()
      const entry = (await install(id)).body as EntryBody
      const connection = (await connect(id)).body as ConnectionBody
      await owner.pluginInstallation.update({
        where: { id: entry.installationId ?? '' },
        data: { status: PluginInstallationStatus.REVOKED, revokedAt: new Date() }
      })

      const response = await install(id)

      expect(response.status).toBe(CREATED)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
      expect(disconnected).toContain(id)
    })
  })

  describe('a suspended plugin', () => {
    it('leaves its connections inert and out of new conversations', async () => {
      const id = await publish()
      await install(id)
      const connection = (await connect(id)).body as ConnectionBody
      await owner.plugin.update({ where: { id }, data: { status: PluginStatus.SUSPENDED } })
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })

      const resolved = await new ChannelConnectionResolver(
        app.get(PrismaService, { strict: false })
      ).resolve(id, row.connectionId)
      const probe = await asAdmin().post(ApiRoutes.channels.test(connection.id))

      expect(resolved).toMatchObject({ active: false })
      expect(probe.status).toBe(CONFLICT)
    })
  })

  describe('uninstalling', () => {
    it('disconnects, deletes the credentials, keeps the conversations, and can be installed again', async () => {
      const id = await publish()
      const entry = (await install(id)).body as EntryBody
      const connection = (await connect(id)).body as ConnectionBody
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: id,
        channelConnectionId: connection.id
      })

      const response = await asAdmin().post(ApiRoutes.plugins.revoke(entry.installationId ?? ''))

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ id, installed: false, activeConnections: 0 })
      expect(disconnected).toContain(id)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
      expect(app.get(CredentialCipher, { strict: false }).open(row.credentials)).toEqual({})
      expect(await owner.conversation.count({ where: { id: conversation.id } })).toBe(1)
      expect(
        await owner.pluginInstallation.findUniqueOrThrow({
          where: { id: entry.installationId ?? '' }
        })
      ).toMatchObject({ status: PluginInstallationStatus.REVOKED })
      expect(await auditCount(AuditAction.PLUGIN_REVOKED, entry.installationId ?? '')).toBe(1)

      // Connecting again needs the plugin installed again, on the same row
      expect(codeOf((await connect(id)).body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
      const again = await install(id)
      expect(again.status).toBe(CREATED)
      expect((again.body as EntryBody).installationId).toBe(entry.installationId)
      expect((await connect(id)).status).toBe(CREATED)
    })

    it('finishes what an earlier run left when it is run again', async () => {
      const id = await publish()
      const entry = (await install(id)).body as EntryBody
      const connection = (await connect(id)).body as ConnectionBody
      // The installation was revoked and the connection stayed up, as after a failed run
      await owner.pluginInstallation.update({
        where: { id: entry.installationId ?? '' },
        data: { status: PluginInstallationStatus.REVOKED, revokedAt: new Date() }
      })

      const response = await asAdmin().post(ApiRoutes.plugins.revoke(entry.installationId ?? ''))

      expect(response.status).toBe(OK)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
    })

    it('is for those who manage plugins, and never reaches the installation of another store', async () => {
      const id = await publish()
      const entry = (await install(id)).body as EntryBody

      const agent = await asAgent().post(ApiRoutes.plugins.revoke(entry.installationId ?? ''))
      const stranger = await asAdminB().post(ApiRoutes.plugins.revoke(entry.installationId ?? ''))

      expect(agent.status).toBe(FORBIDDEN)
      expect(stranger.status).toBe(NOT_FOUND)
      expect(await entryOf(id)).toMatchObject({ installed: true })
    })
  })
})
