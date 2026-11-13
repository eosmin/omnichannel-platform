import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  CarrierStatusLimits,
  CarrierStatusMappingSource,
  ShipmentStatus,
  ShippingPlugin
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { buildFakeCarrier, FAKE_CARRIER_API_KEY, fakeCarrierStatuses } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
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
interface MappingBody {
  providerCode: string
  label: string | null
  status: string | null
  source: string
  updatedAt: string
}
interface Page<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}
interface UnmappedBody {
  providerCode: string
  sampleRawStatus: string
  occurrences: number
}

// What a carrier's codes mean for a connection (TDD_17 §4.17, Step 4.8 PR C2a): the rows seeded from the catalog of the
// plugin, what the owner may change, the codes that arrived with no meaning, and the secret of the webhook that is made
// anew. Every route is for the store of the request: another store's connection is a 404, with no word of what it holds.
describe('Settings → Carriers → Status mapping', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    // The registry of the api holds the real `local` courier only: the fake stands for Forza here
    app
      .get(CarrierRegistry, { strict: false })
      .register(buildFakeCarrier({ id: CarrierId.FORZA, webhook: true, fetchStatus: true }).plugin)
    const installed = await asAdmin().post(ApiRoutes.plugins.install).send({
      pluginId: ShippingPlugin.ID
    })
    expect(installed.status).toBe(CREATED)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const forza = async (): Promise<string> => {
    const response = await asAdmin()
      .post(ApiRoutes.carriers.create)
      .send({
        carrierId: CarrierId.FORZA,
        credentials: { apiKey: FAKE_CARRIER_API_KEY },
        displayName: `${prefix}-forza-${(counter += 1)}`
      })
    expect(response.status).toBe(CREATED)
    return (response.body as { id: string }).id
  }
  const mappings = async (id: string): Promise<MappingBody[]> => {
    const response = await asAdmin().get(`${ApiRoutes.carriers.statusMappings(id)}?limit=100`)
    expect(response.status).toBe(OK)
    return (response.body as Page<MappingBody>).data
  }
  const mapping = async (id: string, code: string): Promise<MappingBody | undefined> =>
    (await mappings(id)).find(row => row.providerCode === code)
  const put = (id: string, code: string, body: unknown) =>
    asAdmin()
      .put(ApiRoutes.carriers.statusMappingByCode(id, encodeURIComponent(code)))
      .send(body as object)

  describe('what the connection starts with', () => {
    it('seeds one row per code of the catalog that has a default, as the plugin says', async () => {
      const id = await forza()
      const rows = await mappings(id)

      const expected = fakeCarrierStatuses.filter(entry => entry.defaultStatus !== null)
      expect(rows.map(row => row.providerCode).sort()).toEqual(
        expected.map(entry => entry.code).sort()
      )
      for (const row of rows) {
        expect(row.source).toBe(CarrierStatusMappingSource.DEFAULT)
        expect(row.status).toBe(
          expected.find(entry => entry.code === row.providerCode)?.defaultStatus
        )
      }
      // A code the plugin cannot safely map is not seeded: the owner decides when it first arrives
      expect(rows.some(row => row.providerCode === 'info')).toBe(false)
    })

    it('lists in pages by code, with a cursor that is not ours refused', async () => {
      const id = await forza()
      const first = await asAdmin().get(`${ApiRoutes.carriers.statusMappings(id)}?limit=3`)
      const firstPage = first.body as Page<MappingBody>
      expect(firstPage.data).toHaveLength(3)
      expect(firstPage.hasMore).toBe(true)
      const second = await asAdmin().get(
        `${ApiRoutes.carriers.statusMappings(id)}?limit=100&cursor=${firstPage.nextCursor}`
      )
      const rest = (second.body as Page<MappingBody>).data
      expect(rest.length).toBeGreaterThan(0)
      expect([...firstPage.data, ...rest].map(row => row.providerCode)).toEqual(
        (await mappings(id)).map(row => row.providerCode)
      )
      const bad = await asAdmin().get(
        `${ApiRoutes.carriers.statusMappings(id)}?cursor=not-a-cursor`
      )
      expect(bad.status).toBe(BAD_REQUEST)
    })

    it('has none for the local courier, whose statuses are set by hand', async () => {
      const response = await asAdmin()
        .post(ApiRoutes.carriers.create)
        .send({
          carrierId: CarrierId.LOCAL,
          credentials: { name: `${prefix}-local`, phone: '70001111', prefix: 'MAP' }
        })
      expect(response.status).toBe(CREATED)
      expect(await mappings((response.body as { id: string }).id)).toEqual([])
    })
  })

  describe('the catalog of the plugin', () => {
    interface CatalogEntry {
      providerCode: string
      label: string
      defaultStatus: string | null
      hasMapping: boolean
      mappedStatus: string | null
      source: string | null
    }
    const catalog = async (id: string): Promise<CatalogEntry[]> => {
      const response = await asAdmin().get(ApiRoutes.carriers.statusCatalog(id))
      expect(response.status).toBe(OK)
      return response.body as CatalogEntry[]
    }

    it('lists every code the plugin knows, with the row each has, and the code with no safe default has none', async () => {
      const id = await forza()
      const entries = await catalog(id)
      expect(entries.map(entry => entry.providerCode).sort()).toEqual(
        fakeCarrierStatuses.map(entry => entry.code).sort()
      )
      const delivered = entries.find(entry => entry.providerCode === 'delivered')
      expect(delivered).toMatchObject({
        hasMapping: true,
        mappedStatus: ShipmentStatus.DELIVERED,
        source: CarrierStatusMappingSource.DEFAULT
      })
      expect(entries.find(entry => entry.providerCode === 'info')).toMatchObject({
        defaultStatus: null,
        hasMapping: false,
        mappedStatus: null,
        source: null
      })
    })

    it('shows a code the connection lacks (one added after it was made) as not mapped, and a put gives it its row', async () => {
      const id = await forza()
      await owner.carrierStatusMapping.deleteMany({
        where: { connectionId: id, providerCode: 'delivered' }
      })
      expect((await catalog(id)).find(entry => entry.providerCode === 'delivered')).toMatchObject({
        hasMapping: false,
        mappedStatus: null
      })
      expect((await put(id, 'delivered', { status: ShipmentStatus.DELIVERED })).status).toBe(OK)
      expect((await catalog(id)).find(entry => entry.providerCode === 'delivered')).toMatchObject({
        hasMapping: true,
        mappedStatus: ShipmentStatus.DELIVERED,
        source: CarrierStatusMappingSource.CUSTOM
      })
    })

    it('needs shipping:view and is the same 404 in another store as for a connection that does not exist', async () => {
      const id = await forza()
      const manager = await actorWithPermissions(owner, app, {
        prefix,
        name: 'catalog-manager',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SETTINGS_MANAGE_CARRIERS]
      })
      expect(
        (await api(app, manager, ctx.storeA).get(ApiRoutes.carriers.statusCatalog(id))).status
      ).toBe(FORBIDDEN)
      const other = await asAdminB().get(ApiRoutes.carriers.statusCatalog(id))
      const unknown = await asAdminB().get(ApiRoutes.carriers.statusCatalog(randomUUID()))
      expect(other.status).toBe(NOT_FOUND)
      expect((other.body as ErrorBody).error).toEqual((unknown.body as ErrorBody).error)
      expect((await asAdmin().get(ApiRoutes.carriers.statusCatalog('not-an-id'))).status).toBe(
        BAD_REQUEST
      )
    })
  })

  describe('changing a row', () => {
    it('maps a code under whatever spelling the carrier uses, marks it custom and audits both statuses', async () => {
      const id = await forza()

      const response = await put(id, ' Delivered ', { status: ShipmentStatus.RETURNED })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        providerCode: 'delivered',
        status: ShipmentStatus.RETURNED,
        source: CarrierStatusMappingSource.CUSTOM
      })
      expect(await mapping(id, 'delivered')).toMatchObject({
        status: ShipmentStatus.RETURNED,
        source: CarrierStatusMappingSource.CUSTOM
      })
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.CARRIER_STATUS_MAPPING_CHANGED,
        resourceId: id
      })
      expect(entry?.storeId).toBe(ctx.storeA.id)
      expect(entry?.metadata).toMatchObject({
        providerCode: 'delivered',
        hadRow: true,
        oldStatus: ShipmentStatus.DELIVERED,
        newStatus: ShipmentStatus.RETURNED
      })
    })

    it('lets the owner ignore a code on purpose, which is a row with no status', async () => {
      const id = await forza()

      const response = await put(id, 'transit', { status: null })

      expect(response.status).toBe(OK)
      expect(await mapping(id, 'transit')).toMatchObject({
        status: null,
        source: CarrierStatusMappingSource.CUSTOM
      })
    })

    it('creates the row of a code the plugin does not know, labelled with what the carrier said', async () => {
      const id = await forza()
      await owner.carrierUnmappedStatus.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: id,
          providerCode: 'en bodega',
          sampleRawStatus: 'En Bodega'
        }
      })

      const response = await put(id, 'EN  bodega', { status: ShipmentStatus.IN_TRANSIT })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        providerCode: 'en bodega',
        label: 'En Bodega',
        source: CarrierStatusMappingSource.CUSTOM
      })
    })

    it('resolves the code that waited for the owner, and takes it out of the list', async () => {
      const id = await forza()
      await owner.carrierUnmappedStatus.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: id,
          providerCode: '16:115',
          sampleRawStatus: '16',
          occurrences: 4
        }
      })
      const before = await asAdmin().get(ApiRoutes.carriers.unmappedStatuses(id))
      expect((before.body as Page<UnmappedBody>).data).toEqual([
        expect.objectContaining({ providerCode: '16:115', occurrences: 4, sampleRawStatus: '16' })
      ])

      const response = await put(id, '16:115', { status: ShipmentStatus.RETURNED })

      expect(response.status).toBe(OK)
      const after = await asAdmin().get(ApiRoutes.carriers.unmappedStatuses(id))
      expect((after.body as Page<UnmappedBody>).data).toEqual([])
      const row = await owner.carrierUnmappedStatus.findFirstOrThrow({
        where: { connectionId: id, providerCode: '16:115' }
      })
      expect(row.resolvedAt).not.toBeNull()
    })

    it('also settles the composite codes of its reasons that have no row of their own', async () => {
      const id = await forza()
      for (const providerCode of ['16:115', '16:117']) {
        await owner.carrierUnmappedStatus.create({
          data: {
            storeId: ctx.storeA.id,
            connectionId: id,
            providerCode,
            sampleRawStatus: providerCode
          }
        })
      }
      // The owner maps one reason alone, then the plain status
      await put(id, '16:117', { status: ShipmentStatus.RETURNED })
      await put(id, '16', { status: ShipmentStatus.FAILED_ATTEMPT })

      const left = await asAdmin().get(ApiRoutes.carriers.unmappedStatuses(id))
      expect((left.body as Page<UnmappedBody>).data).toEqual([])
      expect((await mapping(id, '16:117'))?.status).toBe(ShipmentStatus.RETURNED)
    })

    it.each([
      ['an internal status', { status: ShipmentStatus.CREATING }],
      ['another internal status', { status: ShipmentStatus.REQUIRES_REVIEW }],
      ['a word that is no status', { status: 'teleported' }],
      ['no status at all', {}],
      ['a key it does not know', { status: ShipmentStatus.DELIVERED, source: 'default' }]
    ])('refuses %s', async (_name, body) => {
      const id = await forza()

      const response = await put(id, 'delivered', body)

      expect(response.status).toBe(BAD_REQUEST)
      expect((await mapping(id, 'delivered'))?.status).toBe(ShipmentStatus.DELIVERED)
    })

    it('refuses a code that cannot be one', async () => {
      const id = await forza()

      const tooLong = await put(id, 'x'.repeat(CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH + 1), {
        status: ShipmentStatus.DELIVERED
      })
      const blank = await put(id, ' ', { status: ShipmentStatus.DELIVERED })
      const control = await put(id, 'a\u0007b', { status: ShipmentStatus.DELIVERED })

      expect(tooLong.status).toBe(BAD_REQUEST)
      expect(blank.status).toBe(BAD_REQUEST)
      expect(control.status).toBe(BAD_REQUEST)
    })

    it('stops at the number of rows a connection may hold', async () => {
      const id = await forza()
      const held = await owner.carrierStatusMapping.count({ where: { connectionId: id } })
      await owner.carrierStatusMapping.createMany({
        data: Array.from(
          { length: CarrierStatusLimits.MAX_MAPPINGS_PER_CONNECTION - held },
          (_value, index) => ({
            storeId: ctx.storeA.id,
            connectionId: id,
            providerCode: `filler-${index}`,
            status: ShipmentStatus.IN_TRANSIT
          })
        )
      })

      const response = await put(id, 'one-more', { status: ShipmentStatus.DELIVERED })

      expect(response.status).toBe(CONFLICT)
      // A row that exists is still edited
      expect((await put(id, 'filler-1', { status: ShipmentStatus.DELIVERED })).status).toBe(OK)
    })

    it('takes no change for a connection that was let go, and still shows what it holds', async () => {
      const id = await forza()
      const gone = await asAdmin().post(ApiRoutes.carriers.disconnect(id))
      expect(gone.status).toBe(OK)

      const response = await put(id, 'delivered', { status: ShipmentStatus.RETURNED })
      const removal = await asAdmin().delete(
        ApiRoutes.carriers.statusMappingByCode(id, 'delivered')
      )

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE)
      expect(removal.status).toBe(CONFLICT)
      expect((await mapping(id, 'delivered'))?.status).toBe(ShipmentStatus.DELIVERED)
    })
  })

  describe('restoring what the plugin says', () => {
    it('puts a code of the catalog back as it was seeded', async () => {
      const id = await forza()
      await put(id, 'delivered', { status: ShipmentStatus.RETURNED })

      const response = await asAdmin().delete(
        ApiRoutes.carriers.statusMappingByCode(id, 'DELIVERED')
      )

      expect(response.status).toBe(NO_CONTENT)
      expect(await mapping(id, 'delivered')).toMatchObject({
        status: ShipmentStatus.DELIVERED,
        source: CarrierStatusMappingSource.DEFAULT
      })
      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.CARRIER_STATUS_MAPPING_CHANGED, resourceId: id },
        2
      )
      expect(
        entries.map(entry => (entry.metadata as { newStatus: string }).newStatus).sort()
      ).toEqual([ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED].sort())
    })

    it('puts a code the plugin has no default for back to unmapped, by removing its row', async () => {
      const id = await forza()
      // `info` is in the catalog with no default: the owner mapped it, and now takes it back
      await put(id, 'info', { status: ShipmentStatus.IN_TRANSIT })
      // A code the catalog does not have at all
      await put(id, 'zzz', { status: ShipmentStatus.IN_TRANSIT })

      expect(
        (await asAdmin().delete(ApiRoutes.carriers.statusMappingByCode(id, 'info'))).status
      ).toBe(NO_CONTENT)
      expect(
        (await asAdmin().delete(ApiRoutes.carriers.statusMappingByCode(id, 'zzz'))).status
      ).toBe(NO_CONTENT)

      expect(await mapping(id, 'info')).toBeUndefined()
      expect(await mapping(id, 'zzz')).toBeUndefined()
    })

    it('answers 404 for a code that has no row', async () => {
      const id = await forza()

      const response = await asAdmin().delete(ApiRoutes.carriers.statusMappingByCode(id, 'nothing'))

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('who may', () => {
    it('reads with shipping:view and changes with settings:manage_carriers, each on its own', async () => {
      const id = await forza()
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'mapping-viewer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW]
      })
      const manager = await actorWithPermissions(owner, app, {
        prefix,
        name: 'mapping-manager',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SETTINGS_MANAGE_CARRIERS]
      })
      const asViewer = api(app, viewer, ctx.storeA)
      const asManager = api(app, manager, ctx.storeA)
      const route = ApiRoutes.carriers.statusMappingByCode(id, 'delivered')

      expect((await asViewer.get(ApiRoutes.carriers.statusMappings(id))).status).toBe(OK)
      expect((await asViewer.get(ApiRoutes.carriers.unmappedStatuses(id))).status).toBe(OK)
      expect((await asViewer.put(route).send({ status: ShipmentStatus.RETURNED })).status).toBe(
        FORBIDDEN
      )
      expect((await asViewer.delete(route)).status).toBe(FORBIDDEN)

      expect((await asManager.get(ApiRoutes.carriers.statusMappings(id))).status).toBe(FORBIDDEN)
      expect((await asManager.get(ApiRoutes.carriers.unmappedStatuses(id))).status).toBe(FORBIDDEN)
      expect((await asManager.put(route).send({ status: ShipmentStatus.RETURNED })).status).toBe(OK)
    })

    it('shows another store nothing of the connection: the same 404 as one that does not exist', async () => {
      const id = await forza()
      const route = ApiRoutes.carriers.statusMappingByCode(id, 'delivered')
      const missing = randomUUID()

      const responses = [
        await asAdminB().get(ApiRoutes.carriers.statusMappings(id)),
        await asAdminB().get(ApiRoutes.carriers.unmappedStatuses(id)),
        await asAdminB().put(route).send({ status: ShipmentStatus.RETURNED }),
        await asAdminB().delete(route),
        await asAdminB().post(ApiRoutes.carriers.webhookSecret(id))
      ]
      const unknown = await asAdminB().get(ApiRoutes.carriers.statusMappings(missing))

      for (const response of responses) expect(response.status).toBe(NOT_FOUND)
      expect((responses[0]?.body as ErrorBody).error).toEqual((unknown.body as ErrorBody).error)
      expect((await mapping(id, 'delivered'))?.status).toBe(ShipmentStatus.DELIVERED)
    })

    it('refuses a connection id that is not one', async () => {
      const response = await asAdmin().get(ApiRoutes.carriers.statusMappings('not-an-id'))

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('the secret of the webhook', () => {
    interface Rotated {
      webhookSecret: string
    }
    const sealedSecretOf = async (id: string) =>
      (await owner.carrierConnection.findUniqueOrThrow({ where: { id } })).webhookSecret

    it('makes a new one, shows it once, and keeps it out of every read and of the audit', async () => {
      const id = await forza()
      const before = await sealedSecretOf(id)

      const response = await asAdmin().post(ApiRoutes.carriers.webhookSecret(id))

      expect(response.status).toBe(OK)
      const { webhookSecret } = response.body as Rotated
      expect(webhookSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/)
      expect(response.headers['cache-control']).toMatch(/no-store/)
      const after = await sealedSecretOf(id)
      expect(after).not.toBeNull()
      expect(Buffer.from(after ?? []).equals(Buffer.from(before ?? []))).toBe(false)
      const read = await asAdmin().get(ApiRoutes.carriers.byId(id))
      expect(JSON.stringify(read.body)).not.toContain(webhookSecret)
      expect(read.body).toMatchObject({ hasWebhookSecret: true })
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.CARRIER_WEBHOOK_SECRET_ROTATED,
        resourceId: id
      })
      expect(entry?.storeId).toBe(ctx.storeA.id)
      expect(JSON.stringify(entry?.metadata)).not.toContain(webhookSecret)
    })

    it('makes a different one each time', async () => {
      const id = await forza()
      const first = (await asAdmin().post(ApiRoutes.carriers.webhookSecret(id))).body as Rotated
      const second = (await asAdmin().post(ApiRoutes.carriers.webhookSecret(id))).body as Rotated

      expect(second.webhookSecret).not.toBe(first.webhookSecret)
    })

    it('needs settings:manage_carriers', async () => {
      const id = await forza()
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'secret-viewer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW]
      })

      const response = await api(app, viewer, ctx.storeA).post(ApiRoutes.carriers.webhookSecret(id))

      expect(response.status).toBe(FORBIDDEN)
    })

    it('has nothing to make for a carrier that pushes no status, nor for a connection that was let go', async () => {
      const local = await asAdmin()
        .post(ApiRoutes.carriers.create)
        .send({
          carrierId: CarrierId.LOCAL,
          credentials: { name: `${prefix}-local-secret`, phone: '70001111', prefix: 'SEC' }
        })
      const localId = (local.body as { id: string }).id
      const gone = await forza()
      await asAdmin().post(ApiRoutes.carriers.disconnect(gone))

      const noWebhook = await asAdmin().post(ApiRoutes.carriers.webhookSecret(localId))
      const disconnected = await asAdmin().post(ApiRoutes.carriers.webhookSecret(gone))

      expect(noWebhook.status).toBe(CONFLICT)
      expect(codeOf(noWebhook.body)).toBe(ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING)
      expect(disconnected.status).toBe(CONFLICT)
      expect(codeOf(disconnected.body)).toBe(ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE)
      expect((await sealedSecretOf(gone)) ?? null).toBeNull()
    })
  })
})
