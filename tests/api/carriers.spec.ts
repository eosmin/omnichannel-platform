import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierConnectionLimits,
  CarrierConnectionStatus,
  CarrierHealthReasons,
  CarrierId,
  PickupStatus,
  ShipmentStatus,
  ShippingPayer,
  ShippingPlugin
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { buildCarrierContext, takeLocalGuideNumber } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import {
  buildFakeCarrier,
  createCarrierConnection,
  createOrder,
  FAKE_CARRIER_API_KEY,
  fakeCarrierStatuses,
  type FakeCarrier
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const UNAVAILABLE = 503

interface ErrorBody {
  error: { code: string; metadata?: { reason?: string } }
}

interface ConnectionBody {
  id: string
  carrierId: string
  carrierName: string
  displayName: string
  status: string
  hasCredentials: boolean
  hasWebhookSecret: boolean
  webhookUrl: string | null
  webhookSecret?: string | null
  isDefault: boolean
  defaultServiceCode: string | null
  guidePrefix: string | null
  contact: Record<string, unknown> | null
  services: { code: string; label: string; active: boolean }[]
  openShipments: number
  openPickups: number
  maxShippingFeeCents: number | null
  lastError: string | null
  lastHealthyAt: string | null
  capabilities: string[]
}

const LOCAL_CREDENTIALS = {
  name: 'Juan the courier',
  phone: '70001111',
  notes: 'Mornings'
}

describe('Settings → Carriers: the connections of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let fake: FakeCarrier
  let counter = 0
  let installationId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    // The registry of the api holds the real `local` courier only: the fake stands for Forza here, as the builder says
    fake = buildFakeCarrier({ id: CarrierId.FORZA, webhook: true, fetchStatus: true })
    app.get(CarrierRegistry, { strict: false }).register(fake.plugin)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  // A prefix no other courier of the suite has: two couriers of a store never share one
  const freshPrefix = () => `S${(counter += 1).toString(36).toUpperCase()}`
  const name = () => `${prefix}-courier-${(counter += 1)}`
  const local = (over: Record<string, unknown> = {}, credentials: Record<string, unknown> = {}) =>
    asAdmin()
      .post(ApiRoutes.carriers.create)
      .send({
        carrierId: CarrierId.LOCAL,
        credentials: { ...LOCAL_CREDENTIALS, name: name(), prefix: freshPrefix(), ...credentials },
        ...over
      })
  const external = (over: Record<string, unknown> = {}) =>
    asAdmin()
      .post(ApiRoutes.carriers.create)
      .send({
        carrierId: CarrierId.FORZA,
        credentials: { apiKey: FAKE_CARRIER_API_KEY },
        displayName: name(),
        ...over
      })
  const read = async (id: string): Promise<ConnectionBody> => {
    const response = await asAdmin().get(ApiRoutes.carriers.byId(id))
    expect(response.status).toBe(OK)
    return response.body as ConnectionBody
  }
  const made = (response: { status: number; body: unknown }): ConnectionBody => {
    expect(response.status).toBe(CREATED)
    return response.body as ConnectionBody
  }

  describe('before the plugin is installed', () => {
    it('refuses to connect a carrier, and says the plugin is not installed', async () => {
      const response = await local()
      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
      expect(await owner.carrierConnection.count({ where: { storeId: ctx.storeA.id } })).toBe(0)
    })

    it('lists the shipping plugin in the catalog, with nothing open to warn about', async () => {
      const response = await asAdmin().get(ApiRoutes.plugins.available)
      const entry = (
        response.body as { id: string; installed: boolean; openShipments: number; type: string }[]
      ).find(candidate => candidate.id === ShippingPlugin.ID)
      expect(entry).toMatchObject({ installed: false, openShipments: 0, type: 'carrier' })
    })

    it('installs from the catalog like any plugin', async () => {
      const response = await asAdmin()
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: ShippingPlugin.ID })
      expect(response.status).toBe(CREATED)
      installationId = (response.body as { installationId: string }).installationId
      expect(installationId).toMatch(/[0-9a-f-]{36}/)
    })
  })

  describe('who may see and who may change', () => {
    it('lets a member who can see shipping read the registry and the list, and no more', async () => {
      const agent = api(app, ctx.agentA, ctx.storeA)
      expect((await agent.get(ApiRoutes.carriers.registry)).status).toBe(OK)
      expect((await agent.get(ApiRoutes.carriers.list)).status).toBe(OK)
      const refused = await agent.post(ApiRoutes.carriers.create).send({
        carrierId: CarrierId.LOCAL,
        credentials: { ...LOCAL_CREDENTIALS, name: name(), prefix: 'ZA' }
      })
      expect(refused.status).toBe(FORBIDDEN)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PERMISSION_DENIED)
    })

    it('needs shipping:view to read and settings:manage_carriers to change, each on its own', async () => {
      const manager = await actorWithPermissions(owner, app, {
        prefix,
        name: 'carrier-manager',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SETTINGS_MANAGE_CARRIERS]
      })
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'carrier-viewer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW]
      })
      const connection = made(await local())
      const asManager = api(app, manager, ctx.storeA)
      const asViewer = api(app, viewer, ctx.storeA)

      expect((await asManager.get(ApiRoutes.carriers.list)).status).toBe(FORBIDDEN)
      expect((await asManager.get(ApiRoutes.carriers.byId(connection.id))).status).toBe(FORBIDDEN)
      expect((await asManager.get(ApiRoutes.carriers.registry)).status).toBe(FORBIDDEN)
      expect((await asViewer.get(ApiRoutes.carriers.byId(connection.id))).status).toBe(OK)

      for (const attempt of [
        asViewer.patch(ApiRoutes.carriers.byId(connection.id)).send({ displayName: 'x' }),
        asViewer.post(ApiRoutes.carriers.test(connection.id)),
        asViewer.post(ApiRoutes.carriers.disconnect(connection.id))
      ]) {
        const response = await attempt
        expect(response.status).toBe(FORBIDDEN)
      }
      expect((await read(connection.id)).displayName).toBe(connection.displayName)
      expect((await asManager.post(ApiRoutes.carriers.test(connection.id))).status).toBe(OK)
    })

    it('keeps the connections of one store out of another', async () => {
      const connection = made(await local())
      const other = await asAdminB().get(ApiRoutes.carriers.byId(connection.id))
      expect(other.status).toBe(NOT_FOUND)
      const list = await asAdminB().get(ApiRoutes.carriers.list)
      expect((list.body as { data: ConnectionBody[] }).data).toEqual([])
      // Nor can the other store make this one its default, or change it
      const change = await asAdminB()
        .patch(ApiRoutes.carriers.byId(connection.id))
        .send({ isDefault: true })
      expect(change.status).toBe(NOT_FOUND)
    })
  })

  describe('the registry', () => {
    it('says which carriers the platform has, what each can do and its services in the language of the store', async () => {
      const response = await asAdmin().get(ApiRoutes.carriers.registry)
      const entries = response.body as {
        id: string
        name: string
        capabilities: string[]
        hasCredentials: boolean
        services: { code: string; label: string }[]
      }[]
      const courier = entries.find(entry => entry.id === CarrierId.LOCAL)
      expect(courier).toMatchObject({ hasCredentials: false })
      expect(courier?.capabilities).toEqual(expect.arrayContaining(['internal_guide', 'cod']))
      const locale = (
        await owner.store.findUniqueOrThrow({
          where: { id: ctx.storeA.id },
          select: { defaultLocale: true }
        })
      ).defaultLocale
      expect(courier?.name).toBe(locale === 'en' ? 'Local courier' : 'Mensajero local')
      expect(courier?.services).toEqual([
        { code: 'local', label: locale === 'en' ? 'Local delivery' : 'Entrega local' }
      ])
      expect(entries.find(entry => entry.id === CarrierId.FORZA)?.hasCredentials).toBe(true)
    })
  })

  describe('connecting a local courier', () => {
    it('makes the connection with its service and its numbering, and holds no credentials', async () => {
      const body = made(
        await local({ defaultShippingFeeCents: 300, minShippingFeeCents: 100 }, { prefix: 'JM' })
      )
      expect(body).toMatchObject({
        carrierId: CarrierId.LOCAL,
        status: CarrierConnectionStatus.ACTIVE,
        hasCredentials: false,
        hasWebhookSecret: false,
        webhookUrl: null,
        guidePrefix: 'JM',
        defaultServiceCode: 'local',
        contact: { phone: '70001111', notes: 'Mornings' },
        isDefault: false
      })
      expect(body.services).toEqual([
        { code: 'local', label: expect.any(String) as string, active: true }
      ])
      expect(body.webhookSecret).toBeNull()
      const row = await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        credentials: null,
        webhookSecret: null,
        defaultShippingFeeCents: 300,
        minShippingFeeCents: 100
      })
      expect(
        await owner.guideSequence.findUnique({ where: { connectionId: body.id } })
      ).toMatchObject({
        prefix: 'JM',
        nextValue: 1,
        storeId: ctx.storeA.id
      })
      expect(await owner.carrierService.count({ where: { connectionId: body.id } })).toBe(1)
      // A courier makes no statuses of its own: nothing is seeded
      expect(await owner.carrierStatusMapping.count({ where: { connectionId: body.id } })).toBe(0)
    })

    it('audits the connection without any value of the credentials', async () => {
      const body = made(await local())
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.CARRIER_CONNECTED,
        resourceId: body.id
      })
      expect(entry?.storeId).toBe(ctx.storeA.id)
      expect(JSON.stringify(entry?.metadata)).not.toContain(LOCAL_CREDENTIALS.phone)
    })

    it('refuses a prefix the barcode cannot carry, naming the reason and not the words of the courier', async () => {
      const response = await local({}, { prefix: 'jm!' })
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_CARRIER_CREDENTIALS_INVALID)
      expect((response.body as ErrorBody).error.metadata?.reason).toBe(
        CarrierHealthReasons.REJECTED
      )
    })

    it('refuses a second connection with the same name', async () => {
      const first = made(await local())
      const again = await local({}, { name: first.displayName })
      expect(again.status).toBe(CONFLICT)
      expect(codeOf(again.body)).toBe(ErrorCodes.RESOURCE_ALREADY_EXISTS)
    })

    it('never lets two couriers of a store print the same guide numbers', async () => {
      const first = made(await local({}, { prefix: 'UQ' }))
      const clash = await local({}, { prefix: 'UQ' })
      expect(clash.status).toBe(CONFLICT)
      expect(codeOf(clash.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      const other = made(await local({}, { prefix: 'UR' }))
      const change = await asAdmin()
        .patch(ApiRoutes.carriers.byId(other.id))
        .send({ credentials: { name: 'x', phone: '1', prefix: 'UQ' } })
      expect(change.status).toBe(CONFLICT)
      expect((await read(other.id)).guidePrefix).toBe('UR')
      // The courier keeps its own prefix when it is edited with it
      const same = await asAdmin()
        .patch(ApiRoutes.carriers.byId(first.id))
        .send({ credentials: { name: 'x', phone: '2', prefix: 'UQ' } })
      expect(same.status).toBe(OK)
    })

    it('asks the carrier nothing when the store has no room or the name is taken, and keeps the answer out of any cache', async () => {
      const taken = made(await external())
      const asked = fake.callsTo('connect').length
      const again = await external({ displayName: taken.displayName })
      expect(again.status).toBe(CONFLICT)
      expect(fake.callsTo('connect')).toHaveLength(asked)
      const fresh = await external()
      expect(fresh.headers['cache-control']).toContain('no-store')
    })

    it('tells the carrier that an account it made was not kept when the connection could not be written', async () => {
      const original = fake.plugin.connect.bind(fake.plugin)
      const taken = made(await external())
      const told = fake.callsTo('disconnect').length
      try {
        // The carrier names the account as one that exists: the name is only known after it answers
        fake.plugin.connect = async input => ({
          ...(await original(input)),
          displayName: taken.displayName
        })
        const response = await asAdmin()
          .post(ApiRoutes.carriers.create)
          .send({ carrierId: CarrierId.FORZA, credentials: { apiKey: FAKE_CARRIER_API_KEY } })
        expect(response.status).toBe(CONFLICT)
      } finally {
        fake.plugin.connect = original
      }
      expect(fake.callsTo('disconnect')).toHaveLength(told + 1)
    })

    it('does not ask the carrier for an account when the settings or the default service are wrong', async () => {
      const asked = fake.callsTo('connect').length
      const service = await external({ defaultServiceCode: 'nope' })
      expect(service.status).toBe(BAD_REQUEST)
      const pickups = await external({ autoPickup: true, autoPickupTime: '08:00' })
      expect(pickups.status).toBe(BAD_REQUEST)
      expect(fake.callsTo('connect')).toHaveLength(asked)
    })

    it('tells the carrier that the account of new credentials was not kept when the edit fails', async () => {
      const one = made(await external())
      const two = made(await external())
      const told = fake.callsTo('disconnect').length
      const clash = await asAdmin()
        .patch(ApiRoutes.carriers.byId(two.id))
        .send({ displayName: one.displayName, credentials: { apiKey: 'new-key' } })
      expect(clash.status).toBe(CONFLICT)
      expect(fake.callsTo('disconnect')).toHaveLength(told + 1)
    })

    it('refuses a body with a store, a field it does not know or a rule the carrier would break', async () => {
      const cases: Record<string, unknown>[] = [
        { storeId: ctx.storeB.id },
        { status: 'error' },
        { minShippingFeeCents: 500, maxShippingFeeCents: 100 },
        { defaultShippingFeeCents: 50, minShippingFeeCents: 100 },
        { pickupEnabled: true, pickupDays: [] },
        { pickupDays: [1, 1] },
        { labelFormat: 'jpeg' },
        { defaultShippingFeeCents: -1 },
        { pickupCutoffTime: '25:00' }
      ]
      for (const over of cases) {
        const response = await local(over)
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      }
    })

    it('refuses a default service the carrier does not have, a rule the settings break, and a carrier that is not there', async () => {
      const service = await local({ defaultServiceCode: 'nope' })
      expect(service.status).toBe(BAD_REQUEST)
      expect(codeOf(service.body)).toBe(ErrorCodes.VALIDATION_INVALID_INPUT)
      // Automatic pickups need pickups switched on; the schema cannot see that, the connection does
      const pickups = await local({ autoPickup: true, autoPickupTime: '08:00' })
      expect(pickups.status).toBe(BAD_REQUEST)
      expect(codeOf(pickups.body)).toBe(ErrorCodes.VALIDATION_INVALID_INPUT)
      const missing = await asAdmin()
        .post(ApiRoutes.carriers.create)
        .send({ carrierId: CarrierId.C807, credentials: {}, displayName: name() })
      expect(missing.status).toBe(NOT_FOUND)
    })

    it('makes it the default of the store when asked, and only one at a time', async () => {
      const first = made(await local({ isDefault: true }))
      expect(first.isDefault).toBe(true)
      const second = made(await local({ isDefault: true }))
      expect(second.isDefault).toBe(true)
      expect((await read(first.id)).isDefault).toBe(false)
      expect(
        (await owner.storeSettings.findUniqueOrThrow({ where: { storeId: ctx.storeA.id } }))
          .defaultCarrierConnectionId
      ).toBe(second.id)
      const list = await asAdmin().get(ApiRoutes.carriers.list)
      expect(
        (list.body as { data: ConnectionBody[] }).data.filter(entry => entry.isDefault)
      ).toHaveLength(1)
    })

    it('stops at the most connections a store may have', async () => {
      const store = await owner.store.create({
        data: {
          organizationId: ctx.orgA.id,
          name: `${prefix}-full`,
          slug: `${prefix}-full`
        }
      })
      await owner.pluginInstallation.create({
        data: {
          storeId: store.id,
          pluginId: ShippingPlugin.ID,
          scopes: [],
          status: 'active',
          installedBy: 'suite'
        }
      })
      const full = await actorWithPermissions(owner, app, {
        prefix,
        name: 'full-store',
        organizationId: ctx.orgA.id,
        storeId: store.id,
        permissions: [Permissions.SETTINGS_MANAGE_CARRIERS, Permissions.SHIPPING_VIEW]
      })
      for (let index = 0; index < CarrierConnectionLimits.MAX_PER_STORE; index += 1) {
        await createCarrierConnection(owner, { storeId: store.id })
      }
      const response = await api(app, full, { id: store.id })
        .post(ApiRoutes.carriers.create)
        .send({
          carrierId: CarrierId.LOCAL,
          credentials: { ...LOCAL_CREDENTIALS, name: name(), prefix: 'ZB' }
        })
      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
    })
  })

  describe('connecting a carrier with an account', () => {
    it('keeps the credentials and the webhook secret encrypted, and gives the secret once', async () => {
      const body = made(await external())
      expect(body).toMatchObject({
        carrierId: CarrierId.FORZA,
        hasCredentials: true,
        hasWebhookSecret: true,
        guidePrefix: null,
        contact: null
      })
      expect(body.webhookUrl).toContain(ApiRoutes.webhooks.carrier(body.id))
      expect(typeof body.webhookSecret).toBe('string')
      // Nothing secret in what the creation answered besides that one value, and nothing at all in what comes after
      expect(JSON.stringify({ ...body, webhookSecret: null })).not.toContain(FAKE_CARRIER_API_KEY)
      const later = JSON.stringify([
        await read(body.id),
        (await asAdmin().get(ApiRoutes.carriers.list)).body
      ])
      expect(later).not.toContain(FAKE_CARRIER_API_KEY)
      expect(later).not.toContain(body.webhookSecret ?? 'missing')

      const row = await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.credentials).not.toBeNull()
      expect(Buffer.from(row.credentials ?? []).includes(FAKE_CARRIER_API_KEY)).toBe(false)
      expect(Buffer.from(row.webhookSecret ?? []).includes(body.webhookSecret ?? 'missing')).toBe(
        false
      )
      // What the platform opens for a call is what was given
      const cipher = app.get(CredentialCipher, { strict: false })
      expect(buildCarrierContext(row, cipher).credentials).toEqual({ apiKey: FAKE_CARRIER_API_KEY })
      expect(cipher.open(row.webhookSecret ?? new Uint8Array())).toEqual({
        secret: body.webhookSecret
      })
    })

    it('seeds the services of the catalog and the statuses the carrier documents', async () => {
      const body = made(await external())
      expect(body.services.map(service => service.code)).toEqual(['next_day', 'standard'])
      expect(body.defaultServiceCode).toBe('next_day')
      const mappings = await owner.carrierStatusMapping.findMany({
        where: { connectionId: body.id },
        orderBy: { providerCode: 'asc' }
      })
      const documented = fakeCarrierStatuses.filter(entry => entry.defaultStatus !== null)
      expect(mappings.map(row => row.providerCode).sort()).toEqual(
        documented.map(entry => entry.code).sort()
      )
      expect(mappings.every(row => row.source === 'default' && row.storeId === ctx.storeA.id)).toBe(
        true
      )
      // A code the carrier cannot safely map is left for the owner: it stays unmapped
      expect(mappings.some(row => row.providerCode === 'info')).toBe(false)
    })

    it('answers a carrier that refuses with a reason of a closed list, never with its words', async () => {
      const original = fake.plugin.connect.bind(fake.plugin)
      try {
        fake.plugin.connect = () => Promise.reject(new CarrierAuthError('token abc is revoked'))
        const auth = await external()
        expect(auth.status).toBe(BAD_REQUEST)
        expect(codeOf(auth.body)).toBe(ErrorCodes.SHIPPING_CARRIER_CREDENTIALS_INVALID)
        expect((auth.body as ErrorBody).error.metadata?.reason).toBe(CarrierHealthReasons.AUTH)
        expect(JSON.stringify(auth.body)).not.toContain('abc')

        fake.plugin.connect = () =>
          Promise.reject(new CarrierRejectedError('account 4411 suspended'))
        const rejected = await external()
        expect(rejected.status).toBe(BAD_REQUEST)
        expect(JSON.stringify(rejected.body)).not.toContain('4411')

        fake.plugin.connect = () => Promise.reject(new CarrierUnavailableError('502 from host'))
        const down = await external()
        expect(down.status).toBe(UNAVAILABLE)
        expect(codeOf(down.body)).toBe(ErrorCodes.SHIPPING_CARRIER_UNAVAILABLE)

        fake.plugin.connect = () =>
          Promise.resolve({ displayName: '  ', credentials: {}, metadata: {} })
        // An answer the platform cannot use is the plugin's fault, not the owner's: it is not told as bad credentials
        const invalid = await external()
        expect(invalid.status).toBe(500)
        expect(codeOf(invalid.body)).not.toBe(ErrorCodes.SHIPPING_CARRIER_CREDENTIALS_INVALID)
      } finally {
        fake.plugin.connect = original
      }
    })
  })

  describe('testing a connection', () => {
    it('records that the carrier answered', async () => {
      const body = made(await external())
      const response = await asAdmin().post(ApiRoutes.carriers.test(body.id))
      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ healthy: true, reason: null })
      const after = await read(body.id)
      expect(after.lastHealthyAt).not.toBeNull()
      expect(after.lastError).toBeNull()
    })

    it('moves a connection whose credentials are refused to error, and back when new ones are accepted', async () => {
      const body = made(await external())
      const original = fake.plugin.healthCheck.bind(fake.plugin)
      try {
        fake.plugin.healthCheck = () => Promise.reject(new CarrierAuthError('expired token'))
        const failed = await asAdmin().post(ApiRoutes.carriers.test(body.id))
        expect(failed.body).toMatchObject({ healthy: false, reason: CarrierHealthReasons.AUTH })
        expect(JSON.stringify(failed.body)).not.toContain('expired')
        expect(await read(body.id)).toMatchObject({
          status: CarrierConnectionStatus.ERROR,
          lastError: CarrierHealthReasons.AUTH
        })
        // A carrier that cannot be reached tells nothing about the credentials: the state stays
        fake.plugin.healthCheck = () => Promise.reject(new CarrierUnavailableError('timeout'))
        const down = await asAdmin().post(ApiRoutes.carriers.test(body.id))
        expect(down.body).toMatchObject({
          healthy: false,
          reason: CarrierHealthReasons.UNAVAILABLE
        })
        expect((await read(body.id)).status).toBe(CarrierConnectionStatus.ERROR)
      } finally {
        fake.plugin.healthCheck = original
      }
      const fixed = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ credentials: { apiKey: `${FAKE_CARRIER_API_KEY}-new` } })
      expect(fixed.status).toBe(OK)
      expect(await read(body.id)).toMatchObject({
        status: CarrierConnectionStatus.ACTIVE,
        lastError: null
      })
    })

    it('says credentials that no longer open are unreadable, not wrong', async () => {
      const body = made(await external())
      await owner.carrierConnection.update({
        where: { id: body.id },
        data: { credentials: Buffer.from('not what the key sealed') }
      })
      const response = await asAdmin().post(ApiRoutes.carriers.test(body.id))
      expect(response.body).toMatchObject({
        healthy: false,
        reason: CarrierHealthReasons.CREDENTIALS_UNREADABLE
      })
    })
  })

  describe('editing a connection', () => {
    it('changes the settings and judges a change against what the connection already holds', async () => {
      const body = made(
        await local({
          defaultShippingFeeCents: 300,
          minShippingFeeCents: 100,
          maxShippingFeeCents: 500
        })
      )
      const ok = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({
          displayName: `${body.displayName} 2`,
          maxShippingFeeCents: 400,
          pickupEnabled: true,
          pickupDays: [2, 4],
          pickupCutoffTime: '15:30',
          labelFormat: 'pdf_a6',
          remittanceDeductsFee: true,
          maxDeliveryAttempts: 4
        })
      expect(ok.status).toBe(OK)
      expect(ok.body).toMatchObject({
        displayName: `${body.displayName} 2`,
        maxShippingFeeCents: 400,
        pickupDays: [2, 4],
        labelFormat: 'pdf_a6',
        remittanceDeductsFee: true,
        maxDeliveryAttempts: 4
      })
      // The maximum alone is under the default the row has: refused, and nothing changed
      const below = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ maxShippingFeeCents: 200 })
      expect(below.status).toBe(BAD_REQUEST)
      expect(codeOf(below.body)).toBe(ErrorCodes.VALIDATION_INVALID_INPUT)
      expect((await read(body.id)).maxShippingFeeCents).toBe(400)
      // The other way: clearing the days of a connection that takes pickups
      const noDays = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ pickupDays: [] })
      expect(noDays.status).toBe(BAD_REQUEST)
      // And a body that names the store, the status or a secret is not a body
      for (const over of [
        { storeId: ctx.storeB.id },
        { status: 'active' },
        { webhookSecret: 'x' }
      ]) {
        const response = await asAdmin().patch(ApiRoutes.carriers.byId(body.id)).send(over)
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('renames a service, switches one off, and keeps the default service one that is on', async () => {
      const body = made(await external())
      const renamed = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ services: [{ code: 'standard', label: 'Ground', active: false }] })
      expect(renamed.status).toBe(OK)
      expect((renamed.body as ConnectionBody).services).toEqual([
        { code: 'next_day', label: expect.any(String) as string, active: true },
        { code: 'standard', label: 'Ground', active: false }
      ])
      const off = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ services: [{ code: 'next_day', active: false }] })
      expect(off.status).toBe(BAD_REQUEST)
      expect(codeOf(off.body)).toBe(ErrorCodes.VALIDATION_INVALID_INPUT)
      const toOff = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ defaultServiceCode: 'standard' })
      expect(toOff.status).toBe(BAD_REQUEST)
      const unknown = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ services: [{ code: 'teleport', label: 'x' }] })
      expect(unknown.status).toBe(BAD_REQUEST)
      expect(
        (await owner.carrierService.findMany({ where: { connectionId: body.id } })).find(
          row => row.code === 'next_day'
        )?.active
      ).toBe(true)
    })

    it('changes the prefix and the contact of a courier while the numbering goes on', async () => {
      const body = made(await local({}, { prefix: 'JN' }))
      const prisma = app.get(PrismaService, { strict: false })
      const first = await prisma.transaction(tx => takeLocalGuideNumber(tx, ctx.storeA.id, body.id))
      expect(first).toBe('JN-000001')
      const response = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ credentials: { name: 'ignored', phone: '70002222', prefix: 'AB' } })
      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        guidePrefix: 'AB',
        contact: { phone: '70002222' },
        displayName: body.displayName
      })
      const second = await prisma.transaction(tx =>
        takeLocalGuideNumber(tx, ctx.storeA.id, body.id)
      )
      expect(second).toBe('AB-000002')
      const bad = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ credentials: { name: 'x', phone: '1', prefix: 'no good' } })
      expect(bad.status).toBe(BAD_REQUEST)
      expect((await read(body.id)).guidePrefix).toBe('AB')
    })

    it('refuses a name another connection has, and a change of a connection that does not exist', async () => {
      const one = made(await local())
      const two = made(await local())
      const clash = await asAdmin()
        .patch(ApiRoutes.carriers.byId(two.id))
        .send({ displayName: one.displayName })
      expect(clash.status).toBe(CONFLICT)
      expect(codeOf(clash.body)).toBe(ErrorCodes.RESOURCE_ALREADY_EXISTS)
      const missing = await asAdmin()
        .patch(ApiRoutes.carriers.byId('3f9c7d0e-5b0b-4d44-9d6c-0b1a2c3d4e5f'))
        .send({ displayName: 'x' })
      expect(missing.status).toBe(NOT_FOUND)
    })

    it('audits the names of the fields that changed and never their values', async () => {
      const body = made(await local())
      await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({
          credentials: { name: 'n', phone: '79998888', prefix: 'ZZ' },
          maxDeliveryAttempts: 5
        })
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.CARRIER_UPDATED,
        resourceId: body.id
      })
      expect(entry?.metadata).toEqual({ changed: ['credentials', 'maxDeliveryAttempts'] })
    })

    it('sets and clears the default of the store', async () => {
      const body = made(await local())
      const set = await asAdmin().patch(ApiRoutes.carriers.byId(body.id)).send({ isDefault: true })
      expect((set.body as ConnectionBody).isDefault).toBe(true)
      const clear = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ isDefault: false })
      expect((clear.body as ConnectionBody).isDefault).toBe(false)
      expect(
        (await owner.storeSettings.findUniqueOrThrow({ where: { storeId: ctx.storeA.id } }))
          .defaultCarrierConnectionId
      ).toBeNull()
    })
  })

  describe('listing', () => {
    it('pages the connections of the store in order of creation, and refuses a cursor that is not ours', async () => {
      const store = await owner.store.create({
        data: { organizationId: ctx.orgA.id, name: `${prefix}-pages`, slug: `${prefix}-pages` }
      })
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'pages',
        organizationId: ctx.orgA.id,
        storeId: store.id,
        permissions: [Permissions.SHIPPING_VIEW]
      })
      const ids: string[] = []
      for (let index = 0; index < 3; index += 1) {
        ids.push((await createCarrierConnection(owner, { storeId: store.id })).id)
      }
      const agent = api(app, viewer, { id: store.id })
      const one = await agent.get(`${ApiRoutes.carriers.list}?limit=2`)
      const page = one.body as {
        data: ConnectionBody[]
        nextCursor: string | null
        hasMore: boolean
      }
      expect(page.data.map(entry => entry.id)).toEqual(ids.slice(0, 2))
      expect(page.hasMore).toBe(true)
      const two = await agent.get(
        `${ApiRoutes.carriers.list}?limit=2&cursor=${page.nextCursor ?? ''}`
      )
      expect((two.body as { data: ConnectionBody[] }).data.map(entry => entry.id)).toEqual(
        ids.slice(2)
      )
      expect((await agent.get(`${ApiRoutes.carriers.list}?cursor=nope`)).status).toBe(BAD_REQUEST)
      expect((await agent.get(`${ApiRoutes.carriers.list}?limit=0`)).status).toBe(BAD_REQUEST)
    })
  })

  describe('disconnecting', () => {
    it('tells the carrier, deletes the credentials and the secret at once, and keeps the history', async () => {
      const body = made(await external({ isDefault: true }))
      const told = fake.callsTo('disconnect').length
      const response = await asAdmin().post(ApiRoutes.carriers.disconnect(body.id))
      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        status: CarrierConnectionStatus.DISABLED,
        hasCredentials: false,
        hasWebhookSecret: false,
        isDefault: false
      })
      expect(fake.callsTo('disconnect')).toHaveLength(told + 1)
      const row = await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.credentials).toBeNull()
      expect(row.webhookSecret).toBeNull()
      // What hangs from it stays
      expect(await owner.carrierService.count({ where: { connectionId: body.id } })).toBe(2)
      expect(
        await owner.carrierStatusMapping.count({ where: { connectionId: body.id } })
      ).toBeGreaterThan(0)
      expect(
        (await owner.storeSettings.findUniqueOrThrow({ where: { storeId: ctx.storeA.id } }))
          .defaultCarrierConnectionId
      ).toBeNull()
    })

    it('does it once: again changes nothing and adds no entry to the audit', async () => {
      const body = made(await local())
      await asAdmin().post(ApiRoutes.carriers.disconnect(body.id))
      const again = await asAdmin().post(ApiRoutes.carriers.disconnect(body.id))
      expect(again.status).toBe(OK)
      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.CARRIER_DISCONNECTED, resourceId: body.id },
        2
      )
      expect(entries).toHaveLength(1)
    })

    it('disconnects when the carrier does not answer, because the owner wants the credentials gone', async () => {
      const body = made(await external())
      const original = fake.plugin.disconnect.bind(fake.plugin)
      try {
        fake.plugin.disconnect = () => Promise.reject(new CarrierUnavailableError('down'))
        const response = await asAdmin().post(ApiRoutes.carriers.disconnect(body.id))
        expect(response.status).toBe(OK)
      } finally {
        fake.plugin.disconnect = original
      }
      expect(
        (await owner.carrierConnection.findUniqueOrThrow({ where: { id: body.id } })).credentials
      ).toBeNull()
    })

    it('leaves a disconnected connection as it is, but for its name, which the owner may change to free it', async () => {
      const body = made(await local())
      await asAdmin().post(ApiRoutes.carriers.disconnect(body.id))
      const edit = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ labelFormat: 'pdf_a6' })
      expect(edit.status).toBe(CONFLICT)
      expect(codeOf(edit.body)).toBe(ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE)
      const credentials = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ credentials: { name: 'x', phone: '1', prefix: 'ZZ' } })
      expect(credentials.status).toBe(CONFLICT)
      const test = await asAdmin().post(ApiRoutes.carriers.test(body.id))
      expect(test.status).toBe(CONFLICT)
      // Its name stays reserved until it is changed
      const same = await local({}, { name: body.displayName })
      expect(same.status).toBe(CONFLICT)
      const renamed = await asAdmin()
        .patch(ApiRoutes.carriers.byId(body.id))
        .send({ displayName: `${body.displayName} (old)` })
      expect(renamed.status).toBe(OK)
      expect(renamed.body).toMatchObject({ status: CarrierConnectionStatus.DISABLED })
      expect((await local({}, { name: body.displayName })).status).toBe(CREATED)
      // The numbering of a courier that was let go is kept: its guides are still on parcels
      expect(await owner.guideSequence.count({ where: { connectionId: body.id } })).toBe(1)
    })

    it('does not count a disconnected connection against the limit of the store', async () => {
      const live = await owner.carrierConnection.count({
        where: { storeId: ctx.storeA.id, status: { not: CarrierConnectionStatus.DISABLED } }
      })
      const body = made(await local())
      await asAdmin().post(ApiRoutes.carriers.disconnect(body.id))
      expect(
        await owner.carrierConnection.count({
          where: { storeId: ctx.storeA.id, status: { not: CarrierConnectionStatus.DISABLED } }
        })
      ).toBe(live)
    })
  })

  describe('uninstalling the shipping plugin', () => {
    it('warns of the shipments on their way and the pickups waiting, then disconnects every carrier', async () => {
      const store = await owner.store.create({
        data: {
          organizationId: ctx.orgA.id,
          name: `${prefix}-uninstall`,
          slug: `${prefix}-uninstall`
        }
      })
      const installation = await owner.pluginInstallation.create({
        data: {
          storeId: store.id,
          pluginId: ShippingPlugin.ID,
          scopes: [],
          status: 'active',
          installedBy: 'suite'
        }
      })
      const admin = await actorWithPermissions(owner, app, {
        prefix,
        name: 'uninstall',
        organizationId: ctx.orgA.id,
        storeId: store.id,
        permissions: [
          Permissions.SETTINGS_VIEW,
          Permissions.SETTINGS_MANAGE_PLUGINS,
          Permissions.SHIPPING_VIEW
        ]
      })
      const agent = api(app, admin, { id: store.id })
      const one = await createCarrierConnection(owner, { storeId: store.id })
      const two = await createCarrierConnection(owner, { storeId: store.id })
      const order = await createOrder(owner, { storeId: store.id })
      const delivered = await createOrder(owner, { storeId: store.id })
      const shipment = (orderId: string, status: ShipmentStatus, connectionId: string) =>
        owner.shipment.create({
          data: {
            storeId: store.id,
            orderId,
            connectionId,
            serviceCode: 'local',
            shippingPayer: ShippingPayer.SENDER,
            currency: 'USD',
            idempotencyKey: `${prefix}-${status}-${connectionId}`,
            createdBy: 'system',
            status
          }
        })
      await shipment(order.id, ShipmentStatus.IN_TRANSIT, one.id)
      await shipment(delivered.id, ShipmentStatus.DELIVERED, two.id)
      await owner.pickupRequest.create({
        data: {
          storeId: store.id,
          connectionId: one.id,
          pickupDate: new Date('2026-12-01'),
          requestedBy: 'system',
          status: PickupStatus.REQUESTED
        }
      })
      await owner.pickupRequest.create({
        data: {
          storeId: store.id,
          connectionId: two.id,
          pickupDate: new Date('2026-12-02'),
          requestedBy: 'system',
          status: PickupStatus.CANCELLED
        }
      })

      const catalog = (await agent.get(ApiRoutes.plugins.available)).body as (ConnectionBody & {
        activeConnections: number
      })[]
      expect(catalog.find(entry => entry.id === ShippingPlugin.ID)).toMatchObject({
        activeConnections: 2,
        openShipments: 1,
        openPickups: 1
      })
      expect((await agent.get(ApiRoutes.carriers.byId(one.id))).body).toMatchObject({
        openShipments: 1,
        openPickups: 1
      })

      const revoked = await agent.post(ApiRoutes.plugins.revoke(installation.id)).send({})
      expect(revoked.status).toBe(OK)
      expect(
        await owner.carrierConnection.count({
          where: { storeId: store.id, status: { not: CarrierConnectionStatus.DISABLED } }
        })
      ).toBe(0)
      // The shipments stay: they are the history of the business
      expect(await owner.shipment.count({ where: { storeId: store.id } })).toBe(2)
    })

    it('keeps another store connected when one uninstalls', async () => {
      const mine = made(await local())
      const revoked = await asAdminB().post(ApiRoutes.plugins.revoke(installationId)).send({})
      expect(revoked.status).toBe(NOT_FOUND)
      expect((await read(mine.id)).status).toBe(CarrierConnectionStatus.ACTIVE)
    })
  })
})

