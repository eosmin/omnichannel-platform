import { createHash, randomInt } from 'node:crypto'

import { Controller, Get, Post } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginInstallLimits,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { REDIS_CLIENT } from '@platform/core/redis'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../../apps/api/src/modules/plugins/plugin-api.decorators'
import { PluginChallengeService } from '../../apps/api/src/modules/plugins/plugin-challenge.service'
import { CurrentStore, RequirePermissions } from '../../apps/api/src/modules/tenancy'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const PRECONDITION_FAILED = 412
const TOO_MANY_REQUESTS = 429
const PROBE = '/plugin-api/probe'

// The first consumers of the plugin API are the PRs that expose routes (Step 5.6, E*), so this suite brings its own: real
// `@PluginApi` routes over real tenant data, which are what the guard has to protect. They read only what `@CurrentStore()`
// gives them, as a service does.
@Controller()
class PluginProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(`${PROBE}/tags`)
  tags(@CurrentStore() store: { id: string }): Promise<{ id: string; name: string }[]> {
    return this.prisma.client.tag.findMany({
      where: { storeId: store.id },
      select: { id: true, name: true }
    })
  }

  @PluginApi(PluginScopes.ORDERS_WRITE)
  @RequirePermissions(Permissions.ORDERS_CHANGE_STATUS)
  @Post(`${PROBE}/write`)
  write(): { done: true } {
    return { done: true }
  }

  // Asks of a person more than its scope grants: the guard must refuse it, whatever the controller wanted
  @PluginApi(PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW, Permissions.ORDERS_CANCEL)
  @Get(`${PROBE}/escalated`)
  escalated(): { done: true } {
    return { done: true }
  }

  // Forgot to list its scopes: not even the marker, so the guard is not there and the global ones refuse it
  @Get(`${PROBE}/unmarked`)
  unmarked(): string {
    return 'open'
  }
}

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface SetupOffer {
  installationId: string
  code: string
  expiresAt: string
  settingsUrl: string | null
}
interface InstallBody {
  id: string
  installed: boolean
  installationId: string | null
  setup: SetupOffer | null
}
interface SetupResult {
  apiKey: string
  installationId: string
  pluginId: string
  storeId: string
  scopes: string[]
  rateLimitPerMinute: number
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

// TDD_10 §6.3 and §6.4, Step 5.6 PR P2: the consent, the install challenge, the setup code, the key and the guard that takes it
describe('Installing an integration plugin and calling the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let redis: Redis
  let counter = 0
  const challenge = { run: jest.fn<Promise<void>, [string, string]>() }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([PluginProbeController], builder =>
      // The challenge goes to a public address: the suite has none, so it answers for the endpoint (the exchange itself is
      // covered by its own unit spec)
      builder.overrideProvider(PluginChallengeService).useValue(challenge)
    )
    redis = app.get<Redis>(REDIS_CLIENT)
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    challenge.run.mockReset()
    challenge.run.mockResolvedValue(undefined)
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminSibling = () => api(app, ctx.adminA2, ctx.storeA2)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const newId = () => {
    counter += 1
    return `${prefix}-p${counter}`
  }
  const manifestOf = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    version: '1.0.0',
    name: `Plugin ${id}`,
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
    ui: { settings: 'https://acme.com/plugin/settings' },
    ...over
  })
  const register = async (id = newId(), over: Record<string, unknown> = {}) => {
    await asAdmin().post(ApiRoutes.plugins.register).send(manifestOf(id, over)).expect(CREATED)
    return id
  }
  const install = (pluginId: string, scopes: string[] | undefined, agent = asAdmin) =>
    agent().post(ApiRoutes.plugins.install).send({ pluginId, scopes })
  const exchange = (code: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      .post(`${API_PREFIX}${PluginApiRoutes.setupExchange}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .send({ code })
  }
  const call = (path: string, key?: string, method: 'get' | 'post' = 'get') => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    const request = supertest(server)
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }
  // The whole flow for a store: register (or use) a plugin, install it with the scopes it asks for and trade the code
  const setUp = async (
    over: Record<string, unknown> = {},
    agent = asAdmin
  ): Promise<{ id: string; key: string; setup: SetupResult; offer: SetupOffer }> => {
    const id = await register(newId(), over)
    return setUpExisting(id, agent)
  }
  const setUpExisting = async (id: string, agent = asAdmin) => {
    const consent = (await agent().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
      scopes: string[]
    }
    const installed = await install(id, consent.scopes, agent).expect(CREATED)
    const offer = (installed.body as InstallBody).setup as SetupOffer
    const setup = (await exchange(offer.code).expect(OK)).body as SetupResult
    return { id, key: setup.apiKey, setup, offer }
  }

  describe('the consent screen', () => {
    it('shows what installing would grant, in the words of the manifest', async () => {
      const id = await register(newId(), {
        scopes: [PluginScopes.ORDERS_READ, PluginScopes.MESSAGES_READ],
        limits: { maxRequestsPerMinute: 120 },
        legal: {
          privacyPolicy: 'https://acme.com/privacy',
          termsOfService: 'https://acme.com/terms'
        }
      })

      const response = await asAdmin().get(ApiRoutes.plugins.consent(id)).expect(OK)

      expect(response.body).toMatchObject({
        plugin: { id, authorName: 'Acme Inc', version: '1.0.0' },
        scopes: ['messages:read', 'orders:read'],
        grantedScopes: [],
        newScopes: ['messages:read', 'orders:read'],
        rateLimitPerMinute: 120,
        webhooks: { endpoint: 'https://hooks.acme.com/platform' },
        legal: { privacyPolicy: 'https://acme.com/privacy' },
        settingsUrl: 'https://acme.com/plugin/settings',
        installation: null
      })
    })

    it('needs the permission to manage plugins', async () => {
      const id = await register()

      await asAgent().get(ApiRoutes.plugins.consent(id)).expect(FORBIDDEN)
    })

    it('does not exist for another organization, nor for an id that is no plugin', async () => {
      const id = await register()

      const other = await asAdminB().get(ApiRoutes.plugins.consent(id))
      const missing = await asAdmin().get(ApiRoutes.plugins.consent(`${prefix}-nothing`))

      expect(other.status).toBe(NOT_FOUND)
      expect(missing.status).toBe(NOT_FOUND)
    })
  })

  describe('installing', () => {
    it('refuses scopes that are not the ones the manifest asks for, and writes nothing', async () => {
      const id = await register(newId(), { scopes: [PluginScopes.ORDERS_READ] })

      const more = await install(id, [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE])
      const fewer = await install(id, [])

      expect(more.status).toBe(CONFLICT)
      expect(codeOf(more.body)).toBe(ErrorCodes.PLUGIN_CONSENT_MISMATCH)
      expect(fewer.status).toBe(CONFLICT)
      expect(challenge.run).not.toHaveBeenCalled()
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })

    it('needs the scopes of the consent, and only ones that exist', async () => {
      const id = await register()

      const missing = await install(id, undefined)

      expect(missing.status).toBe(BAD_REQUEST)
      const unknown = await install(id, ['orders:everything'])
      expect(unknown.status).toBe(BAD_REQUEST)
      const repeated = await install(id, [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_READ])
      expect(repeated.status).toBe(BAD_REQUEST)
    })

    it('asks the endpoint for the challenge, then waits for the plugin in PENDING_SETUP with no key', async () => {
      const id = await register()

      const response = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)

      expect(challenge.run).toHaveBeenCalledWith(id, 'https://hooks.acme.com/platform')
      const body = response.body as InstallBody
      expect(response.headers['cache-control']).toContain('no-store')
      expect(body.installed).toBe(false)
      expect(body.setup?.code).toHaveLength(43)
      expect(body.setup?.settingsUrl).toBe('https://acme.com/plugin/settings')
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: body.installationId as string }
      })
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        status: PluginInstallationStatus.PENDING_SETUP,
        scopes: [PluginScopes.ORDERS_READ],
        webhookEndpoint: 'https://hooks.acme.com/platform',
        apiKeyHash: null,
        apiKeyPrefix: null,
        rateLimitPerMinute: PluginInstallLimits.DEFAULT_REQUESTS_PER_MINUTE
      })
      // The code is not stored anywhere in the clear: Redis holds it under its hash
      expect(
        await redis.get(CacheKeys.plugin.setupCode(sha256(body.setup?.code ?? '')))
      ).not.toBeNull()
      expect(await redis.get(CacheKeys.plugin.setupCode(body.setup?.code ?? ''))).toBeNull()
      expect(JSON.stringify(row)).not.toContain(body.setup?.code ?? 'x')
    })

    it('writes nothing when the endpoint does not pass the challenge', async () => {
      const id = await register()
      challenge.run.mockRejectedValue(
        new PlatformException(
          ErrorCodes.PLUGIN_CHALLENGE_FAILED,
          'the endpoint did not answer',
          HttpStatusCodes.PRECONDITION_FAILED
        )
      )

      const response = await install(id, [PluginScopes.ORDERS_READ])

      expect(response.status).toBe(PRECONDITION_FAILED)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_CHALLENGE_FAILED)
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })

    it('installs a plugin with no webhooks without a challenge', async () => {
      const id = await register(newId(), { webhooks: undefined })

      await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)

      expect(challenge.run).not.toHaveBeenCalled()
      const row = await owner.pluginInstallation.findFirstOrThrow({ where: { pluginId: id } })
      expect(row.webhookEndpoint).toBeNull()
    })

    it('takes the rate limit of the manifest', async () => {
      const { setup } = await setUp({ limits: { maxRequestsPerMinute: 7 } })

      expect(setup.rateLimitPerMinute).toBe(7)
    })

    it('needs the permission to manage plugins', async () => {
      const id = await register()

      await install(id, [PluginScopes.ORDERS_READ], asAgent).expect(FORBIDDEN)
    })

    it('does not install a plugin of another organization', async () => {
      const id = await register()

      const response = await install(id, [PluginScopes.ORDERS_READ], asAdminB)

      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.pluginInstallation.count({ where: { pluginId: id } })).toBe(0)
    })

    it('does not install a suspended plugin', async () => {
      const id = await register()
      await owner.plugin.update({ where: { id }, data: { status: PluginStatus.SUSPENDED } })

      await install(id, [PluginScopes.ORDERS_READ]).expect(NOT_FOUND)
    })

    it('audits the install without the code', async () => {
      const id = await register()

      const response = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)

      const installationId = (response.body as InstallBody).installationId as string
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.PLUGIN_INSTALLED,
        resourceId: installationId
      })
      expect(entry?.metadata).toMatchObject({ pluginId: id, scopes: [PluginScopes.ORDERS_READ] })
      expect(JSON.stringify(entry)).not.toContain((response.body as InstallBody).setup?.code ?? 'x')
    })

    it('answers that an installation that is active already holds the plugin', async () => {
      const { id } = await setUp()

      const again = await install(id, [PluginScopes.ORDERS_READ])

      expect(again.status).toBe(CONFLICT)
      expect(codeOf(again.body)).toBe(ErrorCodes.PLUGIN_ALREADY_INSTALLED)
    })
  })

  describe('the setup code', () => {
    it('is traded for the key once, and the installation becomes active with only the prefix and the hash of the key', async () => {
      const id = await register()
      const installed = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const offer = (installed.body as InstallBody).setup as SetupOffer

      const response = await exchange(offer.code).expect(OK)

      const result = response.body as SetupResult
      expect(result.apiKey.startsWith(PLUGIN_API_KEY_TOKEN_PREFIX)).toBe(true)
      expect(result).toMatchObject({
        installationId: offer.installationId,
        pluginId: id,
        storeId: ctx.storeA.id,
        scopes: [PluginScopes.ORDERS_READ]
      })
      expect(response.headers['cache-control']).toContain('no-store')
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: offer.installationId }
      })
      expect(row.status).toBe(PluginInstallationStatus.ACTIVE)
      expect(row.apiKeyHash).toBe(sha256(result.apiKey))
      expect(row.apiKeyPrefix).toBe(
        result.apiKey.slice(0, PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH)
      )
      // Nothing in the row, or in the audit trail, is the key
      expect(JSON.stringify(row)).not.toContain(result.apiKey)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.PLUGIN_SETUP_COMPLETED,
        resourceId: offer.installationId
      })
      expect(JSON.stringify(entries)).not.toContain(result.apiKey)
    })

    it('works once: the second exchange, even at the same moment, gets nothing', async () => {
      const id = await register()
      const installed = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const { code } = (installed.body as InstallBody).setup as SetupOffer

      const [first, second] = await Promise.all([exchange(code), exchange(code)])
      const statuses = [first.status, second.status].sort()

      expect(statuses).toEqual([OK, UNAUTHORIZED])
      const later = await exchange(code)
      expect(later.status).toBe(UNAUTHORIZED)
      expect(codeOf(later.body)).toBe(ErrorCodes.PLUGIN_SETUP_CODE_INVALID)
    })

    it('answers the same for a code that is unknown, expired or not a code at all', async () => {
      const id = await register()
      const installed = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const { code } = (installed.body as InstallBody).setup as SetupOffer
      await redis.del(CacheKeys.plugin.setupCode(sha256(code)))

      const expired = await exchange(code)
      const unknown = await exchange('A'.repeat(43))
      const malformed = await exchange('short')

      expect([expired.status, unknown.status]).toEqual([UNAUTHORIZED, UNAUTHORIZED])
      expect(codeOf(expired.body)).toBe(codeOf(unknown.body))
      expect(malformed.status).toBe(BAD_REQUEST)
    })

    it('lives five minutes in Redis', async () => {
      const id = await register()
      const installed = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const { code } = (installed.body as InstallBody).setup as SetupOffer

      const ttl = await redis.ttl(CacheKeys.plugin.setupCode(sha256(code)))

      expect(ttl).toBeGreaterThan(PluginInstallLimits.SETUP_CODE_TTL_SECONDS - 10)
      expect(ttl).toBeLessThanOrEqual(PluginInstallLimits.SETUP_CODE_TTL_SECONDS)
    })

    it('stops working when the installation is revoked first', async () => {
      const id = await register()
      const installed = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const body = installed.body as InstallBody
      await asAdmin()
        .post(ApiRoutes.plugins.revoke(body.installationId as string))
        .expect(OK)

      const response = await exchange((body.setup as SetupOffer).code)

      expect(response.status).toBe(UNAUTHORIZED)
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: body.installationId as string }
      })
      expect(row.apiKeyHash).toBeNull()
    })

    it('is replaced by a new one that the owner asks for, and the old one stops working', async () => {
      const id = await register()
      const installed = await install(id, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const first = (installed.body as InstallBody).setup as SetupOffer

      const again = await asAdmin()
        .post(ApiRoutes.plugins.setupCode(first.installationId))
        .expect(OK)
      const second = again.body as SetupOffer

      expect(second.code).not.toBe(first.code)
      expect((await exchange(first.code)).status).toBe(UNAUTHORIZED)
      expect((await exchange(second.code)).status).toBe(OK)
    })

    it('is not issued again for an installation that is set up, nor for another store, nor to an agent', async () => {
      const { offer } = await setUp()
      const pendingId = await register()
      const pending = await install(pendingId, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const pendingInstallation = (pending.body as InstallBody).installationId as string

      const done = await asAdmin().post(ApiRoutes.plugins.setupCode(offer.installationId))
      const foreign = await asAdminB().post(ApiRoutes.plugins.setupCode(pendingInstallation))
      const sibling = await asAdminSibling().post(ApiRoutes.plugins.setupCode(pendingInstallation))
      const agent = await asAgent().post(ApiRoutes.plugins.setupCode(pendingInstallation))

      expect(done.status).toBe(CONFLICT)
      expect(foreign.status).toBe(NOT_FOUND)
      expect(sibling.status).toBe(NOT_FOUND)
      expect(agent.status).toBe(FORBIDDEN)
    })

    it('installs again after a revocation with a new key and not the old one', async () => {
      const first = await setUp()
      const installationId = first.setup.installationId
      await asAdmin().post(ApiRoutes.plugins.revoke(installationId)).expect(OK)
      expect((await call(`${PROBE}/tags`, first.key)).status).toBe(UNAUTHORIZED)

      const reinstalled = await install(first.id, [PluginScopes.ORDERS_READ]).expect(CREATED)
      const offer = (reinstalled.body as InstallBody).setup as SetupOffer
      // Not usable while it waits for the plugin
      expect((await call(`${PROBE}/tags`, first.key)).status).toBe(UNAUTHORIZED)
      const result = (await exchange(offer.code).expect(OK)).body as SetupResult

      expect(result.installationId).toBe(installationId)
      expect(result.apiKey).not.toBe(first.key)
      expect((await call(`${PROBE}/tags`, first.key)).status).toBe(UNAUTHORIZED)
      expect((await call(`${PROBE}/tags`, result.apiKey)).status).toBe(OK)
    })
  })

  describe('the key and the guard', () => {
    it('is refused when it is missing, is not a plugin key, is unknown or is not set up', async () => {
      const pendingId = await register()
      await install(pendingId, [PluginScopes.ORDERS_READ]).expect(CREATED)

      const none = await call(`${PROBE}/tags`)
      const tenantKey = await call(`${PROBE}/tags`, 'pk_live_abcdefghijklmnop')
      const unknown = await call(`${PROBE}/tags`, `${PLUGIN_API_KEY_TOKEN_PREFIX}${'a'.repeat(43)}`)
      const session = await call(`${PROBE}/tags`, ctx.adminA.token)

      for (const response of [none, tenantKey, unknown, session]) {
        expect(response.status).toBe(UNAUTHORIZED)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_API_KEY_INVALID)
      }
    })

    it('tells who it is, with no scope needed', async () => {
      const { key, setup } = await setUp()

      const response = await call(PluginApiRoutes.installation, key).expect(OK)

      expect(response.body).toEqual({
        installationId: setup.installationId,
        pluginId: setup.pluginId,
        storeId: ctx.storeA.id,
        scopes: [PluginScopes.ORDERS_READ]
      })
    })

    it('is not accepted on the routes of the interface, and a person is not accepted on the plugin routes', async () => {
      const { key } = await setUp()

      const catalog = await supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
        .get(`${API_PREFIX}${ApiRoutes.plugins.available}`)
        .set('authorization', `Bearer ${key}`)
        .set('x-store-id', ctx.storeA.id)

      expect(catalog.status).toBe(UNAUTHORIZED)
    })

    it('leaves a route that carries no @PluginApi closed to a valid key', async () => {
      const { key } = await setUp()

      const response = await call(`${PROBE}/unmarked`, key)

      expect(response.status).toBeGreaterThanOrEqual(UNAUTHORIZED)
    })

    it('reads the store of its own installation and no other, whatever the call says (key of store A, store B)', async () => {
      const tagA = await owner.tag.create({
        data: { storeId: ctx.storeA.id, name: `${prefix}-a`, color: '#111111' }
      })
      const tagA2 = await owner.tag.create({
        data: { storeId: ctx.storeA2.id, name: `${prefix}-a2`, color: '#222222' }
      })
      const tagB = await owner.tag.create({
        data: { storeId: ctx.storeB.id, name: `${prefix}-b`, color: '#333333' }
      })
      const { key } = await setUp()

      const plain = await call(`${PROBE}/tags`, key).expect(OK)
      const withHeader = await call(`${PROBE}/tags`, key)
        .set('x-store-id', ctx.storeB.id)
        .expect(OK)
      const withQuery = await call(`${PROBE}/tags?storeId=${ctx.storeB.id}`, key).expect(OK)
      const ids = (body: unknown) => (body as { id: string }[]).map(tag => tag.id)

      for (const response of [plain, withHeader, withQuery]) {
        expect(ids(response.body)).toContain(tagA.id)
        expect(ids(response.body)).not.toContain(tagB.id)
        // Same organization, another store: the installation is one store's
        expect(ids(response.body)).not.toContain(tagA2.id)
      }
    })

    it('is bound to the store it was installed in even when the same plugin is installed in its sibling store', async () => {
      const tagA = await owner.tag.create({
        data: { storeId: ctx.storeA.id, name: `${prefix}-sa`, color: '#444444' }
      })
      const tagA2 = await owner.tag.create({
        data: { storeId: ctx.storeA2.id, name: `${prefix}-sa2`, color: '#555555' }
      })
      const id = await register()
      const inA = await setUpExisting(id, asAdmin)
      const inA2 = await setUpExisting(id, asAdminSibling)

      const fromA = await call(`${PROBE}/tags`, inA.key).expect(OK)
      const fromA2 = await call(`${PROBE}/tags`, inA2.key).expect(OK)
      const ids = (body: unknown) => (body as { id: string }[]).map(tag => tag.id)

      expect(inA.key).not.toBe(inA2.key)
      expect(ids(fromA.body)).toContain(tagA.id)
      expect(ids(fromA.body)).not.toContain(tagA2.id)
      expect(ids(fromA2.body)).toContain(tagA2.id)
      expect(ids(fromA2.body)).not.toContain(tagA.id)
    })

    it('denies a scope it was not granted (403), and one that only read cannot write', async () => {
      const { key } = await setUp({ scopes: [PluginScopes.ORDERS_READ] })
      const writer = await setUp({ scopes: [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE] })

      const denied = await call(`${PROBE}/write`, key, 'post')
      const allowed = await call(`${PROBE}/write`, writer.key, 'post')

      expect(denied.status).toBe(FORBIDDEN)
      expect(codeOf(denied.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      expect((denied.body as ErrorBody).error.metadata).toMatchObject({
        required: [PluginScopes.ORDERS_WRITE]
      })
      expect(allowed.status).toBe(201)
    })

    it('cannot be escalated by a controller that asks a person for more than the scopes grant', async () => {
      const { key } = await setUp({ scopes: [PluginScopes.ORDERS_READ] })

      const response = await call(`${PROBE}/escalated`, key)

      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
    })

    it('takes a scope that was added to the row only if the platform declares it', async () => {
      const { key, setup } = await setUp({ scopes: [PluginScopes.ORDERS_READ] })
      await owner.pluginInstallation.update({
        where: { id: setup.installationId },
        data: { scopes: [PluginScopes.ORDERS_READ, 'orders:everything'] }
      })

      const response = await call(PluginApiRoutes.installation, key).expect(OK)

      expect((response.body as { scopes: string[] }).scopes).toEqual([PluginScopes.ORDERS_READ])
    })

    it('stops working at the next call when the installation is revoked, disabled or its plugin suspended', async () => {
      const revoked = await setUp()
      const disabled = await setUp()
      const suspended = await setUp()
      await call(`${PROBE}/tags`, revoked.key).expect(OK)

      await asAdmin().post(ApiRoutes.plugins.revoke(revoked.setup.installationId)).expect(OK)
      await owner.pluginInstallation.update({
        where: { id: disabled.setup.installationId },
        data: { status: PluginInstallationStatus.DISABLED }
      })
      await owner.plugin.update({
        where: { id: suspended.id },
        data: { status: PluginStatus.SUSPENDED }
      })

      for (const { key } of [revoked, disabled, suspended]) {
        const response = await call(`${PROBE}/tags`, key)
        expect(response.status).toBe(UNAUTHORIZED)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_API_KEY_INVALID)
      }
    })

    it('is limited per installation: past its limit it gets 429 with the time to wait, and another one is not affected', async () => {
      const limited = await setUp({ limits: { maxRequestsPerMinute: 2 } })
      const other = await setUp({ limits: { maxRequestsPerMinute: 2 } })

      await call(`${PROBE}/tags`, limited.key).expect(OK)
      await call(`${PROBE}/tags`, limited.key).expect(OK)
      const over = await call(`${PROBE}/tags`, limited.key)

      expect(over.status).toBe(TOO_MANY_REQUESTS)
      expect(codeOf(over.body)).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
      expect((await call(`${PROBE}/tags`, other.key)).status).toBe(OK)
    })

    it('is not shown again after the setup: not by the catalog, the consent, a new code, nor in the logs', async () => {
      const lines: string[] = []
      const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map(level =>
        jest.spyOn(PinoLogger.prototype, level).mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args))
        })
      )
      try {
        const { id, key, setup, offer } = await setUp()
        await call(`${PROBE}/tags`, key).expect(OK)
        await call(`${PROBE}/tags`, `${PLUGIN_API_KEY_TOKEN_PREFIX}wrong`)

        const seen = [
          (await asAdmin().get(ApiRoutes.plugins.available).expect(OK)).text,
          (await asAdmin().get(ApiRoutes.plugins.consent(id)).expect(OK)).text,
          (await asAdmin().post(ApiRoutes.plugins.setupCode(setup.installationId))).text,
          (await call(PluginApiRoutes.installation, key).expect(OK)).text,
          (await exchange(offer.code)).text
        ]

        for (const text of seen) expect(text).not.toContain(key)
        expect(lines.join('\n')).not.toContain(key)
        expect(lines.join('\n')).not.toContain(offer.code)
        expect(
          await waitForAuditEntries(owner, {
            action: AuditAction.PLUGIN_SETUP_COMPLETED,
            resourceId: setup.installationId
          })
        ).toHaveLength(1)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })
  })

  describe('a newer manifest', () => {
    it('keeps the old scopes until the owner approves the new ones in a new consent screen', async () => {
      const first = await setUp({ scopes: [PluginScopes.ORDERS_READ] })
      await asAdmin()
        .post(ApiRoutes.plugins.register)
        .send(
          manifestOf(first.id, {
            version: '1.1.0',
            scopes: [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE]
          })
        )
        .expect(OK)

      // Nothing was granted by the registration
      const held = await call(PluginApiRoutes.installation, first.key).expect(OK)
      expect((held.body as { scopes: string[] }).scopes).toEqual([PluginScopes.ORDERS_READ])
      expect((await call(`${PROBE}/write`, first.key, 'post')).status).toBe(FORBIDDEN)

      // The consent screen shows what is new
      const consent = await asAdmin().get(ApiRoutes.plugins.consent(first.id)).expect(OK)
      expect(consent.body).toMatchObject({
        grantedScopes: [PluginScopes.ORDERS_READ],
        newScopes: [PluginScopes.ORDERS_WRITE]
      })

      // Approving takes effect with the same key and no new code
      const approved = await install(first.id, [
        PluginScopes.ORDERS_READ,
        PluginScopes.ORDERS_WRITE
      ]).expect(CREATED)
      expect((approved.body as InstallBody).setup).toBeNull()
      expect((await call(`${PROBE}/write`, first.key, 'post')).status).toBe(201)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.PLUGIN_SCOPES_UPDATED,
        resourceId: first.setup.installationId
      })
      expect(entry?.metadata).toMatchObject({ added: [PluginScopes.ORDERS_WRITE], removed: [] })
    })

    it('is refused for a consent that was given for the older scopes', async () => {
      const first = await setUp({ scopes: [PluginScopes.ORDERS_READ] })
      await asAdmin()
        .post(ApiRoutes.plugins.register)
        .send(
          manifestOf(first.id, {
            version: '1.1.0',
            scopes: [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE]
          })
        )
        .expect(OK)

      const stale = await install(first.id, [PluginScopes.ORDERS_READ])

      expect(stale.status).toBe(CONFLICT)
      expect(codeOf(stale.body)).toBe(ErrorCodes.PLUGIN_CONSENT_MISMATCH)
    })

    it('passes the challenge again for an endpoint that changed, and not for one that did not', async () => {
      const first = await setUp({ scopes: [PluginScopes.ORDERS_READ] })
      challenge.run.mockClear()
      await asAdmin()
        .post(ApiRoutes.plugins.register)
        .send(
          manifestOf(first.id, {
            version: '1.1.0',
            webhooks: {
              endpoint: 'https://hooks.other.com/platform',
              events: ['message.received'],
              signatureHeader: 'X-Platform-Signature'
            }
          })
        )
        .expect(OK)

      await install(first.id, [PluginScopes.ORDERS_READ]).expect(CREATED)

      expect(challenge.run).toHaveBeenCalledWith(first.id, 'https://hooks.other.com/platform')
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: first.setup.installationId }
      })
      expect(row.webhookEndpoint).toBe('https://hooks.other.com/platform')
    })
  })
})
