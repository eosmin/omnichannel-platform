import { z } from 'zod'

import { type Permission, Permissions, type TenantAccessStatuses } from '@platform/core/auth'

const PERMISSION_VALUES: ReadonlySet<string> = new Set(Object.values(Permissions))

export function isPermission(value: string): value is Permission {
  return PERMISSION_VALUES.has(value)
}

// What a request knows about the store it works in, from the memberships of the caller. It is what
// the cache holds, so it is a schema: what comes back from Redis is checked like any other input.
const grantedTenantSchema = z.object({
  store: z.object({ id: z.uuid(), organizationId: z.uuid(), name: z.string() }),
  membership: z.object({ id: z.uuid(), roleId: z.uuid(), roleName: z.string() }),
  permissions: z.array(z.string().refine(isPermission))
})

export const resolvedTenantSchema = grantedTenantSchema.nullable() // "This user has no access to this store" is an answer worth caching too

export type ResolvedTenant = z.output<typeof grantedTenantSchema>

// A suspended member belongs to the store and may not enter it. It is told apart from "no access" so
// that the person is told why, and it carries no permission: nothing can read it as a grant.
export const tenantAccessSchema = z
  .union([grantedTenantSchema, z.object({ suspended: z.literal(true) })])
  .nullable()

export type TenantAccess =
  | { status: typeof TenantAccessStatuses.GRANTED; tenant: ResolvedTenant }
  | { status: typeof TenantAccessStatuses.SUSPENDED }
  | { status: typeof TenantAccessStatuses.NONE }
