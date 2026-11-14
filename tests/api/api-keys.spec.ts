import { createHash } from 'node:crypto'

import { Controller, Get, UseGuards } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  API_KEY_RESOURCE_TYPE,
  API_KEY_TOKEN_PREFIX,
  ApiKeyLimits,
  ApiKeyStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import {
  ApiKeyGuard,
  type ApiKeyContext,
  CurrentApiKey,
  RequireApiKeyScopes
} from '../../apps/api/src/modules/api-keys'
import { actorWithPermissions } from '../helpers/actors'
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
const PROBE = '/probe/api-key'

// The first route behind ApiKeyGuard: the guard has no consumer yet (the public API arrives with Step 5.6), so the suite
// brings one. It is public for the session guards, because the key is its credential, and reads the store from the key.
@Controller()
class ApiKeyProbeController {
  @Public()
  @UseGuards(ApiKeyGuard)
  @RequireApiKeyScopes(Permissions.CUSTOMERS_VIEW)
  @Get(`${PROBE}/customers`)
  customers(@CurrentApiKey() key: ApiKeyContext): ApiKeyContext {
    return key
  }

  @Public()
  @UseGuards(ApiKeyGuard)
  @RequireApiKeyScopes(Permissions.CUSTOMERS_VIEW, Permissions.ORDERS_VIEW)
  @Get(`${PROBE}/both`)
  both(@CurrentApiKey() key: ApiKeyContext): ApiKeyContext {
    return key
  }

  // A route that forgot to say what it needs: it must not be open to every key
  @Public()
  @UseGuards(ApiKeyGuard)
  @Get(`${PROBE}/unnamed`)
  unnamed(): string {
    return 'open'
  }
}

