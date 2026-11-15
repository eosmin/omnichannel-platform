import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import {
  ChannelIds,
  CarrierId,
  CodePluginAuthor,
  OfficialPluginAuthor,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginPricingModels,
  PluginRegistrationLimits,
  PluginStatus,
  ShippingPlugin
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginRegistry } from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginCatalogSync } from '../../apps/api/src/modules/plugins/plugin-catalog-sync.service'
import { buildChannelPlugin } from '../builders'
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

interface ErrorBody {
  error: { code: string }
}
interface EntryBody {
  id: string
}

describe('Private registration of an integration plugin (D10)', () => {
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
    // The plugins of a deleted organization go with it; the ones with no organization are removed by name
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asSibling = () => api(app, ctx.adminA2, ctx.storeA2)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const newId = () => {
    counter += 1
    return `${prefix}-r${counter}`
  }

  // A manifest that is valid; each case changes one thing
  const manifestOf = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    version: '1.0.0',
    name: `Plugin ${id}`,
    description: 'Sends the orders of the store to the point of sale',
    author: { name: 'Acme Inc', email: 'support@acme.com' },
    type: PluginCatalogTypes.INTEGRATION,
    pricing: { model: PluginPricingModels.FREE },
    scopes: [PluginScopes.ORDERS_READ],
    ...over
  })
  const register = (manifest: unknown, agent = asAdmin) =>
    agent()
      .post(ApiRoutes.plugins.register)
      .send(manifest as object)
  const catalogIds = async (agent = asAdmin): Promise<string[]> => {
    const response = await agent().get(ApiRoutes.plugins.available)
    expect(response.status).toBe(OK)
    return (response.body as EntryBody[]).map(entry => entry.id)
  }

  // The audit log is written after the response
  async function auditCount(action: string, resourceId: string): Promise<number> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = await owner.auditLog.count({ where: { action, resourceId } })
      if (count > 0) return count
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return 0
  }

  describe('registering', () => {
    it('stores the manifest as an approved, free plugin that is not official, of the organization', async () => {
      const id = newId()
      const manifest = manifestOf(id, { names: { es: 'Mi POS', en: 'My POS' } })

      const response = await register(manifest)

      expect(response.status).toBe(CREATED)
      expect(response.body).toEqual({
        id,
        name: manifest.name,
        version: '1.0.0',
        status: PluginStatus.APPROVED,
        outcome: 'created'
      })
      const row = await owner.plugin.findUniqueOrThrow({ where: { id } })
      expect(row).toMatchObject({
        type: PluginCatalogTypes.INTEGRATION,
        isOfficial: false,
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED,
        authorName: 'Acme Inc',
        authorEmail: 'support@acme.com',
        organizationId: ctx.orgA.id
      })
      expect(row.manifest).toEqual(manifest)
      expect(await auditCount(AuditAction.PLUGIN_REGISTERED, id)).toBe(1)
    })

    it('needs the permission to manage plugins', async () => {
      const id = newId()

      const response = await register(manifestOf(id), asAgent)

      expect(response.status).toBe(FORBIDDEN)
      expect(await owner.plugin.count({ where: { id } })).toBe(0)
    })

    it('stores the copy it validated, never what else the request carried', async () => {
      const id = newId()

      const response = await register({ ...manifestOf(id), organizationId: ctx.orgB.id })

      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.plugin.count({ where: { id } })).toBe(0)
    })

    it.each([
      ['a channel plugin', { type: 'channel' }],
      ['a paid plugin', { pricing: { model: 'paid' } }],
      ['a plan-gated plugin', { pricing: { model: 'plan_gated' } }],
      ['a scope that does not exist', { scopes: ['orders:delete'] }],
      ['a scope of a channel plugin', { scopes: ['channel:events'] }],
      ['a repeated scope', { scopes: [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_READ] }],
      [
        'a webhook that is not https',
        {
          webhooks: {
            endpoint: 'http://acme.com/hook',
            events: ['order.created'],
            signatureHeader: 'X-Sig'
          }
        }
      ],
      [
        'a webhook on the private network',
        {
          webhooks: {
            endpoint: 'https://169.254.169.254/hook',
            events: ['order.created'],
            signatureHeader: 'X-Sig'
          }
        }
      ],
      ['markup in the name', { name: '<img src=x onerror=alert(1)>' }],
      ['a name in one language only', { names: { es: 'Solo' } }],
      ['a version that is not a version', { version: 'latest' }],
      ['an id that is not an id', { id: 'Not An Id' }],
      [
        'the address of the platform as the author',
        { author: { name: 'x', email: OfficialPluginAuthor.EMAIL } }
      ],
      [
        'the address of the code as the author',
        { author: { name: 'x', email: CodePluginAuthor.EMAIL.toUpperCase() } }
      ]
    ])('refuses %s with VALIDATION_FAILED and stores nothing', async (_name, over) => {
      const given = (over as { id?: string }).id
      const id = given ?? newId()

      const response = await register(manifestOf(id, over))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await owner.plugin.count({ where: { id } })).toBe(0)
    })

    it('refuses an empty body and a body that is not an object', async () => {
      expect((await register({})).status).toBe(BAD_REQUEST)
      expect((await register([manifestOf(newId())])).status).toBe(BAD_REQUEST)
    })
  })

  describe('the id', () => {
    it.each([
      ['an official channel', ChannelIds.WHATSAPP],
      ['the shipping plugin', ShippingPlugin.ID],
      ['an id the platform defines for a carrier', Object.values(CarrierId)[0] ?? 'missing']
    ])('is never one of %s', async (_name, id) => {
      const before = await owner.plugin.findUnique({ where: { id } })

      const response = await register(manifestOf(id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
      expect(await owner.plugin.findUnique({ where: { id } })).toEqual(before)
    })

    it('is never one the registry runs', async () => {
      const id = newId()
      app.get(PluginRegistry, { strict: false }).register(buildChannelPlugin({ id }), {})

      const response = await register(manifestOf(id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
      expect(await owner.plugin.count({ where: { id } })).toBe(0)
    })

    it('is never one that another organization registered, and its row does not change', async () => {
      const id = newId()
      expect((await register(manifestOf(id))).status).toBe(CREATED)
      const before = await owner.plugin.findUniqueOrThrow({ where: { id } })

      const response = await register(
        manifestOf(id, { version: '9.0.0', scopes: [PluginScopes.CUSTOMERS_READ] }),
        asAdminB
      )

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
      expect(await owner.plugin.findUniqueOrThrow({ where: { id } })).toEqual(before)
    })

    it('takes only one of two registrations of the same id made at once', async () => {
      const id = newId()

      const [first, second] = await Promise.all([
        register(manifestOf(id)),
        register(manifestOf(id, { name: 'The other one' }), asSibling)
      ])

      expect([first.status, second.status].sort()).toEqual([CREATED, CONFLICT])
      expect(await owner.plugin.count({ where: { id } })).toBe(1)
    })
  })

  describe('registering a newer version of its own plugin', () => {
    it('replaces the manifest, keeps the installations and what they were granted, and audits it', async () => {
      const id = newId()
      await register(manifestOf(id))
      const installation = await owner.pluginInstallation.create({
        data: {
          storeId: ctx.storeA.id,
          pluginId: id,
          scopes: [PluginScopes.ORDERS_READ],
          status: PluginInstallationStatus.ACTIVE,
          installedBy: ctx.adminA.id
        }
      })
      const next = manifestOf(id, {
        version: '1.1.0',
        name: 'A new name',
        scopes: [PluginScopes.ORDERS_READ, PluginScopes.CUSTOMERS_READ, PluginScopes.ORDERS_WRITE]
      })

      const response = await register(next)

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ id, version: '1.1.0', outcome: 'updated' })
      const row = await owner.plugin.findUniqueOrThrow({ where: { id } })
      expect(row.manifest).toEqual(next)
      expect(row.name).toBe('A new name')
      expect(row.status).toBe(PluginStatus.APPROVED)
      expect(row.organizationId).toBe(ctx.orgA.id)
      // What the installation was granted does not grow with the manifest: it waits for the consent of the install flow
      const kept = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: installation.id }
      })
      expect(kept.scopes).toEqual([PluginScopes.ORDERS_READ])
      expect(kept.status).toBe(PluginInstallationStatus.ACTIVE)
      expect(await auditCount(AuditAction.PLUGIN_MANIFEST_UPDATED, id)).toBe(1)
    })

    it('can be done from a sibling store of the same organization', async () => {
      const id = newId()
      await register(manifestOf(id))

      const response = await register(manifestOf(id, { version: '2.0.0' }), asSibling)

      expect(response.status).toBe(OK)
    })

    it.each([
      ['the same version', '1.0.0'],
      ['an older version', '0.9.0']
    ])('refuses %s and leaves the row as it was', async (_name, version) => {
      const id = newId()
      await register(manifestOf(id, { version: '1.0.0' }))
      const before = await owner.plugin.findUniqueOrThrow({ where: { id } })

      const response = await register(manifestOf(id, { version, name: 'Changed' }))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
      expect(await owner.plugin.findUniqueOrThrow({ where: { id } })).toEqual(before)
    })
  })

  describe('sending a manifest again', () => {
    it('answers the same for the very manifest that is stored, and writes and audits nothing', async () => {
      const id = newId()
      const manifest = manifestOf(id)
      expect((await register(manifest)).status).toBe(CREATED)
      const before = await owner.plugin.findUniqueOrThrow({ where: { id } })

      const again = await register(manifest)

      expect(again.status).toBe(OK)
      expect(again.body).toMatchObject({ id, outcome: 'unchanged' })
      expect(await owner.plugin.findUniqueOrThrow({ where: { id } })).toEqual(before)
      expect(await auditCount(AuditAction.PLUGIN_REGISTERED, id)).toBe(1)
      expect(await owner.auditLog.count({ where: { resourceId: id } })).toBe(1)
    })

    it('does not touch a plugin that was suspended, even with a higher version', async () => {
      const id = newId()
      await register(manifestOf(id))
      await owner.plugin.update({ where: { id }, data: { status: PluginStatus.SUSPENDED } })
      const before = await owner.plugin.findUniqueOrThrow({ where: { id } })

      const response = await register(manifestOf(id, { version: '2.0.0', name: 'Changed' }))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_ALREADY_REGISTERED)
      expect(await owner.plugin.findUniqueOrThrow({ where: { id } })).toEqual(before)
    })

    it('does not replace a row whose manifest has no version', async () => {
      const id = newId()
      await register(manifestOf(id))
      await owner.plugin.update({ where: { id }, data: { manifest: {} } })

      const response = await register(manifestOf(id, { version: '9.0.0' }))

      expect(response.status).toBe(CONFLICT)
      expect((await owner.plugin.findUniqueOrThrow({ where: { id } })).manifest).toEqual({})
    })
  })

  describe('an organization that is deleted', () => {
    it('takes its private plugins and their installations with it', async () => {
      const slug = `${prefix}-gone`
      const organization = await owner.organization.create({ data: { name: slug, slug } })
      const store = await ensureStore(owner, organization.id, `${slug}-store`)
      const id = newId()
      await owner.plugin.create({
        data: {
          id,
          name: id,
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          manifest: manifestOf(id),
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED,
          organizationId: organization.id
        }
      })
      await owner.pluginInstallation.create({
        data: {
          storeId: store.id,
          pluginId: id,
          scopes: [],
          status: PluginInstallationStatus.ACTIVE,
          installedBy: ctx.adminA.id
        }
      })

      await owner.organization.delete({ where: { id: organization.id } })

      expect(await owner.plugin.count({ where: { id } })).toBe(0)
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })
  })

  describe('the limit of an organization', () => {
    it('stops a new id at the limit and still lets its own plugins be updated', async () => {
      // Organization B has no other plugin in this suite: fill it up to the limit with rows made directly
      const own = await owner.plugin.count({ where: { organizationId: ctx.orgB.id } })
      const ids = Array.from(
        { length: PluginRegistrationLimits.MAX_PER_ORGANIZATION - own },
        (_, index) => `${prefix}-f${String(index).padStart(2, '0')}`
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
          organizationId: ctx.orgB.id
        }))
      })
      const extra = newId()

      const refused = await register(manifestOf(extra), asAdminB)
      const updated = await register(manifestOf(ids[0] ?? '', { version: '1.0.1' }), asAdminB)

      expect(refused.status).toBe(CONFLICT)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PLUGIN_LIMIT_REACHED)
      expect(await owner.plugin.count({ where: { id: extra } })).toBe(0)
      expect(updated.status).toBe(OK)
      // The other organization is not counted against it
      expect((await register(manifestOf(newId()))).status).toBe(CREATED)
    })
  })

  describe('who sees it', () => {
    it('shows it to the stores of the organization and to no other, and only they may install it', async () => {
      const id = newId()
      await register(manifestOf(id))

      expect(await catalogIds(asAdmin)).toContain(id)
      expect(await catalogIds(asSibling)).toContain(id)
      expect(await catalogIds(asAdminB)).not.toContain(id)
      const install = await asAdminB().post(ApiRoutes.plugins.install).send({ pluginId: id })
      expect(install.status).toBe(NOT_FOUND)
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })

    it('keeps the plugins of the platform visible to every store', async () => {
      expect(await catalogIds(asAdmin)).toContain(ChannelIds.WHATSAPP)
      expect(await catalogIds(asAdminB)).toContain(ChannelIds.WHATSAPP)
    })
  })

  describe('the database', () => {
    it('refuses an official plugin that belongs to an organization', async () => {
      const id = newId()

      await expect(
        owner.plugin.create({
          data: {
            id,
            name: id,
            authorName: 'suite',
            authorEmail: 'suite@example.invalid',
            type: PluginCatalogTypes.INTEGRATION,
            isOfficial: true,
            manifest: {},
            pricingModel: PluginPricingModels.FREE,
            status: PluginStatus.APPROVED,
            organizationId: ctx.orgA.id
          }
        })
      ).rejects.toThrow()
    })
  })

  describe('the database, again', () => {
    it('refuses an integration plugin that belongs to no organization', async () => {
      const id = newId()

      await expect(
        owner.plugin.create({
          data: {
            id,
            name: id,
            authorName: 'suite',
            authorEmail: 'suite@example.invalid',
            type: PluginCatalogTypes.INTEGRATION,
            manifest: {},
            pricingModel: PluginPricingModels.FREE,
            status: PluginStatus.APPROVED
          }
        })
      ).rejects.toThrow()
    })
  })

  describe('the boot sync of the platform plugins', () => {
    it('does not turn the row of an organization into an official plugin', async () => {
      const id = ChannelIds.WHATSAPP
      const official = await owner.plugin.findUniqueOrThrow({ where: { id } })
      // An organization registered that id before the platform shipped it: its installations and keys hang from the row
      await owner.plugin.update({
        where: { id },
        data: { isOfficial: false, organizationId: ctx.orgA.id, name: 'Not the platform' }
      })
      try {
        await app.get(PluginCatalogSync, { strict: false }).sync()

        const row = await owner.plugin.findUniqueOrThrow({ where: { id } })
        expect(row).toMatchObject({
          isOfficial: false,
          organizationId: ctx.orgA.id,
          name: 'Not the platform'
        })
      } finally {
        await owner.plugin.update({
          where: { id },
          data: {
            isOfficial: official.isOfficial,
            organizationId: null,
            name: official.name,
            manifest: official.manifest ?? {}
          }
        })
        await app.get(PluginCatalogSync, { strict: false }).sync()
      }
      expect(await owner.plugin.findUniqueOrThrow({ where: { id } })).toMatchObject({
        isOfficial: true,
        organizationId: null
      })
    })
  })
})
