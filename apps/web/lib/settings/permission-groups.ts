import { type Permission, PermissionRequires, Permissions } from '@platform/core/auth'

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
// the api is what refuses it. A permission that needs another ticks it too (registering a transaction needs seeing it), and
// unticking the needed one unticks what depends on it, so the role the editor sends is one the server takes.
export function toggled(selected: readonly string[], permission: string): string[] {
  if (selected.includes(permission)) {
    return selected.filter(
      name =>
        name !== permission &&
        !(PermissionRequires[name as Permission] ?? []).includes(permission as Permission)
    )
  }
  const needed = (PermissionRequires[permission as Permission] ?? []).filter(
    each => !selected.includes(each)
  )
  return [...selected, permission, ...needed]
}