// Settings → API keys (Step 5.4 PR A, TDD_05): a key is shown once and kept as a prefix and a hash, it holds scopes its maker
// holds and none that run the account, and the guard that accepts it names the store of the key and nothing else.
describe('The API keys of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([ApiKeyProbeController])
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.apiKey.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } }
    })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  type Made = { id: string; key: string; keyPrefix: string; scopes: string[]; status: string }
  const make = async (body: object = { name: 'ERP', scopes: [Permissions.CUSTOMERS_VIEW] }) =>
    (await asAdmin().post(ApiRoutes.settings.apiKeys).send(body).expect(CREATED)).body as Made
  const call = (path: string, key?: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    const request = supertest(server).get(`${API_PREFIX}${path}`)
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }

  describe('making and listing', () => {
    it('shows the key once and keeps only its prefix and its hash', async () => {
      const made = await make()

      expect(made.key.startsWith(API_KEY_TOKEN_PREFIX)).toBe(true)
      expect(made.keyPrefix).toBe(made.key.slice(0, ApiKeyLimits.DISPLAY_PREFIX_LENGTH))
      const row = await owner.apiKey.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.keyHash).toBe(createHash('sha256').update(made.key).digest('hex'))
      expect(JSON.stringify(row)).not.toContain(made.key)
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        createdBy: ctx.adminA.id,
        status: ApiKeyStatus.ACTIVE
      })

      const list = await asAdmin().get(ApiRoutes.settings.apiKeys).expect(OK)
      expect(JSON.stringify(list.body)).not.toContain(made.key)
      expect(JSON.stringify(list.body)).not.toContain('keyHash')
      expect((list.body as Made[]).map(item => item.id)).toEqual([made.id])
    })

    it('lists a key past its date as expired', async () => {
      const made = await make()
      await owner.apiKey.update({
        where: { id: made.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })

      const list = await asAdmin().get(ApiRoutes.settings.apiKeys).expect(OK)

      expect((list.body as Made[])[0]?.status).toBe(ApiKeyStatus.EXPIRED)
    })

    it('audits the making and the revoking without the key', async () => {
      const made = await make()
      await asAdmin().delete(ApiRoutes.settings.apiKeyById(made.id)).expect(OK)

      for (const action of [AuditAction.API_KEY_CREATED, AuditAction.API_KEY_REVOKED]) {
        const [entry] = await waitForAuditEntries(owner, { action, resourceId: made.id })
        expect(entry?.resourceType).toBe(API_KEY_RESOURCE_TYPE)
        expect(entry?.storeId).toBe(ctx.storeA.id)
        expect(JSON.stringify(entry)).not.toContain(made.key)
      }
    })

    it('refuses a scope that runs the account, one that does not exist, none, and a date in the past', async () => {
      const post = (body: object) => asAdmin().post(ApiRoutes.settings.apiKeys).send(body)
      for (const scope of [
        Permissions.SETTINGS_MANAGE_API_KEYS,
        Permissions.SETTINGS_MANAGE_WEBHOOKS,
        Permissions.TEAM_INVITE,
        Permissions.ORG_MANAGE_STORES,
        'customers:everything'
      ]) {
        await post({ name: 'x', scopes: [scope] }).expect(BAD_REQUEST)
      }
      await post({ name: 'x', scopes: [] }).expect(BAD_REQUEST)
      await post({ name: '', scopes: [Permissions.CUSTOMERS_VIEW] }).expect(BAD_REQUEST)
      await post({
        name: 'x',
        scopes: [Permissions.CUSTOMERS_VIEW],
        expiresAt: '2020-01-01T00:00:00Z'
      }).expect(BAD_REQUEST)
      await post({
        name: 'x',
        scopes: [Permissions.CUSTOMERS_VIEW],
        storeId: ctx.storeB.id
      }).expect(BAD_REQUEST)
      expect(await owner.apiKey.count({ where: { storeId: ctx.storeA.id } })).toBe(0)
    })

    it('never gives a key a scope its maker lacks', async () => {
      const maker = await actorWithPermissions(owner, app, {
        prefix,
        name: 'keyMaker',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SETTINGS_MANAGE_API_KEYS, Permissions.CUSTOMERS_VIEW]
      })
      const as = api(app, maker, ctx.storeA)

      const response = await as
        .post(ApiRoutes.settings.apiKeys)
        .send({ name: 'greedy', scopes: [Permissions.CUSTOMERS_VIEW, Permissions.ORDERS_VIEW] })
        .expect(FORBIDDEN)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.PERMISSION_DENIED
      )
      await as
        .post(ApiRoutes.settings.apiKeys)
        .send({ name: 'modest', scopes: [Permissions.CUSTOMERS_VIEW] })
        .expect(CREATED)
    })

    it('does not let a key past its date take room', async () => {
      await owner.apiKey.createMany({
        data: Array.from({ length: ApiKeyLimits.MAX_PER_STORE }, (_, index) => ({
          storeId: ctx.storeA.id,
          name: `old${index}`,
          keyPrefix: `pk_live_${index}`,
          keyHash: createHash('sha256').update(`expired-${prefix}-${index}`).digest('hex'),
          scopes: [Permissions.CUSTOMERS_VIEW],
          expiresAt: new Date(Date.now() - 60_000),
          createdBy: ctx.adminA.id
        }))
      })

      await asAdmin()
        .post(ApiRoutes.settings.apiKeys)
        .send({ name: 'fresh', scopes: [Permissions.CUSTOMERS_VIEW] })
        .expect(CREATED)
    })

    it('holds a limit of active keys per store, and a revoked key does not count', async () => {
      await owner.apiKey.createMany({
        data: Array.from({ length: ApiKeyLimits.MAX_PER_STORE }, (_, index) => ({
          storeId: ctx.storeA.id,
          name: `k${index}`,
          keyPrefix: `pk_live_${index}`,
          keyHash: createHash('sha256').update(`seed-${prefix}-${index}`).digest('hex'),
          scopes: [Permissions.CUSTOMERS_VIEW],
          createdBy: ctx.adminA.id
        }))
      })
      const body = { name: 'one more', scopes: [Permissions.CUSTOMERS_VIEW] }
      await asAdmin().post(ApiRoutes.settings.apiKeys).send(body).expect(CONFLICT)

      const [first] = await owner.apiKey.findMany({ where: { storeId: ctx.storeA.id }, take: 1 })
      await asAdmin()
        .delete(ApiRoutes.settings.apiKeyById(first?.id ?? ''))
        .expect(OK)
      await asAdmin().post(ApiRoutes.settings.apiKeys).send(body).expect(CREATED)
    })
  })

  describe('who may', () => {
    it('is for whoever holds settings:manage_api_keys', async () => {
      const made = await make()
      for (const actor of [ctx.agentA, ctx.viewerA]) {
        const as = api(app, actor, ctx.storeA)
        await as.get(ApiRoutes.settings.apiKeys).expect(FORBIDDEN)
        await as
          .post(ApiRoutes.settings.apiKeys)
          .send({ name: 'x', scopes: [Permissions.CUSTOMERS_VIEW] })
          .expect(FORBIDDEN)
        await as.delete(ApiRoutes.settings.apiKeyById(made.id)).expect(FORBIDDEN)
      }
    })

    it('is scoped to the store of the request: another store neither sees nor revokes a key', async () => {
      const made = await make()
      for (const as of [api(app, ctx.adminB, ctx.storeB), api(app, ctx.adminA2, ctx.storeA2)]) {
        expect((await as.get(ApiRoutes.settings.apiKeys).expect(OK)).body).toEqual([])
        await as.delete(ApiRoutes.settings.apiKeyById(made.id)).expect(NOT_FOUND)
      }
      expect((await owner.apiKey.findUniqueOrThrow({ where: { id: made.id } })).status).toBe(
        ApiKeyStatus.ACTIVE
      )
    })
  })

  describe('revoking', () => {
    it('keeps the row, says when, and is the same answer the second time', async () => {
      const made = await make()

      const first = await asAdmin().delete(ApiRoutes.settings.apiKeyById(made.id)).expect(OK)
      const again = await asAdmin().delete(ApiRoutes.settings.apiKeyById(made.id)).expect(OK)

      expect(first.body).toMatchObject({ id: made.id, status: ApiKeyStatus.REVOKED })
      expect((first.body as { revokedAt: string | null }).revokedAt).not.toBeNull()
      expect(again.body).toEqual(first.body)
      // One entry, not two
      expect(
        await waitForAuditEntries(owner, {
          action: AuditAction.API_KEY_REVOKED,
          resourceId: made.id
        })
      ).toHaveLength(1)
    })
  })

  describe('the guard', () => {
    it('lets a key in as its own store, with its own scopes, and nothing from the request names the store', async () => {
      const made = await make()

      const response = await call(`${PROBE}/customers`, made.key)
        .set('x-store-id', ctx.storeB.id)
        .expect(OK)

      expect(response.body).toEqual({
        keyId: made.id,
        storeId: ctx.storeA.id,
        scopes: [Permissions.CUSTOMERS_VIEW]
      })
    })

    it('accepts the scheme in any letter case', async () => {
      const made = await make()
      const server = app.getHttpServer() as Parameters<typeof supertest>[0]

      await supertest(server)
        .get(`${API_PREFIX}${PROBE}/customers`)
        .set('authorization', `bearer ${made.key}`)
        .expect(OK)
    })

    it('says when it was last used, without writing at every call', async () => {
      const made = await make()
      expect(
        (await owner.apiKey.findUniqueOrThrow({ where: { id: made.id } })).lastUsedAt
      ).toBeNull()

      await call(`${PROBE}/customers`, made.key).expect(OK)
      let stamp: Date | null = null
      for (let turn = 0; turn < 40 && stamp === null; turn += 1) {
        await new Promise(resolve => setTimeout(resolve, 50))
        stamp = (await owner.apiKey.findUniqueOrThrow({ where: { id: made.id } })).lastUsedAt
      }
      expect(stamp).not.toBeNull()

      await call(`${PROBE}/customers`, made.key).expect(OK)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect((await owner.apiKey.findUniqueOrThrow({ where: { id: made.id } })).lastUsedAt).toEqual(
        stamp
      )
    })

    it('gives one answer to a missing, malformed, unknown, revoked or expired key', async () => {
      const revoked = await make()
      await asAdmin().delete(ApiRoutes.settings.apiKeyById(revoked.id)).expect(OK)
      const expired = await make()
      await owner.apiKey.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })
      const attempts = [
        call(`${PROBE}/customers`),
        call(`${PROBE}/customers`, 'pk_live_not-a-real-key'),
        call(`${PROBE}/customers`, 'something-else-entirely'),
        call(`${PROBE}/customers`, revoked.key),
        call(`${PROBE}/customers`, expired.key),
        call(`${PROBE}/customers`).set('authorization', `Basic ${revoked.key}`)
      ]

      const bodies: unknown[] = []
      for (const attempt of attempts) {
        const response = await attempt.expect(UNAUTHORIZED)
        bodies.push((response.body as { error: { code: string; message?: string } }).error)
      }
      for (const error of bodies) {
        expect((error as { code: string }).code).toBe(ErrorCodes.API_KEY_INVALID)
      }
      expect(new Set(bodies.map(error => JSON.stringify(error))).size).toBe(1)
    })

    it('refuses a route whose scopes the key does not all hold', async () => {
      const made = await make()

      await call(`${PROBE}/customers`, made.key).expect(OK)
      const response = await call(`${PROBE}/both`, made.key).expect(FORBIDDEN)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.PERMISSION_DENIED
      )
    })

    it('does not count a scope written into the row that a key may not hold', async () => {
      const made = await make()
      await owner.apiKey.update({
        where: { id: made.id },
        data: {
          scopes: [Permissions.CUSTOMERS_VIEW, Permissions.ORDERS_VIEW, Permissions.TEAM_REMOVE]
        }
      })

      const response = await call(`${PROBE}/both`, made.key).expect(OK)
      expect((response.body as ApiKeyContext).scopes).toEqual([
        Permissions.CUSTOMERS_VIEW,
        Permissions.ORDERS_VIEW
      ])
    })

    it('is closed to a route that names no scope', async () => {
      const made = await make()

      await call(`${PROBE}/unnamed`, made.key).expect(500)
    })

    it('stops a key at once when it is revoked', async () => {
      const made = await make()
      await call(`${PROBE}/customers`, made.key).expect(OK)

      await asAdmin().delete(ApiRoutes.settings.apiKeyById(made.id)).expect(OK)

      await call(`${PROBE}/customers`, made.key).expect(UNAUTHORIZED)
    })
  })
})
