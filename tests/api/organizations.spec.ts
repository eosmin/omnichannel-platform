import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { type Permission, Permissions, RoleNames } from '@platform/core/auth'
import { ensureMembership, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import { TenantContextService } from '../../apps/api/src/modules/tenancy'
import { createRole, createTag } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: { tables?: string[] } }
}
interface StoreBody {
  id: string
  name: string
  slug: string
  timezone: string
  currency: string
  defaultLocale: string
}

const NO_CONTENT = 204

describe('Organizations and stores', () => {
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
    await app.close()
    await owner.$disconnect()
  })

  const next = (label: string): string => {
    counter += 1
    return `${label}${counter}`
  }
  // A custom role of a store of the run, with the permissions given
  const roleWith = async (storeId: string, permissions: Permission[]) =>
    (await createRole(owner, { storeId, name: `${prefix}-${next('role')}`, permissions })).id

  const nextName = (): string => {
    counter += 1
    return `${prefix}-new-${counter}`
  }
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  // A store of organization A that the test may change or delete
  async function createStore(name = nextName()): Promise<StoreBody> {
    const response = await asAdmin().post(ApiRoutes.organizations.stores).send({ name })
    expect(response.status).toBe(201)
    return response.body as StoreBody
  }

  // The audit log is written after the answer: wait for the entry instead of guessing a delay
  async function auditEntry(action: string, resourceId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entry = await owner.auditLog.findFirst({ where: { action, resourceId } })
      if (entry !== null) return entry
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return null
  }

  describe('the organization', () => {
    it('is read from the store of the request', async () => {
      const response = await asAdmin().get(ApiRoutes.organizations.current)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({ id: ctx.orgA.id, name: `${prefix}-a`, slug: `${prefix}-a` })
    })

    it('is renamed, the slug stays, and the change is audited', async () => {
      const response = await asAdmin()
        .patch(ApiRoutes.organizations.current)
        .send({ name: `${prefix}-a renamed` })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ name: `${prefix}-a renamed`, slug: `${prefix}-a` })
      const entry = await auditEntry(AuditAction.ORGANIZATION_UPDATED, ctx.orgA.id)
      expect(entry).toMatchObject({ userId: ctx.adminA.id, organizationId: ctx.orgA.id })
    })

    it.each([
      ['a slug', { name: 'x', slug: 'other' }],
      ['an empty name', { name: '   ' }],
      ['no name', {}]
    ])('refuses a body with %s', async (_label, body) => {
      const response = await asAdmin().patch(ApiRoutes.organizations.current).send(body)

      expect(response.status).toBe(400)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('is not read or changed by a member without the permission', async () => {
      const viewer = api(app, ctx.viewerA, ctx.storeA)

      const read = await viewer.get(ApiRoutes.organizations.current)
      const change = await viewer.patch(ApiRoutes.organizations.current).send({ name: 'x' })

      expect(read.status).toBe(403)
      expect(change.status).toBe(403)
      expect((change.body as ErrorBody).error.code).toBe(ErrorCodes.PERMISSION_DENIED)
    })
  })

  describe('listing the stores', () => {
    it('lists the stores the caller manages: not the siblings they are not in, nor other organizations', async () => {
      const response = await asAdmin().get(ApiRoutes.organizations.stores)

      expect(response.status).toBe(200)
      const ids = (response.body as StoreBody[]).map(store => store.id)
      expect(ids).toContain(ctx.storeA.id)
      expect(ids).not.toContain(ctx.storeA2.id)
      expect(ids).not.toContain(ctx.storeB.id)
    })

    it('lists a sibling to someone who is an Admin of it too', async () => {
      const both = await createActor(owner, app, {
        prefix,
        name: next('both'),
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      await ensureMembership(owner, {
        userId: both.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })

      const response = await api(app, both, ctx.storeA).get(ApiRoutes.organizations.stores)

      expect((response.body as StoreBody[]).map(store => store.id)).toEqual(
        expect.arrayContaining([ctx.storeA.id, ctx.storeA2.id])
      )
    })

    it('is refused to a member without the permission', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.organizations.stores)

      expect(response.status).toBe(403)
    })
  })

  describe('creating a store', () => {
    it('creates it with the defaults, its settings rows and its creator as Admin', async () => {
      const name = nextName()

      const response = await asAdmin().post(ApiRoutes.organizations.stores).send({ name })

      expect(response.status).toBe(201)
      const store = response.body as StoreBody
      expect(store).toMatchObject({
        name,
        slug: name.toLowerCase(),
        timezone: 'America/El_Salvador',
        currency: 'USD',
        defaultLocale: 'es'
      })
      const row = await owner.store.findUniqueOrThrow({
        where: { id: store.id },
        include: {
          settings: true,
          retentionSettings: true,
          memberships: { include: { role: true } }
        }
      })
      expect(row.organizationId).toBe(ctx.orgA.id)
      expect(row.settings).not.toBeNull()
      expect(row.retentionSettings).not.toBeNull()
      expect(row.memberships).toHaveLength(1)
      expect(row.memberships[0]).toMatchObject({ userId: ctx.adminA.id, status: 'ACTIVE' })
      expect(row.memberships[0]?.role.name).toBe(RoleNames.ADMIN)
      expect(await auditEntry(AuditAction.STORE_CREATED, store.id)).not.toBeNull()
    })

    it('can be worked in at once by its creator', async () => {
      const store = await createStore()

      const response = await api(app, ctx.adminA, store).get(ApiRoutes.organizations.current)

      expect(response.status).toBe(200)
    })

    it('takes the timezone, currency and locale it is given', async () => {
      const response = await asAdmin().post(ApiRoutes.organizations.stores).send({
        name: nextName(),
        timezone: 'America/Mexico_City',
        currency: 'MXN',
        defaultLocale: 'en'
      })

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({
        timezone: 'America/Mexico_City',
        currency: 'MXN',
        defaultLocale: 'en'
      })
    })

    it('refuses a second store with the same name', async () => {
      const name = nextName()
      await createStore(name)

      const response = await asAdmin().post(ApiRoutes.organizations.stores).send({ name })

      expect(response.status).toBe(409)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.RESOURCE_ALREADY_EXISTS)
    })

    it.each([
      ['a name with no letter or digit', { name: '¡¿?!' }],
      ['a timezone that does not exist', { name: 'ok', timezone: 'Mars/Olympus' }],
      ['a currency that is not a code', { name: 'ok', currency: 'dollars' }],
      ['a locale that is not supported', { name: 'ok', defaultLocale: 'xx' }],
      ['an organization in the body', { name: 'ok', organizationId: randomUUID() }]
    ])('refuses %s', async (_label, body) => {
      const response = await asAdmin().post(ApiRoutes.organizations.stores).send(body)

      expect(response.status).toBe(400)
    })

    it('does not make an Admin of someone who is not one', async () => {
      const roleId = await roleWith(ctx.storeA.id, [Permissions.ORG_MANAGE_STORES])
      const manager = await createActor(owner, app, {
        prefix,
        name: next('storekeeper'),
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId
      })
      const name = nextName()

      const response = await api(app, manager, ctx.storeA)
        .post(ApiRoutes.organizations.stores)
        .send({ name })

      expect(response.status).toBe(403)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(await owner.store.findFirst({ where: { name } })).toBeNull()
    })

    it('is refused to a member without the permission', async () => {
      const response = await api(app, ctx.agentA, ctx.storeA)
        .post(ApiRoutes.organizations.stores)
        .send({ name: nextName() })

      expect(response.status).toBe(403)
    })
  })

  describe('reading and changing a store', () => {
    it('reads a store the caller manages', async () => {
      const store = await createStore()

      const response = await asAdmin().get(ApiRoutes.organizations.storeById(store.id))

      expect(response.status).toBe(200)
      expect((response.body as StoreBody).id).toBe(store.id)
    })

    it('does not read, change or delete a sibling store the caller does not belong to', async () => {
      const url = ApiRoutes.organizations.storeById(ctx.storeA2.id)

      const read = await asAdmin().get(url)
      const change = await asAdmin().patch(url).send({ name: 'hacked' })
      const remove = await asAdmin().delete(url)

      expect([read.status, change.status, remove.status]).toEqual([404, 404, 404])
      const untouched = await owner.store.findUniqueOrThrow({ where: { id: ctx.storeA2.id } })
      expect(untouched.name).not.toBe('hacked')
    })

    it('does not let a role that only manages stores in one store reach another where it has none', async () => {
      const own = await roleWith(ctx.storeA2.id, [Permissions.ORG_MANAGE_STORES])
      const mixed = await createActor(owner, app, {
        prefix,
        name: next('mixed'),
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: own
      })
      await ensureMembership(owner, {
        userId: mixed.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.VIEWER]
      })

      const here = await api(app, mixed, ctx.storeA2).get(
        ApiRoutes.organizations.storeById(ctx.storeA2.id)
      )
      const there = await api(app, mixed, ctx.storeA2).get(
        ApiRoutes.organizations.storeById(ctx.storeA.id)
      )

      expect([here.status, there.status]).toEqual([200, 404])
    })

    it('changes the fields it is given and not the slug', async () => {
      const store = await createStore()

      const response = await asAdmin()
        .patch(ApiRoutes.organizations.storeById(store.id))
        .send({ name: `${store.name} renamed`, currency: 'EUR' })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        name: `${store.name} renamed`,
        currency: 'EUR',
        slug: store.slug,
        timezone: store.timezone
      })
      expect(await auditEntry(AuditAction.STORE_UPDATED, store.id)).toMatchObject({
        metadata: { fields: ['name', 'currency'] }
      })
    })

    it('is seen at once by the guards, not after the cache expires', async () => {
      const store = await createStore()
      const tenants = app.get(TenantContextService, { strict: false })
      expect((await tenants.resolve(ctx.adminA.id, store.id))?.store.name).toBe(store.name)

      await asAdmin()
        .patch(ApiRoutes.organizations.storeById(store.id))
        .send({ name: `${store.name} renamed` })

      expect((await tenants.resolve(ctx.adminA.id, store.id))?.store.name).toBe(
        `${store.name} renamed`
      )
    })

    it.each([
      ['an empty body', {}],
      ['a slug', { slug: 'other' }],
      ['an organization', { organizationId: randomUUID() }]
    ])('refuses %s', async (_label, body) => {
      const response = await asAdmin()
        .patch(ApiRoutes.organizations.storeById(ctx.storeA2.id))
        .send(body)

      expect(response.status).toBe(400)
    })

    it('answers 404 to an id that is not a store of the organization', async () => {
      const unknown = await asAdmin().get(ApiRoutes.organizations.storeById(randomUUID()))
      const notAnId = await asAdmin().get(ApiRoutes.organizations.storeById('not-an-id'))

      expect(unknown.status).toBe(404)
      expect(notAnId.status).toBe(400)
    })
  })

  describe('deleting a store', () => {
    it('deletes an empty store, with its members, and drops what the guards knew of it', async () => {
      const store = await createStore()
      const tenants = app.get(TenantContextService, { strict: false })
      expect(await tenants.resolve(ctx.adminA.id, store.id)).not.toBeNull()

      const response = await asAdmin().delete(ApiRoutes.organizations.storeById(store.id))

      expect(response.status).toBe(NO_CONTENT)
      expect(await owner.store.findUnique({ where: { id: store.id } })).toBeNull()
      expect(await owner.membership.count({ where: { storeId: store.id } })).toBe(0)
      expect(await tenants.resolve(ctx.adminA.id, store.id)).toBeNull()
      expect(await auditEntry(AuditAction.STORE_DELETED, store.id)).not.toBeNull()
    })

    it('keeps a store that holds data, and says where', async () => {
      const store = await createStore()
      await createTag(owner, { storeId: store.id })

      const response = await asAdmin().delete(ApiRoutes.organizations.storeById(store.id))

      expect(response.status).toBe(409)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect((response.body as ErrorBody).error.metadata?.tables).toEqual(['tags'])
      expect(await owner.store.findUnique({ where: { id: store.id } })).not.toBeNull()
    })

    it('keeps the last store of an organization', async () => {
      const response = await api(app, ctx.adminB, ctx.storeB).delete(
        ApiRoutes.organizations.storeById(ctx.storeB.id)
      )

      expect(response.status).toBe(409)
      expect(await owner.store.findUnique({ where: { id: ctx.storeB.id } })).not.toBeNull()
    })

    it('keeps one store when the last two are deleted at the same moment', async () => {
      const organization = await owner.organization.create({
        data: { name: `${prefix}-pair`, slug: `${prefix}-pair` }
      })
      const first = await ensureStore(owner, organization.id, `${prefix}-pair-1`)
      const second = await ensureStore(owner, organization.id, `${prefix}-pair-2`)
      const admin = await createActor(owner, app, {
        prefix,
        name: 'pairAdmin',
        organizationId: organization.id,
        storeId: first.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      await ensureMembership(owner, {
        userId: admin.id,
        organizationId: organization.id,
        storeId: second.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      const remove = (id: string) =>
        api(app, admin, first).delete(ApiRoutes.organizations.storeById(id))

      const statuses = await Promise.all([remove(first.id), remove(second.id)]).then(answers =>
        answers.map(answer => answer.status)
      )

      expect(statuses.sort()).toEqual([204, 409])
      expect(await owner.store.count({ where: { organizationId: organization.id } })).toBe(1)
    })

    it('is refused to a member without the permission', async () => {
      const response = await api(app, ctx.agentA, ctx.storeA).delete(
        ApiRoutes.organizations.storeById(ctx.storeA2.id)
      )

      expect(response.status).toBe(403)
    })
  })

  describe('another organization', () => {
    it('has stores that cannot be read, changed or deleted', async () => {
      const read = await asAdmin().get(ApiRoutes.organizations.storeById(ctx.storeB.id))
      const change = await asAdmin()
        .patch(ApiRoutes.organizations.storeById(ctx.storeB.id))
        .send({ name: 'hacked' })
      const remove = await asAdmin().delete(ApiRoutes.organizations.storeById(ctx.storeB.id))

      expect([read.status, change.status, remove.status]).toEqual([404, 404, 404])
      const untouched = await owner.store.findUniqueOrThrow({ where: { id: ctx.storeB.id } })
      expect(untouched.name).not.toBe('hacked')
    })
  })
})
