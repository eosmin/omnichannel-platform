import { Permissions } from '@platform/core/auth'

import { PluginScopePermissions, PluginScopes } from './plugin-scopes'

describe('PluginScopes', () => {
  it('maps every scope to permissions, with an entry per scope', () => {
    expect(Object.keys(PluginScopePermissions).sort()).toEqual(Object.values(PluginScopes).sort())
  })

  it('only grants permissions that exist, so a plugin never exceeds a human', () => {
    const known: readonly string[] = Object.values(Permissions)
    for (const granted of Object.values(PluginScopePermissions)) {
      for (const permission of granted) {
        expect(known).toContain(permission)
      }
    }
  })

  it('grants the inventory and shipping scopes their permissions', () => {
    expect(PluginScopePermissions[PluginScopes.INVENTORY_READ]).toEqual([
      Permissions.INVENTORY_VIEW
    ])
    expect(PluginScopePermissions[PluginScopes.INVENTORY_WRITE]).toEqual([
      Permissions.INVENTORY_ADJUST
    ])
    expect(PluginScopePermissions[PluginScopes.SHIPMENTS_READ]).toEqual([Permissions.SHIPPING_VIEW])
    expect(PluginScopePermissions[PluginScopes.SHIPMENTS_WRITE]).toEqual([
      Permissions.SHIPPING_MANAGE
    ])
  })

  it('lets the webhooks scope grant no human permission', () => {
    expect(PluginScopePermissions[PluginScopes.WEBHOOKS_WRITE]).toEqual([])
  })
})
