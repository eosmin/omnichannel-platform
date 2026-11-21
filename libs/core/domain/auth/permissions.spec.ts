import {
  PermissionRequires,
  Permissions,
  RoleNames,
  RolePresets,
  type Permission,
  unmetPermissionRequirements
} from './permissions'

const allPermissions: readonly Permission[] = Object.values(Permissions)

describe('Permissions', () => {
  it('uses the resource:action format with unique values', () => {
    expect(new Set(allPermissions).size).toBe(allPermissions.length)
    for (const permission of allPermissions) {
      expect(permission).toMatch(/^[a-z]+:[a-z_]+$/)
    }
  })

  it('has no billing, AI or impersonation permissions', () => {
    const forbidden = /(billing|_ai|impersonation|org:delete)/
    expect(allPermissions.filter(p => forbidden.test(p))).toEqual([])
  })
})

describe('RolePresets', () => {
  it('gives the Admin every permission', () => {
    expect([...RolePresets[RoleNames.ADMIN]].sort()).toEqual([...allPermissions].sort())
  })

  it('only grants known permissions, without duplicates', () => {
    for (const [role, permissions] of Object.entries(RolePresets)) {
      expect(new Set(permissions).size).toBe(permissions.length)
      for (const permission of permissions) {
        expect([role, allPermissions]).toEqual([role, expect.arrayContaining([permission])])
      }
    }
  })

  it('gives the irreversible erasure of a customer to the Admin and to no other preset', () => {
    expect(RolePresets[RoleNames.ADMIN]).toContain(Permissions.CUSTOMERS_ERASE)
    for (const role of [RoleNames.SUPERVISOR, RoleNames.AGENT, RoleNames.VIEWER]) {
      expect(RolePresets[role]).not.toContain(Permissions.CUSTOMERS_ERASE)
    }
  })

  it('keeps the Viewer read only', () => {
    for (const permission of RolePresets[RoleNames.VIEWER]) {
      expect(permission).toMatch(/:view$/)
    }
  })

  it('keeps price approval, carrier setup and warehouse management away from agents', () => {
    const agent = RolePresets[RoleNames.AGENT]
    expect(agent).not.toContain(Permissions.ORDERS_APPROVE_PRICE)
    expect(agent).not.toContain(Permissions.ORDERS_OVERRIDE_PRICE)
    expect(agent).not.toContain(Permissions.SETTINGS_MANAGE_CARRIERS)
    expect(agent).not.toContain(Permissions.ORG_MANAGE_WAREHOUSES)
    expect(agent).not.toContain(Permissions.INVENTORY_APPLY_COUNTS)
  })

  it('lets the Supervisor run inventory and approve prices but not apply counts', () => {
    const supervisor = RolePresets[RoleNames.SUPERVISOR]
    expect(supervisor).toContain(Permissions.INVENTORY_MANAGE_COUNTS)
    expect(supervisor).toContain(Permissions.ORDERS_APPROVE_PRICE)
    expect(supervisor).not.toContain(Permissions.INVENTORY_APPLY_COUNTS)
  })
})

describe('PermissionRequires', () => {
  it('asks for a permission that exists, and none asks for itself', () => {
    for (const [permission, needed] of Object.entries(PermissionRequires)) {
      for (const each of needed ?? []) {
        expect(allPermissions).toContain(each)
        expect(each).not.toBe(permission)
      }
    }
  })

  it('says what a set lacks: registering a transaction needs seeing the journal', () => {
    expect(unmetPermissionRequirements([Permissions.FINANCE_MANAGE_TRANSACTIONS])).toEqual([
      {
        permission: Permissions.FINANCE_MANAGE_TRANSACTIONS,
        requires: [Permissions.FINANCE_VIEW_JOURNAL]
      }
    ])
    expect(
      unmetPermissionRequirements([
        Permissions.FINANCE_MOVE_MONEY,
        Permissions.FINANCE_POST_MANUAL,
        Permissions.FINANCE_VIEW_JOURNAL
      ])
    ).toEqual([])
  })

  it('is held by every preset', () => {
    for (const preset of Object.values(RolePresets)) {
      expect(unmetPermissionRequirements(preset)).toEqual([])
    }
  })
})
