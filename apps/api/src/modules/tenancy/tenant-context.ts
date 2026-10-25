import { z } from 'zod'

import { type Permission, Permissions } from '@platform/core/auth'

const PERMISSION_VALUES: ReadonlySet<string> = new Set(Object.values(Permissions))

export function isPermission(value: string): value is Permission {
  return PERMISSION_VALUES.has(value)
}

// What a request knows about the store it works in, from the memberships of the caller. It is what
// the cache holds, so it is a schema: what comes back from Redis is checked like any other input.
export const resolvedTenantSchema = z
  .object({
    store: z.object({ id: z.uuid(), organizationId: z.uuid(), name: z.string() }),
    membership: z.object({ id: z.uuid(), roleId: z.uuid(), roleName: z.string() }),
    permissions: z.array(z.string().refine(isPermission))
  })
  .nullable() // "This user has no access to this store" is an answer worth caching too

export type ResolvedTenant = NonNullable<z.output<typeof resolvedTenantSchema>>
