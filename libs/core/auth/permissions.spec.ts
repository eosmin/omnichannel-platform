import { Permissions, RoleNames, RolePresets, type Permission } from './permissions'

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
