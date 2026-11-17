import { randomInt } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  PLUGIN_REVOKE_CONFIRMATION,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginRegistrationLimits,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginChallengeService } from '../../apps/api/src/modules/plugins/plugin-challenge.service'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ErrorBody {
  error: { code: string }
}
interface InstallBody {
  setup: { code: string } | null
}

// Step 5.6 PR W1-2: `DELETE /plugins/:id`, the removal of a plugin the organization registered
describe('Deleting a plugin of the organization', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0
  // What runs while the install asks the address of the plugin: the moment between its checks and its write
  let duringChallenge: (() => Promise<void>) | null = null

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(PluginChallengeService).useValue({
        run: () => (duringChallenge === null ? Promise.resolve() : duringChallenge())
      })
    )
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
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const nameOf = (id: string) => `Plugin ${id}`
  const manifestOf = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    version: '1.0.0',
    name: nameOf(id),
    description: 'Sends the orders of the store to the point of sale',
    author: { name: 'Acme Inc', email: 'support@acme.com' },
    type: PluginCatalogTypes.INTEGRATION,
    pricing: { model: PluginPricingModels.FREE },
    scopes: [PluginScopes.ORDERS_READ],
    webhooks: {
      endpoint: 'https://hooks.acme.com/platform',
      events: ['message.received'],
      signatureHeader: 'X-Platform-Signature'
    },
    ...over
  })
  const register = async () => {
    counter += 1
    const id = `${prefix}-d${counter}`
    await asAdmin().post(ApiRoutes.plugins.register).send(manifestOf(id)).expect(CREATED)
    return id
  }
  // `null` sends no name at all
  const remove = (id: string, confirmation: string | null = nameOf(id), agent = asAdmin) =>
    agent()
      .delete(ApiRoutes.plugins.byId(id))
      .send(confirmation === null ? {} : { confirmation })
  const exists = async (id: string) => (await owner.plugin.count({ where: { id } })) === 1
  // Installed in a store, with the key made (the plugin set itself up)
  const setUp = async (id: string, agent = asAdmin): Promise<string> => {
    const installed = await agent()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: [PluginScopes.ORDERS_READ] })
      .expect(CREATED)
    const code = ((installed.body as InstallBody).setup as { code: string }).code
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    await supertest(server)
      .post(`${API_PREFIX}${PluginApiRoutes.setupExchange}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .send({ code })
      .expect(OK)
    return (
      await owner.pluginInstallation.findFirstOrThrow({
        where: { pluginId: id, storeId: agent === asAdmin ? ctx.storeA.id : ctx.storeA2.id }
      })
    ).id
  }
  const revoke = (installationId: string, agent = asAdmin) =>
    agent()
      .post(ApiRoutes.plugins.revoke(installationId))
      .send({ confirmation: PLUGIN_REVOKE_CONFIRMATION })
      .expect(OK)

  it('removes a plugin that was never installed, audits it and frees the id', async () => {
    const id = await register()

    await remove(id).expect(NO_CONTENT)

    expect(await exists(id)).toBe(false)
    const catalog = (await asAdmin().get(ApiRoutes.plugins.available).expect(OK)).body as {
      id: string
    }[]
    expect(catalog.map(entry => entry.id)).not.toContain(id)
    const [entry] = await waitForAuditEntries(owner, {
      action: AuditAction.PLUGIN_DELETED,
      resourceId: id
    })
    expect(entry?.metadata).toMatchObject({ pluginId: id, removedInstallations: 0 })
    // The same organization may register it again
    await asAdmin().post(ApiRoutes.plugins.register).send(manifestOf(id)).expect(CREATED)
    await remove(id).expect(NO_CONTENT)
  })

  it('needs the permission to manage plugins', async () => {
    const id = await register()

    await remove(id, null, asAgent).expect(FORBIDDEN)
    await remove(id, nameOf(id), asAgent).expect(FORBIDDEN)

    expect(await exists(id)).toBe(true)
  })

  it('takes the name as it was typed, and nothing else', async () => {
    const id = await register()

    expect(codeOf((await remove(id, null).expect(BAD_REQUEST)).body)).toBe(
      ErrorCodes.PLUGIN_DELETE_NOT_CONFIRMED
    )
    for (const typed of [nameOf(id).toLowerCase(), `${nameOf(id)}x`, PLUGIN_REVOKE_CONFIRMATION]) {
      const refused = await remove(id, typed).expect(BAD_REQUEST)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PLUGIN_DELETE_NOT_CONFIRMED)
    }
    await asAdmin()
      .delete(ApiRoutes.plugins.byId(id))
      .send({ confirmation: nameOf(id), extra: true })
      .expect(BAD_REQUEST)

    expect(await exists(id)).toBe(true)
    // Space around the name is not an error
    await remove(id, `  ${nameOf(id)} `).expect(NO_CONTENT)
    expect(await exists(id)).toBe(false)
  })

  it('does not exist for another organization, for an official plugin or for an id that is nothing', async () => {
    const id = await register()
    const official = await owner.plugin.findFirstOrThrow({ where: { isOfficial: true } })

    expect((await remove(id, nameOf(id), asAdminB)).status).toBe(NOT_FOUND)
    expect((await remove(official.id, official.name)).status).toBe(NOT_FOUND)
    // With no name at all the answer is the same: the name is no oracle for what exists
    expect((await remove(id, null, asAdminB)).status).toBe(NOT_FOUND)
    expect((await remove(`${prefix}-nothing`, null)).status).toBe(NOT_FOUND)
    expect((await remove(`${prefix}-nothing`, 'x')).status).toBe(NOT_FOUND)
    expect((await remove('00000000-0000-4000-8000-000000000000', 'x')).status).toBe(NOT_FOUND)

    expect(await exists(id)).toBe(true)
    expect(await exists(official.id)).toBe(true)
  })

  it('refuses a plugin that is still installed, in any store of the organization, until the last one is revoked and has heard it', async () => {
    const id = await register()
    const installationA = await setUp(id)
    const installationSibling = await setUp(id, asAdminSibling)

    // Active in both stores
    expect(codeOf((await remove(id).expect(CONFLICT)).body)).toBe(ErrorCodes.PLUGIN_IN_USE)

    // Revoked in one: the other still holds it
    await revoke(installationA)
    expect(codeOf((await remove(id).expect(CONFLICT)).body)).toBe(ErrorCodes.PLUGIN_IN_USE)

    // Revoked in both, but the last delivery of the revocation has not left (the row still holds the endpoint and the secret)
    await revoke(installationSibling, asAdminSibling)
    expect(codeOf((await remove(id).expect(CONFLICT)).body)).toBe(ErrorCodes.PLUGIN_IN_USE)
    expect(await exists(id)).toBe(true)

    // The worker sent it and closed the subscription
    await owner.pluginInstallation.updateMany({
      where: { pluginId: id },
      data: { webhookEndpoint: null, webhookSecret: null }
    })
    await remove(id).expect(NO_CONTENT)

    expect(await exists(id)).toBe(false)
    expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    const [entry] = await waitForAuditEntries(owner, {
      action: AuditAction.PLUGIN_DELETED,
      resourceId: id
    })
    expect(entry?.metadata).toMatchObject({ removedInstallations: 2 })
    // No key, hash or secret anywhere in what was recorded
    expect(
      Object.keys(entry?.metadata as object).filter(name => /key|hash|secret/i.test(name))
    ).toEqual([])
  })

  it('deletes a plugin revoked before its setup, whose webhook endpoint has no secret and no last delivery to sign', async () => {
    const id = await register()
    await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: [PluginScopes.ORDERS_READ] })
      .expect(CREATED)
    const installation = await owner.pluginInstallation.findFirstOrThrow({
      where: { pluginId: id, storeId: ctx.storeA.id }
    })
    expect(installation.webhookEndpoint).not.toBeNull()
    expect(installation.webhookSecret).toBeNull()
    await revoke(installation.id)

    await remove(id).expect(NO_CONTENT)

    expect(await exists(id)).toBe(false)
  })

  it('refuses a plugin that is waiting for its setup', async () => {
    const id = await register()
    await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: [PluginScopes.ORDERS_READ] })
      .expect(CREATED)

    expect(codeOf((await remove(id).expect(CONFLICT)).body)).toBe(ErrorCodes.PLUGIN_IN_USE)
    expect(await exists(id)).toBe(true)
  })

  // Fills `organizationId` with plugins made directly, up to the limit minus `room`
  const fill = async (room: number): Promise<string[]> => {
    const own = await owner.plugin.count({
      where: { organizationId: ctx.orgA.id, status: { not: PluginStatus.ARCHIVED } }
    })
    const ids = Array.from(
      { length: PluginRegistrationLimits.MAX_PER_ORGANIZATION - room - own },
      (_, index) => `${prefix}-fill${String(index).padStart(2, '0')}`
    )
    await owner.plugin.createMany({
      data: ids.map(id => ({
        id,
        name: id,
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.INTEGRATION,
        manifest: manifestOf(id),
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED,
        organizationId: ctx.orgA.id
      }))
    })
    return ids
  }
  const holdAConnection = async (id: string): Promise<string> => {
    const installationId = await setUp(id)
    await revoke(installationId)
    await owner.pluginInstallation.update({
      where: { id: installationId },
      data: { webhookEndpoint: null, webhookSecret: null }
    })
    await owner.channelConnection.create({
      data: {
        storeId: ctx.storeA.id,
        pluginId: id,
        connectionId: `${prefix}-connection-${id}`,
        displayName: 'Past connection',
        status: 'disconnected',
        credentials: Buffer.alloc(0),
        installationId
      }
    })
    return installationId
  }

  it('archives a revoked plugin whose installation holds a connection, the history of a channel, and keeps every row it is named by (N-A7-08)', async () => {
    const id = await register()
    const installationId = await holdAConnection(id)
    try {
      await remove(id).expect(NO_CONTENT)

      // Kept, not deleted: the connection (and through it the conversations) still point at it
      const row = await owner.plugin.findUniqueOrThrow({ where: { id } })
      expect(row.status).toBe(PluginStatus.ARCHIVED)
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(1)
      expect(await owner.channelConnection.count({ where: { installationId } })).toBe(1)
      // Gone for the organization: out of the catalog, not removable again, not installable
      const catalog = (await asAdmin().get(ApiRoutes.plugins.available).expect(OK)).body as {
        id: string
      }[]
      expect(catalog.map(entry => entry.id)).not.toContain(id)
      await remove(id).expect(NOT_FOUND)
      await asAdmin()
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: id, scopes: [PluginScopes.ORDERS_READ] })
        .expect(NOT_FOUND)
      // The id stays reserved, with the manifest it had and with a newer one
      for (const manifest of [manifestOf(id), manifestOf(id, { version: '1.0.1' })]) {
        const again = await asAdmin().post(ApiRoutes.plugins.register).send(manifest)
        expect(again.status).toBe(CONFLICT)
        expect(codeOf(again.body)).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
      }
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.PLUGIN_ARCHIVED,
        resourceId: id
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.metadata).toMatchObject({ removedInstallations: 0 })
    } finally {
      await owner.channelConnection.deleteMany({ where: { installationId } })
    }
  })

  it('archives once when two deletes of the same plugin arrive together', async () => {
    const id = await register()
    const installationId = await holdAConnection(id)
    try {
      const answers = await Promise.all([remove(id), remove(id)])

      expect(answers.map(answer => answer.status).sort()).toEqual([NO_CONTENT, NOT_FOUND])
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.PLUGIN_ARCHIVED,
        resourceId: id
      })
      expect(entries).toHaveLength(1)
    } finally {
      await owner.channelConnection.deleteMany({ where: { installationId } })
    }
  })

  it('refuses, and does not archive, a plugin with a connection while its last webhook is still to be sent or an installation is live', async () => {
    const id = await register()
    const installationId = await setUp(id)
    await owner.channelConnection.create({
      data: {
        storeId: ctx.storeA.id,
        pluginId: id,
        connectionId: `${prefix}-connection-live-${id}`,
        displayName: 'Live connection',
        status: 'connected',
        credentials: Buffer.alloc(0),
        installationId
      }
    })
    try {
      // Live installation
      expect(codeOf((await remove(id).expect(CONFLICT)).body)).toBe(ErrorCodes.PLUGIN_IN_USE)
      // Revoked, but the endpoint and the secret are still there: the revocation has not been delivered
      await revoke(installationId)
      expect(codeOf((await remove(id).expect(CONFLICT)).body)).toBe(ErrorCodes.PLUGIN_IN_USE)
      expect((await owner.plugin.findUniqueOrThrow({ where: { id } })).status).not.toBe(
        PluginStatus.ARCHIVED
      )
    } finally {
      await owner.channelConnection.deleteMany({ where: { installationId } })
    }
  })

  it('frees the place of an archived plugin in the limit of the organization (N-A7-08)', async () => {
    const fillers = await fill(1)
    const id = await register()
    let installationId: string | null = null
    try {
      const refused = await asAdmin()
        .post(ApiRoutes.plugins.register)
        .send(manifestOf(`${prefix}-over`))
      expect(refused.status).toBe(CONFLICT)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PLUGIN_LIMIT_REACHED)

      installationId = await holdAConnection(id)
      await remove(id).expect(NO_CONTENT)

      await asAdmin()
        .post(ApiRoutes.plugins.register)
        .send(manifestOf(`${prefix}-over`))
        .expect(CREATED)
    } finally {
      if (installationId !== null) {
        await owner.channelConnection.deleteMany({ where: { installationId } })
      }
      await owner.plugin.deleteMany({ where: { id: { in: [...fillers, `${prefix}-over`] } } })
    }
  })

  it('answers 404 and not 500 to an install of a plugin that is deleted while the install asks its address (OPS-PLG-308)', async () => {
    const id = await register()
    // The plugin has no installation, so its deletion goes through between the checks of the install and its write
    let asked = false
    duringChallenge = async () => {
      // One shot: the hook disarms itself, so no other install meets it
      duringChallenge = null
      asked = true
      await remove(id).expect(NO_CONTENT)
    }
    try {
      const installed = await asAdmin()
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: id, scopes: [PluginScopes.ORDERS_READ] })

      expect(asked).toBe(true)
      expect(installed.status).toBe(NOT_FOUND)
      expect(codeOf(installed.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
    } finally {
      duringChallenge = null
    }
    expect(await exists(id)).toBe(false)
    expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
  })
})
