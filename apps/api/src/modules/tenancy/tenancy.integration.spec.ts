import { randomInt, randomUUID } from 'node:crypto'

import type { Redis } from 'ioredis'

import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import { REDIS_CLIENT } from '@platform/core/redis'

import { type AuthTestApp, startAuthTestApp } from '../../testing/auth-test-app'
import type { TestStore } from '../../testing/tenant-fixtures'
import { ProbeRoutes } from '../../testing/tenant-probe.controller'

import { TenantContextService } from './tenant-context.service'

interface Reply<T = unknown> {
  status: number
  body: T
}

interface ErrorBody {
  error?: { code: string; message: string; metadata?: Record<string, unknown> }
}

const codeOf = (reply: Reply): string | undefined => (reply.body as ErrorBody).error?.code

// The guards of a store, on real requests against the real Postgres and Redis
describe('tenancy', () => {
  let test: AuthTestApp
  let contexts: TenantContextService
  let storeA: TestStore
  let storeB: TestStore
  let adminRoleA: string
  let viewerRoleA: string
  let viewerRoleB: string
  let tagA: string
  let tagB: string

  beforeAll(async () => {
    test = await startAuthTestApp()
    contexts = test.app.get(TenantContextService)
    storeA = await test.tenants.createStore()
    storeB = await test.tenants.createStore()
    adminRoleA = await test.tenants.createRole(storeA.storeId, [
      Permissions.CUSTOMERS_VIEW,
      Permissions.CUSTOMERS_EDIT
    ])
    viewerRoleA = await test.tenants.createRole(storeA.storeId, [Permissions.CUSTOMERS_VIEW])
    viewerRoleB = await test.tenants.createRole(storeB.storeId, [Permissions.CUSTOMERS_VIEW])
    tagA = await test.tenants.createTag(storeA.storeId)
    tagB = await test.tenants.createTag(storeB.storeId)
  })
  afterAll(() => test.cleanUp())

  // Each call comes from its own address: the rate limit is counted in a Redis every run shares
  const freshIp = (): string => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`

  async function call<T = unknown>(
    method: string,
    path: string,
    options: {
      token?: string
      store?: string
      body?: unknown
      query?: string
    } = {}
  ): Promise<Reply<T>> {
    const response = await fetch(`${test.url}/api/v1${path}${options.query ?? ''}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': freshIp(),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.store === undefined ? {} : { 'x-store-id': options.store })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
    const text = await response.text()
    return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T }
  }

  async function userWith(
    memberships: { store: TestStore; role: string }[]
  ): Promise<{ id: string; token: string; membershipIds: string[] }> {
    const user = await test.createUser()
    const membershipIds: string[] = []
    for (const { store, role } of memberships) {
      membershipIds.push(await test.tenants.addMember(user.id, store, role))
    }
    return { id: user.id, token: (await test.sessions.issue(user)).accessToken, membershipIds }
  }

  async function auditRows(
    userId: string,
    action: string
  ): Promise<
    {
      store_id: string | null
      metadata: Record<string, unknown> | null
      ip_address: string | null
    }[]
  > {
    await test.app.get(AuditService).onModuleDestroy() // Waits for the writes in flight
    const result = await test.asOwner(client =>
      client.query<{
        store_id: string | null
        metadata: Record<string, unknown> | null
        ip_address: string | null
      }>(
        'SELECT store_id, metadata, ip_address FROM audit_logs WHERE user_id = $1 AND action = $2',
        [userId, action]
      )
    )
    return result.rows
  }

  describe('the store of a request', () => {
    it('is the one in X-Store-Id, with the organization, the membership and the permissions', async () => {
      const alice = await userWith([{ store: storeA, role: adminRoleA }])

      const reply = await call<{
        storeId: string
        organizationId: string
        membership: { id: string }
      }>('GET', ProbeRoutes.context, { token: alice.token, store: storeA.storeId })

      expect(reply.status).toBe(200)
      expect(reply.body).toMatchObject({
        storeId: storeA.storeId,
        organizationId: storeA.organizationId,
        membership: { id: alice.membershipIds[0] }
      })
    })

    it('accepts the id in capitals, which is the same UUID', async () => {
      const alice = await userWith([{ store: storeA, role: adminRoleA }])

      const reply = await call('GET', ProbeRoutes.context, {
        token: alice.token,
        store: storeA.storeId.toUpperCase()
      })

      expect(reply.status).toBe(200)
    })

    it('is required: a request with no header is refused with TENANT_HEADER_MISSING', async () => {
      const alice = await userWith([{ store: storeA, role: adminRoleA }])

      const reply = await call('GET', ProbeRoutes.context, { token: alice.token })

      expect(reply.status).toBe(400)
      expect(codeOf(reply)).toBe('TENANT_HEADER_MISSING')
    })

    it('is never taken from the body or the query: with only those, the request is refused', async () => {
      const alice = await userWith([{ store: storeA, role: adminRoleA }])

      const reply = await call('POST', ProbeRoutes.write, {
        token: alice.token,
        body: { storeId: storeA.storeId },
        query: `?storeId=${storeA.storeId}`
      })

      expect(reply.status).toBe(400)
      expect(codeOf(reply)).toBe('TENANT_HEADER_MISSING')
    })

    it('is not changed by a storeId in the body or the query next to the header', async () => {
      const alice = await userWith([
        { store: storeA, role: adminRoleA },
        { store: storeB, role: viewerRoleB }
      ])

      const reply = await call<{
        storeId: string
        body: { storeId: string }
        query: { storeId: string }
      }>('POST', ProbeRoutes.write, {
        token: alice.token,
        store: storeA.storeId,
        body: { storeId: storeB.storeId },
        query: `?storeId=${storeB.storeId}`
      })

      expect(reply.status).toBe(201)
      expect(reply.body.storeId).toBe(storeA.storeId) // The header
      expect(reply.body.body.storeId).toBe(storeB.storeId) // Carried along, and never used
      expect(reply.body.query.storeId).toBe(storeB.storeId)
    })

    it.each([
      ['not a UUID', 'not-a-uuid'],
      ['two ids in one header', `${randomUUID()}, ${randomUUID()}`],
      ['a query fragment', "' OR 1=1 --"],
      ['too long', 'a'.repeat(5000)]
    ])(
      'refuses a header that is %s with VALIDATION_FAILED, without echoing it',
      async (_name, value) => {
        const alice = await userWith([{ store: storeA, role: adminRoleA }])

        const reply = await call('GET', ProbeRoutes.context, { token: alice.token, store: value })

        expect(reply.status).toBe(400)
        expect(codeOf(reply)).toBe('VALIDATION_FAILED')
        expect(JSON.stringify(reply.body)).not.toContain(value.slice(0, 20))
      }
    )

    it('treats a header with only spaces as missing', async () => {
      const alice = await userWith([{ store: storeA, role: adminRoleA }])

      const reply = await call('GET', ProbeRoutes.context, { token: alice.token, store: '   ' })

      expect(codeOf(reply)).toBe('TENANT_HEADER_MISSING')
    })
  })

  describe('who may enter a store', () => {
    it('refuses a store the user is not a member of, with TENANT_ACCESS_DENIED', async () => {
      const bob = await userWith([{ store: storeB, role: viewerRoleB }])

      const reply = await call('GET', ProbeRoutes.context, {
        token: bob.token,
        store: storeA.storeId
      })

      expect(reply.status).toBe(403)
      expect(codeOf(reply)).toBe('TENANT_ACCESS_DENIED')
    })

    it('answers the same for a store that does not exist as for one the user does not belong to', async () => {
      const bob = await userWith([{ store: storeB, role: viewerRoleB }])

      const foreign = await call('GET', ProbeRoutes.context, {
        token: bob.token,
        store: storeA.storeId
      })
      const missing = await call('GET', ProbeRoutes.context, {
        token: bob.token,
        store: randomUUID()
      })

      expect(missing.status).toBe(foreign.status)
      expect((missing.body as ErrorBody).error).toEqual((foreign.body as ErrorBody).error)
    })

    it('refuses a user who has no store at all', async () => {
      const nobody = await userWith([])

      const reply = await call('GET', ProbeRoutes.context, {
        token: nobody.token,
        store: storeA.storeId
      })

      expect(codeOf(reply)).toBe('TENANT_ACCESS_DENIED')
    })

    it('refuses a membership that was revoked', async () => {
      const user = await test.createUser()
      await test.tenants.addMember(user.id, storeA, adminRoleA, 'REVOKED')
      const token = (await test.sessions.issue(user)).accessToken

      const reply = await call('GET', ProbeRoutes.context, { token, store: storeA.storeId })

      expect(codeOf(reply)).toBe('TENANT_ACCESS_DENIED')
    })

    it('asks for a token before it looks at the store', async () => {
      const reply = await call('GET', ProbeRoutes.context, { store: storeA.storeId })

      expect(reply.status).toBe(401)
      expect(codeOf(reply)).toBe('AUTH_UNAUTHORIZED')
    })
  })

  describe('what the user may do there', () => {
    it('lets through a user who has the permission and refuses one who has not', async () => {
      const admin = await userWith([{ store: storeA, role: adminRoleA }])
      const viewer = await userWith([{ store: storeA, role: viewerRoleA }])

      const allowed = await call('POST', ProbeRoutes.write, {
        token: admin.token,
        store: storeA.storeId
      })
      const refused = await call('POST', ProbeRoutes.write, {
        token: viewer.token,
        store: storeA.storeId
      })

      expect(allowed.status).toBe(201)
      expect(refused.status).toBe(403)
      expect(codeOf(refused)).toBe('PERMISSION_DENIED')
      expect((refused.body as ErrorBody).error?.metadata).toEqual({
        required: [Permissions.CUSTOMERS_EDIT]
      })
    })

    it('judges the permissions of each store on their own', async () => {
      const alice = await userWith([
        { store: storeA, role: adminRoleA },
        { store: storeB, role: viewerRoleB }
      ])

      const inA = await call('POST', ProbeRoutes.write, {
        token: alice.token,
        store: storeA.storeId
      })
      const inB = await call('POST', ProbeRoutes.write, {
        token: alice.token,
        store: storeB.storeId
      })

      expect([inA.status, inB.status]).toEqual([201, 403])
    })

    it('refuses a route in a store that declares no permission, instead of letting it through', async () => {
      const admin = await userWith([{ store: storeA, role: adminRoleA }])

      const reply = await call('GET', ProbeRoutes.undeclared, {
        token: admin.token,
        store: storeA.storeId
      })

      expect(reply.status).toBe(403)
      expect(codeOf(reply)).toBe('PERMISSION_DENIED')
    })

    it('ignores a permission name the code does not know', async () => {
      const store = await test.tenants.createStore()
      const role = await test.tenants.createRole(store.storeId, [Permissions.CUSTOMERS_VIEW])
      await test.asOwner(client =>
        client.query(
          `INSERT INTO permissions (id, name, role_id) VALUES ($1, 'customers:fly', $2)`,
          [randomUUID(), role]
        )
      )
      const user = await userWith([{ store, role }])

      const reply = await call<{ permissions: string[] }>('GET', ProbeRoutes.context, {
        token: user.token,
        store: store.storeId
      })

      expect(reply.status).toBe(200)
      // The known permission works; the unknown one is not among those granted
      expect(reply.body.permissions).toEqual([Permissions.CUSTOMERS_VIEW])
    })
  })

  describe('routes that do not belong to a store', () => {
    it('lets a @SkipTenant route through for a logged-in user with no header', async () => {
      const nobody = await userWith([])

      const reply = await call('GET', ProbeRoutes.person, { token: nobody.token })

      expect(reply.status).toBe(200)
    })

    it('still asks a @SkipTenant route for a token', async () => {
      const reply = await call('GET', ProbeRoutes.person)

      expect(reply.status).toBe(401)
    })

    it('lets a @Public route through with nothing', async () => {
      const reply = await call('GET', ProbeRoutes.open)

      expect(reply.status).toBe(200)
    })

    it('keeps the account routes of Step 1.1 working without a store', async () => {
      const nobody = await userWith([])

      const me = await call('GET', '/auth/me', { token: nobody.token })
      const sessions = await call('GET', '/auth/sessions', { token: nobody.token })

      expect([me.status, sessions.status]).toEqual([200, 200])
    })
  })

  describe('isolation of a resource: the first one, tags', () => {
    it('lists only the tags of the store of the request', async () => {
      const alice = await userWith([
        { store: storeA, role: viewerRoleA },
        { store: storeB, role: viewerRoleB }
      ])

      const inA = await call<{ id: string }[]>('GET', ProbeRoutes.tags, {
        token: alice.token,
        store: storeA.storeId
      })
      const inB = await call<{ id: string }[]>('GET', ProbeRoutes.tags, {
        token: alice.token,
        store: storeB.storeId
      })

      expect(inA.body.map(tag => tag.id)).toEqual([tagA])
      expect(inB.body.map(tag => tag.id)).toEqual([tagB])
    })

    it('cannot read a tag of another store by its id: it looks like it does not exist', async () => {
      const alice = await userWith([{ store: storeA, role: viewerRoleA }])

      const own = await call('GET', ProbeRoutes.tagById(tagA), {
        token: alice.token,
        store: storeA.storeId
      })
      const foreign = await call('GET', ProbeRoutes.tagById(tagB), {
        token: alice.token,
        store: storeA.storeId
      })
      const missing = await call('GET', ProbeRoutes.tagById(randomUUID()), {
        token: alice.token,
        store: storeA.storeId
      })

      expect(own.status).toBe(200)
      expect(foreign.status).toBe(404)
      expect((foreign.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
    })

    it('cannot reach the store of the tag by naming it in the header either', async () => {
      const alice = await userWith([{ store: storeA, role: viewerRoleA }])

      const reply = await call('GET', ProbeRoutes.tagById(tagB), {
        token: alice.token,
        store: storeB.storeId
      })

      expect(reply.status).toBe(403)
    })
  })

  describe('the cache of the context', () => {
    it('serves a membership from the cache, and drops it when told to', async () => {
      const user = await userWith([{ store: storeA, role: adminRoleA }])
      expect(
        (await call('GET', ProbeRoutes.context, { token: user.token, store: storeA.storeId }))
          .status
      ).toBe(200)

      // The membership is removed in the database and nobody tells the cache
      await test.tenants.removeMember(user.membershipIds[0] ?? '')
      const stale = await call('GET', ProbeRoutes.context, {
        token: user.token,
        store: storeA.storeId
      })
      expect(stale.status).toBe(200) // Proves there is a cache at all: the next steps would pass without one

      await contexts.invalidateUser(user.id, storeA.storeId)
      const after = await call('GET', ProbeRoutes.context, {
        token: user.token,
        store: storeA.storeId
      })
      expect(codeOf(after)).toBe('TENANT_ACCESS_DENIED')
    })

    it('does not drop the context of another user when one is invalidated', async () => {
      const [one, two] = [
        await userWith([{ store: storeA, role: adminRoleA }]),
        await userWith([{ store: storeA, role: adminRoleA }])
      ]
      await call('GET', ProbeRoutes.context, { token: one.token, store: storeA.storeId })
      await call('GET', ProbeRoutes.context, { token: two.token, store: storeA.storeId })
      await test.tenants.removeMember(one.membershipIds[0] ?? '')
      await test.tenants.removeMember(two.membershipIds[0] ?? '')

      await contexts.invalidateUser(one.id, storeA.storeId)

      const [first, second] = [
        await call('GET', ProbeRoutes.context, { token: one.token, store: storeA.storeId }),
        await call('GET', ProbeRoutes.context, { token: two.token, store: storeA.storeId })
      ]
      expect([first.status, second.status]).toEqual([403, 200])
    })

    it('drops the context of everybody in a store when the store is invalidated', async () => {
      const store = await test.tenants.createStore()
      const role = await test.tenants.createRole(store.storeId, [Permissions.CUSTOMERS_VIEW])
      const [one, two] = [await userWith([{ store, role }]), await userWith([{ store, role }])]
      await call('GET', ProbeRoutes.context, { token: one.token, store: store.storeId })
      await call('GET', ProbeRoutes.context, { token: two.token, store: store.storeId })

      // The role loses its permission, and the store is invalidated
      await test.tenants.setPermissions(role, [])
      await contexts.invalidateStore(store.storeId)

      const replies = [
        await call('GET', ProbeRoutes.context, { token: one.token, store: store.storeId }),
        await call('GET', ProbeRoutes.context, { token: two.token, store: store.storeId })
      ]
      expect(replies.map(reply => reply.status)).toEqual([403, 403])
      expect(replies.map(codeOf)).toEqual(['PERMISSION_DENIED', 'PERMISSION_DENIED'])
    })

    it('caches "no access" too, and lets a new member in once it is invalidated', async () => {
      const user = await test.createUser()
      const token = (await test.sessions.issue(user)).accessToken
      expect(codeOf(await call('GET', ProbeRoutes.context, { token, store: storeA.storeId }))).toBe(
        'TENANT_ACCESS_DENIED'
      )

      await test.tenants.addMember(user.id, storeA, adminRoleA)
      const stillDenied = await call('GET', ProbeRoutes.context, { token, store: storeA.storeId })
      expect(stillDenied.status).toBe(403) // The cached refusal: it is what makes probing cheap

      await contexts.invalidateUser(user.id, storeA.storeId)
      expect(
        (await call('GET', ProbeRoutes.context, { token, store: storeA.storeId })).status
      ).toBe(200)
    })
  })

  describe('the audit trail of refusals', () => {
    it('records a store the user was refused, with the id they asked for in the metadata and not in the store column', async () => {
      const bob = await userWith([{ store: storeB, role: viewerRoleB }])

      await call('GET', ProbeRoutes.context, { token: bob.token, store: storeA.storeId })

      const rows = await auditRows(bob.id, 'tenant.access_denied')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.store_id).toBeNull()
      expect(rows[0]?.metadata).toMatchObject({
        requestedStoreId: storeA.storeId,
        method: 'GET',
        path: '/api/v1/probe/context'
      })
      expect(rows[0]?.ip_address).toMatch(/^10\./)
    })

    it('records a missing permission with the store and what was missing', async () => {
      const viewer = await userWith([{ store: storeA, role: viewerRoleA }])

      await call('POST', ProbeRoutes.write, { token: viewer.token, store: storeA.storeId })

      const rows = await auditRows(viewer.id, 'permission.denied')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.store_id).toBe(storeA.storeId)
      expect(rows[0]?.metadata).toMatchObject({ missing: [Permissions.CUSTOMERS_EDIT] })
    })

    it('writes no more than ten refusals of one user a minute, so probing cannot fill the table', async () => {
      const bob = await userWith([{ store: storeB, role: viewerRoleB }])

      for (let i = 0; i < 14; i += 1) {
        await call('GET', ProbeRoutes.context, { token: bob.token, store: randomUUID() })
      }

      expect(await auditRows(bob.id, 'tenant.access_denied')).toHaveLength(10)
    })

    it('still writes after the process died between counting and giving the minute its end', async () => {
      const bob = await userWith([{ store: storeB, role: viewerRoleB }])
      const redis = test.app.get<Redis>(REDIS_CLIENT)
      const key = CacheKeys.audit.denialBudget(bob.id, 'tenant.access_denied')
      // What a crash between INCR and EXPIRE leaves behind: a counter with no end
      await redis.set(key, '3')
      expect(await redis.ttl(key)).toBe(-1)

      await call('GET', ProbeRoutes.context, { token: bob.token, store: storeA.storeId })

      expect(await redis.ttl(key)).toBeGreaterThan(0) // The minute has an end again
      expect(await auditRows(bob.id, 'tenant.access_denied')).toHaveLength(1)
    })

    it('does not record the refusals of a request that was not a refusal', async () => {
      const alice = await userWith([{ store: storeA, role: adminRoleA }])

      await call('GET', ProbeRoutes.context, { token: alice.token, store: storeA.storeId })

      expect(await auditRows(alice.id, 'tenant.access_denied')).toEqual([])
      expect(await auditRows(alice.id, 'permission.denied')).toEqual([])
    })

    it('writes the entry of an @Audit route with the store and the organization of the request', async () => {
      const alice = await userWith([{ store: storeA, role: viewerRoleA }])
      const id = randomUUID()

      await call('GET', ProbeRoutes.audited(id), { token: alice.token, store: storeA.storeId })

      await test.app.get(AuditService).onModuleDestroy()
      const result = await test.asOwner(client =>
        client.query<{ store_id: string; organization_id: string; resource_id: string }>(
          `SELECT store_id, organization_id, resource_id FROM audit_logs WHERE user_id = $1 AND action = 'customer.viewed'`,
          [alice.id]
        )
      )
      expect(result.rows).toEqual([
        { store_id: storeA.storeId, organization_id: storeA.organizationId, resource_id: id }
      ])
    })
  })

  describe('the metrics', () => {
    it('counts the refusals for a missing permission, one per permission', async () => {
      const viewer = await userWith([{ store: storeA, role: viewerRoleA }])
      await call('POST', ProbeRoutes.write, { token: viewer.token, store: storeA.storeId })

      const response = await fetch(`${test.url}/metrics`)
      const text = await response.text()

      expect(text).toMatch(/platform_permission_denials_total\{permission="customers:edit"\} [1-9]/)
    })

    it('counts the stores that were asked for without access as violations', async () => {
      const bob = await userWith([{ store: storeB, role: viewerRoleB }])
      await call('GET', ProbeRoutes.context, { token: bob.token, store: storeA.storeId })

      const text = await (await fetch(`${test.url}/metrics`)).text()

      expect(text).toMatch(/platform_tenant_violations_total\{resource="[^"]*"\} [1-9]/)
    })
  })
})
