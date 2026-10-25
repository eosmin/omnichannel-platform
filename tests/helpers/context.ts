import type { INestApplication } from '@nestjs/common'

import { type RoleName, RoleNames } from '@platform/core/auth'
import {
  ensureMembership,
  ensureStore,
  ensureSystemRoles,
  ensureUser,
  type OwnerClient
} from '@platform/core/database-testing'

import { SessionService } from '../../apps/api/src/modules/auth/session.service'

import type { Actor, StoreRef } from './http'

// The standard shape of the suites (TDD_13 section 3, trimmed for the MVP: no staff):
//
//   organization A    store A       adminA, agentA, viewerA
//                     store A2      adminA2        <- a sibling store of the same organization
//   organization B    store B       adminB
//
// Nobody is a member of more than one store, so each attack below is an attack and not a feature.
export interface TestContext {
  orgA: { id: string }
  orgB: { id: string }
  storeA: StoreRef
  storeA2: StoreRef
  storeB: StoreRef
  adminA: Actor
  agentA: Actor
  viewerA: Actor
  adminA2: Actor
  adminB: Actor
  // The system roles, by name
  roleIds: Record<RoleName, string>
}

// One more member of a store, with a real token. Used by the specs that need a user a context does
// not have (a manager with a custom role, a second Admin).
export async function createActor(
  owner: OwnerClient,
  app: INestApplication,
  input: {
    prefix: string
    name: string
    organizationId: string
    storeId: string
    roleId: string
  }
): Promise<Actor> {
  const email = `${input.prefix}-${input.name}@example.com`
  const user = await ensureUser(owner, email, input.name)
  await ensureMembership(owner, {
    userId: user.id,
    organizationId: input.organizationId,
    storeId: input.storeId,
    roleId: input.roleId
  })
  // A real access token, issued by the same service that logs people in
  const { accessToken } = await app.get(SessionService, { strict: false }).issue({
    id: user.id,
    email
  })
  return { id: user.id, email, token: accessToken }
}

// The roles are the system roles of the owner bootstrap, with the permissions of RolePresets: the
// same ones the real app has, not a copy that could drift from them
export async function seedTestContext(
  owner: OwnerClient,
  app: INestApplication,
  prefix: string
): Promise<TestContext> {
  const roles = await ensureSystemRoles(owner)

  const orgA = await owner.organization.create({
    data: { name: `${prefix}-a`, slug: `${prefix}-a` }
  })
  const orgB = await owner.organization.create({
    data: { name: `${prefix}-b`, slug: `${prefix}-b` }
  })
  const storeA = await ensureStore(owner, orgA.id, `${prefix}-store-a`)
  const storeA2 = await ensureStore(owner, orgA.id, `${prefix}-store-a2`)
  const storeB = await ensureStore(owner, orgB.id, `${prefix}-store-b`)

  const actor = (
    name: string,
    organizationId: string,
    storeId: string,
    role: keyof typeof RoleNames
  ): Promise<Actor> =>
    createActor(owner, app, {
      prefix,
      name,
      organizationId,
      storeId,
      roleId: roles[RoleNames[role]].id
    })

  return {
    roleIds: {
      [RoleNames.ADMIN]: roles[RoleNames.ADMIN].id,
      [RoleNames.SUPERVISOR]: roles[RoleNames.SUPERVISOR].id,
      [RoleNames.AGENT]: roles[RoleNames.AGENT].id,
      [RoleNames.VIEWER]: roles[RoleNames.VIEWER].id
    },
    orgA,
    orgB,
    storeA,
    storeA2,
    storeB,
    adminA: await actor('adminA', orgA.id, storeA.id, 'ADMIN'),
    agentA: await actor('agentA', orgA.id, storeA.id, 'AGENT'),
    viewerA: await actor('viewerA', orgA.id, storeA.id, 'VIEWER'),
    adminA2: await actor('adminA2', orgA.id, storeA2.id, 'ADMIN'),
    adminB: await actor('adminB', orgB.id, storeB.id, 'ADMIN')
  }
}