describe('The numbering of the guides of a local courier', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  it('gives every guide of twenty parallel creations a number of its own, in order of the sequence', async () => {
    const connection = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    const prisma = app.get(PrismaService, { strict: false })
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.transaction(tx => takeLocalGuideNumber(tx, ctx.storeA.id, connection.id))
      )
    )
    expect(new Set(numbers).size).toBe(20)
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `T-${String(index + 1).padStart(6, '0')}`)
    )
    expect(
      (await owner.guideSequence.findUniqueOrThrow({ where: { connectionId: connection.id } }))
        .nextValue
    ).toBe(21)
  })

  it('gives the number back when the transaction that took it fails', async () => {
    const connection = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    const prisma = app.get(PrismaService, { strict: false })
    await expect(
      prisma.transaction(async tx => {
        await takeLocalGuideNumber(tx, ctx.storeA.id, connection.id)
        throw new Error('the shipment could not be written')
      })
    ).rejects.toThrow('could not be written')
    expect(
      await prisma.transaction(tx => takeLocalGuideNumber(tx, ctx.storeA.id, connection.id))
    ).toBe('T-000001')
  })

  it('does not advance the sequence of a connection of another store, and fails loudly on one that has none', async () => {
    const mine = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
    const theirs = await createCarrierConnection(owner, { storeId: ctx.storeB.id })
    const prisma = app.get(PrismaService, { strict: false })
    // The row of another store is not found under the store of the request: the update names the store
    await expect(
      prisma.transaction(tx => takeLocalGuideNumber(tx, ctx.storeA.id, theirs.id))
    ).rejects.toMatchObject({ code: 'P2025' })
    expect(
      (await owner.guideSequence.findUniqueOrThrow({ where: { connectionId: theirs.id } }))
        .nextValue
    ).toBe(1)
    const courier = await createCarrierConnection(owner, {
      storeId: ctx.storeA.id,
      carrierId: CarrierId.FORZA
    })
    await expect(
      prisma.transaction(tx => takeLocalGuideNumber(tx, ctx.storeA.id, courier.id))
    ).rejects.toMatchObject({ code: 'P2025' })
    // And what it did not touch is as it was
    expect(
      (await owner.guideSequence.findUniqueOrThrow({ where: { connectionId: mine.id } })).nextValue
    ).toBe(1)
  })
})
