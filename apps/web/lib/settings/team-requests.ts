import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import { MembershipStatus } from '@platform/core/domain'

// Settings → Team: what the api answers about the members, roles and invitations of a store. Kept with
// the page and not in `@platform/api-client`, whose barrel the inbox loads whole.

const roleRefSchema = z.object({ id: z.string(), name: z.string() })

const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: roleRefSchema,
  joinedAt: z.string(),
  // The list holds active and suspended members; a revoked one is not on the team
  status: z.enum([MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED])
})
export type MemberView = z.output<typeof memberSchema>

const roleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string())
})
export type RoleView = z.output<typeof roleSchema>

const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleRefSchema,
  invitedBy: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  expired: z.boolean()
})
export type InvitationView = z.output<typeof invitationSchema>

export interface RoleInput {
  name: string
  description?: string | null
  permissions: string[]
}

const enc = encodeURIComponent

export function fetchMembers(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<MemberView[]> {
  return client.request(ApiRoutes.settings.members, {
    schema: z.array(memberSchema),
    storeId,
    signal
  })
}

export function changeMemberRole(
  client: ApiClient,
  storeId: string,
  memberId: string,
  roleId: string
): Promise<MemberView> {
  return client.request(ApiRoutes.settings.memberById(enc(memberId)), {
    method: 'PATCH',
    body: { roleId },
    schema: memberSchema,
    storeId
  })
}

export function removeMember(
  client: ApiClient,
  storeId: string,
  memberId: string
): Promise<undefined> {
  return client.request(ApiRoutes.settings.memberById(enc(memberId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// Takes the access of the store away and keeps the role and the history; the person's other stores
// are untouched
export function suspendMember(
  client: ApiClient,
  storeId: string,
  memberId: string
): Promise<MemberView> {
  return client.request(ApiRoutes.settings.memberSuspend(enc(memberId)), {
    method: 'POST',
    schema: memberSchema,
    storeId
  })
}

// Gives the access back with the role the member had
export function reactivateMember(
  client: ApiClient,
  storeId: string,
  memberId: string
): Promise<MemberView> {
  return client.request(ApiRoutes.settings.memberReactivate(enc(memberId)), {
    method: 'POST',
    schema: memberSchema,
    storeId
  })
}

export function fetchRoles(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<RoleView[]> {
  return client.request(ApiRoutes.settings.roles, {
    schema: z.array(roleSchema),
    storeId,
    signal
  })
}

export function createRole(
  client: ApiClient,
  storeId: string,
  input: RoleInput
): Promise<RoleView> {
  return client.request(ApiRoutes.settings.roles, {
    method: 'POST',
    body: input,
    schema: roleSchema,
    storeId
  })
}

export function updateRole(
  client: ApiClient,
  storeId: string,
  roleId: string,
  input: Partial<RoleInput>
): Promise<RoleView> {
  return client.request(ApiRoutes.settings.roleById(enc(roleId)), {
    method: 'PATCH',
    body: input,
    schema: roleSchema,
    storeId
  })
}

export function deleteRole(client: ApiClient, storeId: string, roleId: string): Promise<undefined> {
  return client.request(ApiRoutes.settings.roleById(enc(roleId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

export function fetchInvitations(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<InvitationView[]> {
  return client.request(ApiRoutes.settings.invitations, {
    schema: z.array(invitationSchema),
    storeId,
    signal
  })
}

// Inviting creates no member: the invitee is one once they accept
export function inviteMember(
  client: ApiClient,
  storeId: string,
  input: { email: string; roleId: string }
): Promise<InvitationView> {
  return client.request(ApiRoutes.settings.members, {
    method: 'POST',
    body: input,
    schema: invitationSchema,
    storeId
  })
}

export function resendInvitation(
  client: ApiClient,
  storeId: string,
  invitationId: string
): Promise<InvitationView> {
  return client.request(ApiRoutes.settings.invitationResend(enc(invitationId)), {
    method: 'POST',
    schema: invitationSchema,
    storeId
  })
}

export function revokeInvitation(
  client: ApiClient,
  storeId: string,
  invitationId: string
): Promise<undefined> {
  return client.request(ApiRoutes.settings.invitationById(enc(invitationId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}
