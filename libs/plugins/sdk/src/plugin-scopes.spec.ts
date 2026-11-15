import { Permissions } from '@platform/core/auth'
import { ChannelPluginScopes } from '@platform/core/domain'

import { PluginScopePermissions, PluginScopes } from './plugin-scopes'

describe('PluginScopes', () => {
  it('names the two scopes of a channel as the domain constants do', () => {
    expect([PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS]).toEqual(
      Object.values(ChannelPluginScopes)
    )
  })

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

  it('keeps the kept text of deleted messages in a scope of its own, which no other scope grants', () => {
    expect(PluginScopePermissions[PluginScopes.MESSAGES_READ_DELETED]).toEqual([
      Permissions.MESSAGES_VIEW_DELETED
    ])
    for (const [scope, granted] of Object.entries(PluginScopePermissions)) {
      if (scope === PluginScopes.MESSAGES_READ_DELETED) continue
      expect(granted).not.toContain(Permissions.MESSAGES_VIEW_DELETED)
    }
  })

  it('lets the webhooks scope grant no human permission', () => {
    expect(PluginScopePermissions[PluginScopes.WEBHOOKS_WRITE]).toEqual([])
  })
})
