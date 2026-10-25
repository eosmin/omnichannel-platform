import { randomUUID } from 'node:crypto'

import { type Permission, Permissions, RoleNames } from '@platform/core/auth'
import {
  ensureMembership,
  ensureSystemRoles,
  ensureUser,
  type OwnerClient
} from '@platform/core/database-testing'

// A member of the store with a user of their own. The email carries the prefix of the run, so that
// the clean-up of the run removes the user (the membership goes with the store).
export async function createMember(
  owner: OwnerClient,
  input: { storeId: string; prefix: string }
): Promise<{ id: string; roleId: string }> {
  const store = await owner.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { organizationId: true }
  })
  const roles = await ensureSystemRoles(owner)
  const email = `${input.prefix}-member-${randomUUID().slice(0, 8)}@example.com`
  const user = await ensureUser(owner, email, 'Member')
  const roleId = roles[RoleNames.AGENT].id
  await ensureMembership(owner, {
    userId: user.id,
    organizationId: store.organizationId,
    storeId: input.storeId,
    roleId
  })
  const membership = await owner.membership.findFirstOrThrow({
    where: { userId: user.id, storeId: input.storeId },
    select: { id: true }
  })
  return { id: membership.id, roleId }
}

// A custom role of the store; it holds team:view unless the permissions are given
export async function createRole(
  owner: OwnerClient,
  input: { storeId: string; name?: string; permissions?: readonly Permission[] }
): Promise<{ id: string }> {
  return owner.role.create({
    data: {
      storeId: input.storeId,
      name: input.name ?? `role-${randomUUID().slice(0, 8)}`,
      permissions: {
        create: (input.permissions ?? [Permissions.TEAM_VIEW]).map(name => ({ name }))
      }
    },
    select: { id: true }
  })
}

// A pending invitation to the store. The address carries the prefix of the run, as the users do.
export async function createInvitation(
  owner: OwnerClient,
  input: { storeId: string; prefix: string }
): Promise<{ id: string }> {
  const store = await owner.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { organizationId: true }
  })
  const roles = await ensureSystemRoles(owner)
  const inviter = await ensureUser(owner, `${input.prefix}-inviter@example.com`, 'Inviter')
  return owner.invitation.create({
    data: {
      organizationId: store.organizationId,
      storeId: input.storeId,
      email: `${input.prefix}-invitee-${randomUUID().slice(0, 8)}@example.com`,
      roleId: roles[RoleNames.AGENT].id,
      tokenHash: randomUUID(),
      invitedById: inviter.id,
      expiresAt: new Date(Date.now() + 86_400_000)
    },
    select: { id: true }
  })
}
