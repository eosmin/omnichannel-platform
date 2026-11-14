import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { CarrierId, ShippingPlugin } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { CarrierRegistry } from '@platform/plugins/runtime'
import { type ConnectField, ShipmentCreationModes } from '@platform/plugins/sdk'

import {
  buildFakeCarrier,
  FAKE_CARRIER_API_KEY,
  FakeCarrierBehaviors,
  type FakeCarrier
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
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
const UNAVAILABLE = 503

interface ErrorBody {
  error: { code: string }
}
interface ConnectionBody {
  id: string
  hasCredentials: boolean
}

const LOCATED_FIELDS: readonly ConnectField[] = [
  { key: 'username', labelKey: 'fields.username', secret: false, required: true, multiple: false },
  { key: 'password', labelKey: 'fields.password', secret: true, required: true, multiple: false },
  { key: 'site', labelKey: 'fields.site', secret: false, required: false, multiple: false }
]

// Step 4.15 (PR 2a): what a carrier declares for its connect form reaches the registry answer and is held to on connect and edit,
// and the places a carrier lists for the address of a guide are served from a cache of a day per connection and parent. A carrier
// that declares nothing keeps the free JSON.
describe('Settings → Carriers: connect fields and places', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  // A carrier that draws its own form and lists places: it borrows the id of the pickup-bound carrier
  let located: FakeCarrier
  let counter = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const registry = app.get(CarrierRegistry, { strict: false })
    registry.register(
      buildFakeCarrier({ id: CarrierId.FORZA, webhook: true, fetchStatus: true }).plugin
    )
    located = buildFakeCarrier({
      id: CarrierId.C807,
      mode: ShipmentCreationModes.PICKUP_BOUND,
      connectFields: LOCATED_FIELDS,
      locations: {
        '': [
          { id: '1', name: 'Ahuachapán' },
          { id: '2', name: 'San Salvador' },
          { id: '3', name: 'Santa Ana' }
        ],
        '2': [
          { id: '21', name: 'Soyapango', parentId: '2' },
          { id: '22', name: 'Mejicanos', parentId: '2' }
        ]
      }
    })
    registry.register(located.plugin)
    const installed = await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: ShippingPlugin.ID })
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
  const name = () => `${prefix}-carrier-${(counter += 1)}`
  const external = (over: Record<string, unknown> = {}) =>
    asAdmin()
      .post(ApiRoutes.carriers.create)
      .send({
        carrierId: CarrierId.FORZA,
        credentials: { apiKey: FAKE_CARRIER_API_KEY },
        displayName: name(),
        ...over
      })
  const made = (response: { status: number; body: unknown }): ConnectionBody => {
    expect(response.status).toBe(CREATED)
    return response.body as ConnectionBody
  }

  describe('the registry', () => {
    it('hands the connect fields of a carrier that declares them as the registry copied them, and none for one that does not', async () => {
      const response = await asAdmin().get(ApiRoutes.carriers.registry)
      const entries = response.body as { id: string; connectFields: Record<string, unknown>[] }[]
      expect(entries.find(entry => entry.id === CarrierId.C807)?.connectFields).toEqual(
        LOCATED_FIELDS.map(field => ({
          key: field.key,
          labelKey: field.labelKey,
          label: null,
          helpKey: null,
          secret: field.secret,
          required: field.required,
          multiple: field.multiple
        }))
      )
      expect(entries.find(entry => entry.id === CarrierId.LOCAL)?.connectFields).toEqual([])
      expect(entries.find(entry => entry.id === CarrierId.FORZA)?.connectFields).toEqual([])
    })

    it('does not follow a field the plugin changes after it registered', async () => {
      const registry = app.get(CarrierRegistry, { strict: false })
      const live = registry.find(CarrierId.C807)?.connectFields as ConnectField[]
      const first = LOCATED_FIELDS[0]
      if (first === undefined) throw new Error('the suite declares no field')
      const before = JSON.stringify(registry.connectFieldsOf(CarrierId.C807))
      live[0] = { ...first, key: 'tampered' }
      try {
        const response = await asAdmin().get(ApiRoutes.carriers.registry)
        const entry = (response.body as { id: string; connectFields: { key: string }[] }[]).find(
          candidate => candidate.id === CarrierId.C807
        )
        expect(JSON.stringify(entry?.connectFields.map(field => field.key))).not.toContain(
          'tampered'
        )
        expect(JSON.stringify(registry.connectFieldsOf(CarrierId.C807))).toBe(before)
      } finally {
        live[0] = first
      }
    })
  })

  describe('a carrier that declares its connect fields', () => {
    const account = (over: Record<string, unknown> = {}) =>
      asAdmin()
        .post(ApiRoutes.carriers.create)
        .send({
          carrierId: CarrierId.C807,
          credentials: { username: 'ops', password: 'hunter2-secret', ...over },
          displayName: name()
        })

    it('connects with its fields and keeps them sealed, optional ones left out or blank', async () => {
      const body = made(await account({ site: '' }))
      expect(body.hasCredentials).toBe(true)
      expect(JSON.stringify(body)).not.toContain('hunter2-secret')
      expect(located.callsTo('connect').length).toBeGreaterThan(0)
    })

    it('refuses a missing required field or a key it does not ask for, before the carrier is asked, without echoing a secret', async () => {
      const asked = located.callsTo('connect').length
      for (const credentials of [
        { username: 'ops' },
        { username: '  ', password: 'hunter2-secret' },
        { username: 'ops', password: 'hunter2-secret', extra: 'x' },
        { username: { a: 1 }, password: 'hunter2-secret' },
        { username: 'ops', password: ['a'] }
      ]) {
        const response = await asAdmin()
          .post(ApiRoutes.carriers.create)
          .send({ carrierId: CarrierId.C807, credentials, displayName: name() })
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_INVALID_INPUT)
        expect(JSON.stringify(response.body)).not.toContain('hunter2-secret')
      }
      expect(located.callsTo('connect')).toHaveLength(asked)
    })

    it('holds a replacement of the credentials to the same fields, and leaves the connection as it was', async () => {
      const connection = made(await account())
      const asked = located.callsTo('connect').length
      const refused = await asAdmin()
        .patch(ApiRoutes.carriers.byId(connection.id))
        .send({ credentials: { username: 'ops' } })
      expect(refused.status).toBe(BAD_REQUEST)
      expect(located.callsTo('connect')).toHaveLength(asked)
      const accepted = await asAdmin()
        .patch(ApiRoutes.carriers.byId(connection.id))
        .send({ credentials: { username: 'ops2', password: 'new-secret' } })
      expect(accepted.status).toBe(OK)
    })

    it('leaves the free JSON valid for a carrier that declares nothing', async () => {
      const body = made(await external({ credentials: { apiKey: FAKE_CARRIER_API_KEY, any: [1] } }))
      expect(body.hasCredentials).toBe(true)
    })
  })

  describe('the places of a carrier', () => {
    const connect = async (): Promise<string> =>
      made(
        await asAdmin()
          .post(ApiRoutes.carriers.create)
          .send({
            carrierId: CarrierId.C807,
            credentials: { username: 'ops', password: 'pw-for-places' },
            displayName: name()
          })
      ).id
    const places = (id: string, query = '') =>
      asAdmin().get(`${ApiRoutes.carriers.locations(id)}${query}`)
    type Place = { id: string; name: string; parentId: string | null }

    it('lists the top level and the places under a parent, with the parent on each', async () => {
      const id = await connect()
      const top = await places(id)
      expect(top.status).toBe(OK)
      expect((top.body as Place[]).map(place => place.name)).toEqual([
        'Ahuachapán',
        'San Salvador',
        'Santa Ana'
      ])
      const under = await places(id, '?parentId=2')
      expect(under.body).toEqual([
        { id: '21', name: 'Soyapango', parentId: '2' },
        { id: '22', name: 'Mejicanos', parentId: '2' }
      ])
    })

    it('asks the carrier once a day per connection and parent, and searches over what it kept', async () => {
      const id = await connect()
      const before = located.callsTo('lookupLocations').length
      await places(id)
      await places(id)
      const found = await places(id, '?search=SAN')
      expect((found.body as Place[]).map(place => place.name)).toEqual([
        'San Salvador',
        'Santa Ana'
      ])
      expect((await places(id, '?search=ahuachapan')).body).toHaveLength(1)
      expect(located.callsTo('lookupLocations')).toHaveLength(before + 1)
      await places(id, '?parentId=2')
      expect(located.callsTo('lookupLocations')).toHaveLength(before + 2)
      // Never the search to the carrier
      expect(
        located
          .callsTo('lookupLocations')
          .slice(before)
          .map(call => JSON.stringify(call.args))
      ).toEqual(['{}', '{"parentId":"2"}'])
      // Another connection has its own list
      const other = await connect()
      await places(other)
      expect(located.callsTo('lookupLocations')).toHaveLength(before + 3)
    })

    it('drops what it kept when the connection is edited, even only its name', async () => {
      const id = await connect()
      await places(id)
      const before = located.callsTo('lookupLocations').length
      const edit = await asAdmin().patch(ApiRoutes.carriers.byId(id)).send({ displayName: name() })
      expect(edit.status).toBe(OK)
      await places(id)
      expect(located.callsTo('lookupLocations')).toHaveLength(before + 1)
    })

    it('does not keep a failure, and tells an unreachable carrier as a 503 with none of its words', async () => {
      const id = await connect()
      located.state.lookup = FakeCarrierBehaviors.TIMEOUT_BEFORE
      try {
        const down = await places(id)
        expect(down.status).toBe(UNAVAILABLE)
        expect(codeOf(down.body)).toBe(ErrorCodes.SHIPPING_CARRIER_UNAVAILABLE)
        expect(JSON.stringify(down.body)).not.toContain('fake carrier')
      } finally {
        located.state.lookup = FakeCarrierBehaviors.OK
      }
      expect((await places(id)).status).toBe(OK)
    })

    it('refuses a carrier that lists no places, a connection that was let go and a parent id that is not one', async () => {
      const forza = made(await external())
      const none = await places(forza.id)
      expect(none.status).toBe(CONFLICT)
      expect(codeOf(none.body)).toBe(ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING)
      const id = await connect()
      for (const query of ['?parentId=', '?parentId=a%20b', '?parentId=a:b', '?extra=1']) {
        expect((await places(id, query)).status).toBe(BAD_REQUEST)
      }
      expect((await asAdmin().post(ApiRoutes.carriers.disconnect(id))).status).toBe(OK)
      const gone = await places(id)
      expect(gone.status).toBe(CONFLICT)
      expect(codeOf(gone.body)).toBe(ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE)
    })

    it('needs shipping:view, and keeps the connection of one store out of another', async () => {
      const id = await connect()
      const manager = await actorWithPermissions(owner, app, {
        prefix,
        name: 'places-manager',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SETTINGS_MANAGE_CARRIERS]
      })
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'places-viewer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW]
      })
      const url = ApiRoutes.carriers.locations(id)
      expect((await api(app, manager, ctx.storeA).get(url)).status).toBe(FORBIDDEN)
      expect((await api(app, viewer, ctx.storeA).get(url)).status).toBe(OK)
      const calls = located.callsTo('lookupLocations').length
      const other = await asAdminB().get(url)
      expect(other.status).toBe(NOT_FOUND)
      expect(located.callsTo('lookupLocations')).toHaveLength(calls)
    })
  })
})
