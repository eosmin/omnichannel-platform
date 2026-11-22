import { createHash, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginCatalogTypes,
  PluginIdempotency,
  PluginIdempotencyConflicts,
  PluginIdempotencyState,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { PluginScopes } from '@platform/plugins/sdk'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// The idempotency key of the writes of the plugin API (Step 7.3, S4) through the real api, with the transaction of the request OPEN
// (RLS_CONTEXT on, a client that refuses a query with no context): the claim, the write and the answer are ONE transaction (a
// failed call rolls its claim back; a concurrent call with the key waits on the unique index). The mode with the switch OFF has no spec
// against a real database yet (plan, Step 7.3-S4 (j)).
describe('the idempotency key of the plugin API', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-idem-api`
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let installationId = ''
  let bearer = ''

  const createTag = (name: string, key?: string) => {
    const request = supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
      .post(`${API_PREFIX}${PluginApiRoutes.settings.tags}`)
      .set('authorization', `Bearer ${bearer}`)
      // Each call from its own address: the limit by address is not what this suite is about
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
    if (key !== undefined) request.set(PluginIdempotency.HEADER, key)
    return request.send({ name })
  }
  const tagsNamed = (name: string) => owner.tag.count({ where: { storeId: ctx.storeA.id, name } })
  const rowsOf = (key: string) => owner.pluginIdempotencyKey.findMany({ where: { key } })

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(
          new PrismaService({
            databaseUrl: connectionUrls().app,
            poolSize: 8,
            requireContext: true
          })
        )
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
    await owner.plugin.create({
      data: {
        id: pluginId,
        name: 'Idempotent plugin',
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.CHANNEL,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED,
        organizationId: null
      }
    })
    bearer = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}idem${'q'.repeat(40)}`
    const installation = await owner.pluginInstallation.create({
      data: {
        storeId: ctx.storeA.id,
        pluginId,
        scopes: [PluginScopes.TAGS_READ, PluginScopes.TAGS_WRITE],
        status: 'active',
        apiKeyPrefix: bearer.slice(0, 12),
        apiKeyHash: createHash('sha256').update(bearer).digest('hex'),
        installedBy: 'suite'
      }
    })
    installationId = installation.id
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId } })
    await owner.plugin.deleteMany({ where: { id: pluginId } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  it('makes the write once and answers the repeat with the first answer, kept with the write', async () => {
    const key = `key-${randomUUID()}`
    const name = `${prefix}-once`

    const first = await createTag(name, key)
    const again = await createTag(name, key)

    expect(first.status).toBe(201)
    expect(first.header[PluginIdempotency.REPLAY_HEADER]).toBeUndefined()
    expect(again.status).toBe(201)
    expect(again.header[PluginIdempotency.REPLAY_HEADER]).toBe('true')
    expect(again.body).toEqual(first.body)
    expect(await tagsNamed(name)).toBe(1)
    const rows = await rowsOf(key)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row === undefined) throw new Error('the key left no row')
    expect(row).toMatchObject({
      storeId: ctx.storeA.id,
      installationId,
      state: PluginIdempotencyState.COMPLETED,
      responseStatus: 201,
      responseOmitted: false
    })
    expect(row.responseBody).toEqual(first.body)
    expect(row.expiresAt.getTime() - row.claimedAt.getTime()).toBe(
      PluginIdempotency.TTL_HOURS * 3_600_000
    )
  })

  it('without the header the call is made every time, as it was', async () => {
    const name = `${prefix}-nokey`

    const first = await createTag(name)
    const second = await createTag(name)

    expect(first.status).toBe(201)
    // A tag name is unique in a store: the second is the refusal it always was, not a replay
    expect(second.status).toBe(409)
    expect(second.header[PluginIdempotency.REPLAY_HEADER]).toBeUndefined()
  })

  it('refuses the key for another request and does not make the write', async () => {
    const key = `key-${randomUUID()}`
    expect((await createTag(`${prefix}-one`, key)).status).toBe(201)

    const other = await createTag(`${prefix}-two`, key)

    expect(other.status).toBe(409)
    expect((other.body as { error: { metadata: { reason: string } } }).error.metadata.reason).toBe(
      PluginIdempotencyConflicts.KEY_REUSED
    )
    expect(await tagsNamed(`${prefix}-two`)).toBe(0)
  })

  it('frees the key when the call fails, so the retry with the same key is made', async () => {
    const name = `${prefix}-retry`
    expect((await createTag(name)).status).toBe(201)

    // A failure of the route (the name is taken) leaves no claim behind: nothing waits for the next call with that key
    const failedKey = `key-${randomUUID()}`
    const failed = await createTag(name, failedKey)
    expect(failed.status).toBe(409)
    expect(await rowsOf(failedKey)).toHaveLength(0)
    const retried = await createTag(`${prefix}-retry-2`, failedKey)
    expect(retried.status).toBe(201)
    expect(await rowsOf(failedKey)).toHaveLength(1)
  })

  it('makes the write once when two calls with the same key arrive together', async () => {
    const key = `key-${randomUUID()}`
    const name = `${prefix}-together`

    const answers = await Promise.all([createTag(name, key), createTag(name, key)])

    // One makes it. The other is told to wait (409) or, if the first had already answered, gets the same answer back (201)
    expect(answers.filter(answer => answer.status === 201).length).toBeGreaterThanOrEqual(1)
    for (const answer of answers) expect([201, 409]).toContain(answer.status)
    expect(await tagsNamed(name)).toBe(1)
    expect(await rowsOf(key)).toHaveLength(1)
  })

  it('refuses a key a plugin may not send, before the route runs', async () => {
    const name = `${prefix}-badkey`

    const empty = await createTag(name, '')
    const spaced = await createTag(name, 'has a space')
    const long = await createTag(name, 'k'.repeat(PluginIdempotency.KEY_MAX_LENGTH + 1))

    for (const answer of [empty, spaced, long]) expect(answer.status).toBe(400)
    expect(await tagsNamed(name)).toBe(0)
  })

  it('ignores the header on a route of a person', async () => {
    const key = `key-${randomUUID()}`
    const name = `${prefix}-person`

    const first = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.settings.tags)
      .set(PluginIdempotency.HEADER, key)
      .send({ name })

    expect(first.status).toBe(201)
    expect(await rowsOf(key)).toHaveLength(0)
  })
})
