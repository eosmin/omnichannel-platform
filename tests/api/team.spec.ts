import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { type Permission, Permissions, RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import { TenantContextService } from '../../apps/api/src/modules/tenancy'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: { permissions?: string[] } }
}
interface MemberBody {
  id: string
  userId: string
  email: string
  role: { id: string; name: string }
}
interface RoleBody {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: string[]
}

const NO_CONTENT = 204

describe('The team of a store', () => {
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
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const tenants = () => app.get(TenantContextService, { strict: false })

  // A custom role of a store, written as the owner
  async function roleWith(storeId: string, permissions: Permission[]): Promise<string> {
    const role = await owner.role.create({
      data: {
        storeId,
        name: `${prefix}-${next('role')}`,
        permissions: { create: permissions.map(name => ({ name })) }
      }
    })
    return role.id
  }

  async function member(roleId: string, store = { id: ctx.storeA.id, org: ctx.orgA.id }) {
    const actor = await createActor(owner, app, {
      prefix,
      name: next('member'),
      organizationId: store.org,
      storeId: store.id,
      roleId
    })
    const membership = await owner.membership.findFirstOrThrow({
      where: { userId: actor.id, storeId: store.id }
    })
    return { actor, membershipId: membership.id }
  }

  // The manager may manage roles and remove members, and nothing else of the team
  async function manager() {
    const roleId = await roleWith(ctx.storeA.id, [
      Permissions.TEAM_VIEW,
      Permissions.TEAM_MANAGE_ROLES,
      Permissions.TEAM_REMOVE
    ])
    return member(roleId)
  }

  async function auditEntry(action: string, resourceId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entry = await owner.auditLog.findFirst({ where: { action, resourceId } })
      if (entry !== null) return entry
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return null
  }

  const roleNameOf = async (actor: Actor, storeId = ctx.storeA.id): Promise<string | undefined> =>
    (await tenants().resolve(actor.id, storeId))?.membership.roleName

  describe('the members', () => {
    it('are the active ones of the store and no others', async () => {
      const response = await asAdmin().get(ApiRoutes.settings.members)

      expect(response.status).toBe(200)
      const emails = (response.body as MemberBody[]).map(row => row.email)
      expect(emails).toEqual(
        expect.arrayContaining([ctx.adminA.email, ctx.agentA.email, ctx.viewerA.email])
      )
      expect(emails).not.toContain(ctx.adminA2.email)
      expect(emails).not.toContain(ctx.adminB.email)
    })

    it('are listed only to those who may see the team', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.settings.members)

      expect(response.status).toBe(403)
    })

    it('are no longer listed once removed', async () => {
      const { membershipId, actor } = await member(ctx.roleIds[RoleNames.AGENT])
      await asAdmin().delete(ApiRoutes.settings.memberById(membershipId))

      const response = await asAdmin().get(ApiRoutes.settings.members)

      expect((response.body as MemberBody[]).map(row => row.email)).not.toContain(actor.email)
    })
  })

  describe('the directory of members', () => {
    interface DirectoryBody {
      id: string
      name: string
      avatarMediaId: string | null
      role: { id: string; name: string }
    }

    it('names the active members to an agent who may not see the team', async () => {
      const response = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.members.directory)

      expect(response.status).toBe(200)
      const ids = (response.body as DirectoryBody[]).map(row => row.id)
      expect(ids).toEqual(expect.arrayContaining([ctx.adminA.id, ctx.agentA.id]))
      expect(ids).not.toContain(ctx.adminA2.id)
      expect(ids).not.toContain(ctx.adminB.id)
    })

    it('carries only the id, name, avatar and role: never an email or a permission', async () => {
      const response = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.members.directory)

      for (const row of response.body as DirectoryBody[]) {
        expect(Object.keys(row).sort()).toEqual(['avatarMediaId', 'id', 'name', 'role'])
        expect(Object.keys(row.role).sort()).toEqual(['id', 'name'])
      }
      expect(JSON.stringify(response.body)).not.toContain(ctx.agentA.email)
    })

    it('leaves out a member once removed', async () => {
      const { membershipId, actor } = await member(ctx.roleIds[RoleNames.AGENT])
      await asAdmin().delete(ApiRoutes.settings.memberById(membershipId))

      const response = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.members.directory)

      expect((response.body as DirectoryBody[]).map(row => row.id)).not.toContain(actor.id)
    })

    it('is refused to a role that cannot see conversations', async () => {
      const roleId = await roleWith(ctx.storeA.id, [Permissions.TEAM_VIEW])
      const { actor } = await member(roleId)

      const response = await api(app, actor, ctx.storeA).get(ApiRoutes.members.directory)

      expect(response.status).toBe(403)
    })
  })

  describe('changing the role of a member', () => {
    it('gives the new role at once, not after the cache expires, and audits it', async () => {
      const { actor, membershipId } = await member(ctx.roleIds[RoleNames.AGENT])
      expect(await roleNameOf(actor)).toBe(RoleNames.AGENT)

      const response = await asAdmin()
        .patch(ApiRoutes.settings.memberById(membershipId))
        .send({ roleId: ctx.roleIds[RoleNames.SUPERVISOR] })

      expect(response.status).toBe(200)
      expect((response.body as MemberBody).role.name).toBe(RoleNames.SUPERVISOR)
      expect(await roleNameOf(actor)).toBe(RoleNames.SUPERVISOR)
      expect(await auditEntry(AuditAction.ROLE_CHANGED, membershipId)).toMatchObject({
        userId: ctx.adminA.id,
        storeId: ctx.storeA.id
      })
    })

    it('changes nothing, and writes nothing, when the member already has the role', async () => {
      const { membershipId } = await member(ctx.roleIds[RoleNames.AGENT])

      const response = await asAdmin()
        .patch(ApiRoutes.settings.memberById(membershipId))
        .send({ roleId: ctx.roleIds[RoleNames.AGENT] })

      expect(response.status).toBe(200)
      expect(await owner.auditLog.count({ where: { resourceId: membershipId } })).toBe(0)
    })

    it('does not accept a role of another store', async () => {
      const foreignRole = await roleWith(ctx.storeB.id, [Permissions.TEAM_VIEW])
      const { membershipId } = await member(ctx.roleIds[RoleNames.AGENT])

      const response = await asAdmin()
        .patch(ApiRoutes.settings.memberById(membershipId))
        .send({ roleId: foreignRole })

      expect(response.status).toBe(404)
    })

    it('does not grant a role that holds what the caller lacks', async () => {
      const boss = await manager()
      const { membershipId } = await member(ctx.roleIds[RoleNames.AGENT])

      const response = await api(app, boss.actor, ctx.storeA)
        .patch(ApiRoutes.settings.memberById(membershipId))
        .send({ roleId: ctx.roleIds[RoleNames.ADMIN] })

      expect(response.status).toBe(403)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.PERMISSION_DENIED)
      expect((response.body as ErrorBody).error.metadata?.permissions?.length).toBeGreaterThan(0)
    })

    it('does not touch a member who can do more than the caller', async () => {
      const boss = await manager()
      const admin = await member(ctx.roleIds[RoleNames.ADMIN])

      const response = await api(app, boss.actor, ctx.storeA)
        .patch(ApiRoutes.settings.memberById(admin.membershipId))
        .send({ roleId: ctx.roleIds[RoleNames.VIEWER] })

      expect(response.status).toBe(403)
      expect(await roleNameOf(admin.actor)).toBe(RoleNames.ADMIN)
    })

    it('keeps the last Admin of the store', async () => {
      const onlyAdmin = await owner.membership.findFirstOrThrow({
        where: { userId: ctx.adminA2.id, storeId: ctx.storeA2.id }
      })

      const response = await api(app, ctx.adminA2, ctx.storeA2)
        .patch(ApiRoutes.settings.memberById(onlyAdmin.id))
        .send({ roleId: ctx.roleIds[RoleNames.VIEWER] })

      expect(response.status).toBe(409)
      expect((response.body as ErrorBody).error.code).toBe(
        ErrorCodes.TENANT_CANNOT_REMOVE_LAST_ADMIN
      )
    })

    it('does not leave a store without an Admin when two Admins lower each other at once', async () => {
      const store = await owner.store.create({
        data: {
          organizationId: ctx.orgA.id,
          name: next('twins'),
          slug: `${prefix}-${next('twins')}`
        }
      })
      const target = { id: store.id, org: ctx.orgA.id }
      const first = await member(ctx.roleIds[RoleNames.ADMIN], target)
      const second = await member(ctx.roleIds[RoleNames.ADMIN], target)
      const lower = (by: Actor, membershipId: string) =>
        api(app, by, store)
          .patch(ApiRoutes.settings.memberById(membershipId))
          .send({ roleId: ctx.roleIds[RoleNames.VIEWER] })

      const statuses = await Promise.all([
        lower(first.actor, second.membershipId),
        lower(second.actor, first.membershipId)
      ]).then(responses => responses.map(response => response.status))

      expect(statuses.sort()).toEqual([200, 409])
      const admins = await owner.membership.count({
        where: { storeId: store.id, roleId: ctx.roleIds[RoleNames.ADMIN] }
      })
      expect(admins).toBe(1)
    })

    it.each([
      ['no role', {}],
      ['a role that is not an id', { roleId: 'admin' }],
      ['another field', { roleId: randomUUID(), storeId: randomUUID() }]
    ])('refuses a body with %s', async (_label, body) => {
      const response = await asAdmin().patch(ApiRoutes.settings.memberById(randomUUID())).send(body)

      expect(response.status).toBe(400)
    })

    it('does not reach a member of another store', async () => {
      const elsewhere = await owner.membership.findFirstOrThrow({
        where: { userId: ctx.adminA2.id, storeId: ctx.storeA2.id }
      })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.memberById(elsewhere.id))
        .send({ roleId: ctx.roleIds[RoleNames.VIEWER] })

      expect(response.status).toBe(404)
      expect(await roleNameOf(ctx.adminA2, ctx.storeA2.id)).toBe(RoleNames.ADMIN)
    })
  })

  describe('removing a member', () => {
    it('ends their access at once, keeps the record, and audits it', async () => {
      const { actor, membershipId } = await member(ctx.roleIds[RoleNames.AGENT])
      expect(await tenants().resolve(actor.id, ctx.storeA.id)).not.toBeNull()

      const response = await asAdmin().delete(ApiRoutes.settings.memberById(membershipId))

      expect(response.status).toBe(NO_CONTENT)
      expect(await tenants().resolve(actor.id, ctx.storeA.id)).toBeNull()
      const afterwards = await api(app, actor, ctx.storeA).get(ApiRoutes.organizations.current)
      expect(afterwards.status).toBe(403)
      const row = await owner.membership.findUniqueOrThrow({ where: { id: membershipId } })
      expect(row.status).toBe('REVOKED')
      expect(row.revokedAt).not.toBeNull()
      expect(await auditEntry(AuditAction.MEMBER_REMOVED, membershipId)).not.toBeNull()
    })

    it('answers 404 when the member was already removed', async () => {
      const { membershipId } = await member(ctx.roleIds[RoleNames.AGENT])
      await asAdmin().delete(ApiRoutes.settings.memberById(membershipId))

      const response = await asAdmin().delete(ApiRoutes.settings.memberById(membershipId))

      expect(response.status).toBe(404)
    })

    it('keeps the last Admin of the store', async () => {
      const onlyAdmin = await owner.membership.findFirstOrThrow({
        where: { userId: ctx.adminA2.id, storeId: ctx.storeA2.id }
      })

      const response = await api(app, ctx.adminA2, ctx.storeA2).delete(
        ApiRoutes.settings.memberById(onlyAdmin.id)
      )

      expect(response.status).toBe(409)
      expect(await roleNameOf(ctx.adminA2, ctx.storeA2.id)).toBe(RoleNames.ADMIN)
    })

    it('does not remove a member who can do more than the caller', async () => {
      const boss = await manager()
      const admin = await member(ctx.roleIds[RoleNames.ADMIN])

      const response = await api(app, boss.actor, ctx.storeA).delete(
        ApiRoutes.settings.memberById(admin.membershipId)
      )

      expect(response.status).toBe(403)
      expect(await roleNameOf(admin.actor)).toBe(RoleNames.ADMIN)
    })

    it('is refused to a member without the permission', async () => {
      const { membershipId } = await member(ctx.roleIds[RoleNames.AGENT])

      const response = await api(app, ctx.agentA, ctx.storeA).delete(
        ApiRoutes.settings.memberById(membershipId)
      )

      expect(response.status).toBe(403)
    })
  })

  describe('the roles', () => {
    it('are the system ones and the custom ones of the store, and no other store’s', async () => {
      const mine = await roleWith(ctx.storeA.id, [Permissions.TEAM_VIEW])
      const foreign = await roleWith(ctx.storeB.id, [Permissions.TEAM_VIEW])

      const response = await asAdmin().get(ApiRoutes.settings.roles)

      expect(response.status).toBe(200)
      const roles = response.body as RoleBody[]
      expect(
        roles
          .filter(role => role.isSystem)
          .map(role => role.name)
          .sort()
      ).toEqual(Object.values(RoleNames).sort())
      const ids = roles.map(role => role.id)
      expect(ids).toContain(mine)
      expect(ids).not.toContain(foreign)
    })

    it('are created with the permissions asked for, once each, and audited', async () => {
      const response = await asAdmin()
        .post(ApiRoutes.settings.roles)
        .send({
          name: `${prefix}-support`,
          description: 'Answers the inbox',
          permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_VIEW]
        })

      expect(response.status).toBe(201)
      const role = response.body as RoleBody
      expect(role).toMatchObject({
        name: `${prefix}-support`,
        description: 'Answers the inbox',
        isSystem: false,
        permissions: [Permissions.CONVERSATIONS_VIEW]
      })
      expect(await owner.role.findUniqueOrThrow({ where: { id: role.id } })).toMatchObject({
        storeId: ctx.storeA.id
      })
      expect(await auditEntry(AuditAction.ROLE_CREATED, role.id)).not.toBeNull()
    })

    it.each([
      ['the name of a system role, whatever the case', { name: 'admin', permissions: [] }],
      ['a permission that does not exist', { name: 'x1', permissions: ['everything:all'] }],
      ['no permissions list', { name: 'x2' }],
      ['an empty name', { name: ' ', permissions: [] }],
      ['another store in the body', { name: 'x3', permissions: [], storeId: randomUUID() }]
    ])('are refused with %s', async (_label, body) => {
      const response = await asAdmin().post(ApiRoutes.settings.roles).send(body)

      expect([400, 409]).toContain(response.status)
    })

    it('are refused when a role of that name exists in the store', async () => {
      const name = `${prefix}-${next('dup')}`
      await asAdmin().post(ApiRoutes.settings.roles).send({ name, permissions: [] })

      const response = await asAdmin()
        .post(ApiRoutes.settings.roles)
        .send({ name: name.toUpperCase(), permissions: [] })

      expect(response.status).toBe(409)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.RESOURCE_ALREADY_EXISTS)
    })

    it('are created once when two requests ask for the same name at the same moment', async () => {
      const name = `${prefix}-${next('race')}`
      const create = () => asAdmin().post(ApiRoutes.settings.roles).send({ name, permissions: [] })

      const statuses = await Promise.all([create(), create()]).then(answers =>
        answers.map(answer => answer.status)
      )

      expect(statuses.sort()).toEqual([201, 409])
      expect(await owner.role.count({ where: { storeId: ctx.storeA.id, name } })).toBe(1)
    })

    it('are not given permissions their creator lacks', async () => {
      const boss = await manager()

      const response = await api(app, boss.actor, ctx.storeA)
        .post(ApiRoutes.settings.roles)
        .send({ name: `${prefix}-${next('over')}`, permissions: [Permissions.ORDERS_CANCEL] })

      expect(response.status).toBe(403)
    })

    it('change what their members may do at once, not after the cache expires', async () => {
      const roleId = await roleWith(ctx.storeA.id, [Permissions.TEAM_VIEW])
      const holder = await member(roleId)
      const before = await tenants().resolve(holder.actor.id, ctx.storeA.id)
      expect(before?.permissions).toEqual([Permissions.TEAM_VIEW])

      const response = await asAdmin()
        .patch(ApiRoutes.settings.roleById(roleId))
        .send({ permissions: [Permissions.TEAM_VIEW, Permissions.ANALYTICS_VIEW] })

      expect(response.status).toBe(200)
      const after = await tenants().resolve(holder.actor.id, ctx.storeA.id)
      expect(after?.permissions.sort()).toEqual(
        [Permissions.ANALYTICS_VIEW, Permissions.TEAM_VIEW].sort()
      )
      expect(await auditEntry(AuditAction.ROLE_UPDATED, roleId)).toMatchObject({
        metadata: { added: [Permissions.ANALYTICS_VIEW], removed: [] }
      })
    })

    it('are renamed, and a description can be cleared', async () => {
      const created = await asAdmin()
        .post(ApiRoutes.settings.roles)
        .send({ name: `${prefix}-${next('old')}`, description: 'x', permissions: [] })
      const id = (created.body as RoleBody).id

      const response = await asAdmin()
        .patch(ApiRoutes.settings.roleById(id))
        .send({ name: `${prefix}-${next('new')}`, description: null })

      expect(response.status).toBe(200)
      expect((response.body as RoleBody).description).toBeNull()
    })

    it('are not edited by someone who lacks what the role holds', async () => {
      const boss = await manager()
      const strong = await roleWith(ctx.storeA.id, [Permissions.ORDERS_CANCEL])

      const response = await api(app, boss.actor, ctx.storeA)
        .patch(ApiRoutes.settings.roleById(strong))
        .send({ permissions: [] })

      expect(response.status).toBe(403)
    })

    it('are not edited when they are system roles', async () => {
      const response = await asAdmin()
        .patch(ApiRoutes.settings.roleById(ctx.roleIds[RoleNames.VIEWER]))
        .send({ name: 'Viewers' })

      expect(response.status).toBe(409)
    })

    it('are not reached in another store', async () => {
      const foreign = await roleWith(ctx.storeB.id, [Permissions.TEAM_VIEW])

      const change = await asAdmin()
        .patch(ApiRoutes.settings.roleById(foreign))
        .send({ name: 'hacked' })
      const remove = await asAdmin().delete(ApiRoutes.settings.roleById(foreign))

      expect([change.status, remove.status]).toEqual([404, 404])
      expect(await owner.role.findUniqueOrThrow({ where: { id: foreign } })).not.toMatchObject({
        name: 'hacked'
      })
    })

    it('are deleted when nobody holds them, and audited', async () => {
      const roleId = await roleWith(ctx.storeA.id, [Permissions.TEAM_VIEW])

      const response = await asAdmin().delete(ApiRoutes.settings.roleById(roleId))

      expect(response.status).toBe(NO_CONTENT)
      expect(await owner.role.findUnique({ where: { id: roleId } })).toBeNull()
      expect(await auditEntry(AuditAction.ROLE_DELETED, roleId)).not.toBeNull()
    })

    it('are kept while a member holds them', async () => {
      const roleId = await roleWith(ctx.storeA.id, [Permissions.TEAM_VIEW])
      await member(roleId)

      const response = await asAdmin().delete(ApiRoutes.settings.roleById(roleId))

      expect(response.status).toBe(409)
      expect(await owner.role.findUnique({ where: { id: roleId } })).not.toBeNull()
    })

    it('are not deleted when they are system roles', async () => {
      const response = await asAdmin().delete(
        ApiRoutes.settings.roleById(ctx.roleIds[RoleNames.AGENT])
      )

      expect(response.status).toBe(409)
    })

    it('are managed only by those who may', async () => {
      const agent = api(app, ctx.agentA, ctx.storeA)

      const create = await agent.post(ApiRoutes.settings.roles).send({ name: 'x', permissions: [] })
      const remove = await agent.delete(ApiRoutes.settings.roleById(randomUUID()))

      expect([create.status, remove.status]).toEqual([403, 403])
    })
  })
})
