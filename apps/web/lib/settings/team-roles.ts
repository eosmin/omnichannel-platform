import type { Permission } from '@platform/core/auth'

// A role is as powerful as the set of permissions it holds, and the api refuses to give, change or
// take away one that holds what the caller lacks. The interface offers only what the person can do.
// A name that is not a permission this version knows is one the person does not hold.
export function canGrant(
  role: { permissions: readonly string[] },
  can: (permission: Permission) => boolean
): boolean {
  return role.permissions.every(name => can(name as Permission))
}
