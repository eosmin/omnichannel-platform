import { type Permission, Permissions } from '@platform/core/auth'

// The permission matrix of a role (TDD_09 §13): the permissions grouped by the area they belong to,
// which is the part of the name before the colon (`team:invite` is `invite` in `team`). The order is
// the one of the constants, so a new permission lands in its group with no change here.
export interface PermissionGroup {
  group: string
  permissions: { permission: Permission; action: string }[]
}

export function permissionGroups(): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>()
  for (const permission of Object.values(Permissions)) {
    const [group = '', action = ''] = permission.split(':')
    const entry = groups.get(group) ?? { group, permissions: [] }
    entry.permissions.push({ permission, action })
    groups.set(group, entry)
  }
  return [...groups.values()]
}

// Ticks or unticks one permission of the matrix. A name this version does not know stays as it came;
// the api is what refuses it.
export function toggled(selected: readonly string[], permission: string): string[] {
  return selected.includes(permission)
    ? selected.filter(name => name !== permission)
    : [...selected, permission]
}
