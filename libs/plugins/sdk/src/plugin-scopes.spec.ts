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

  it('keeps the permission to delete a message in a scope of its own, which no other scope grants', () => {
    expect(PluginScopePermissions[PluginScopes.MESSAGES_DELETE]).toEqual([
      Permissions.MESSAGES_DELETE
    ])
    for (const [scope, granted] of Object.entries(PluginScopePermissions)) {
      if (scope === PluginScopes.MESSAGES_DELETE) continue
      expect(granted).not.toContain(Permissions.MESSAGES_DELETE)
    }
  })

  it('keeps the delete and the caution of a customer in scopes of their own, which customers:write does not grant', () => {
    expect(PluginScopePermissions[PluginScopes.CUSTOMERS_DELETE]).toEqual([
      Permissions.CUSTOMERS_DELETE
    ])
    expect(PluginScopePermissions[PluginScopes.CUSTOMERS_FLAG_CAUTION]).toEqual([
      Permissions.CUSTOMERS_FLAG_CAUTION
    ])
    for (const [scope, granted] of Object.entries(PluginScopePermissions)) {
      if (scope !== PluginScopes.CUSTOMERS_DELETE) {
        expect(granted).not.toContain(Permissions.CUSTOMERS_DELETE)
      }
      if (scope !== PluginScopes.CUSTOMERS_FLAG_CAUTION) {
        expect(granted).not.toContain(Permissions.CUSTOMERS_FLAG_CAUTION)
      }
    }
  })

  it('keeps confirming, cancelling, editing, deciding a price, sending and the templates of an order in scopes of their own', () => {
    const own: [string, string][] = [
      [PluginScopes.ORDERS_EDIT, Permissions.ORDERS_EDIT],
      [PluginScopes.ORDERS_CONFIRM, Permissions.ORDERS_CONFIRM],
      [PluginScopes.ORDERS_CANCEL, Permissions.ORDERS_CANCEL],
      [PluginScopes.ORDERS_APPROVE_PRICE, Permissions.ORDERS_APPROVE_PRICE],
      [PluginScopes.ORDER_MESSAGES_WRITE, Permissions.ORDERS_SEND_MESSAGES],
      [PluginScopes.ORDER_TEMPLATES_WRITE, Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES]
    ]
    for (const [scope, permission] of own) {
      expect(PluginScopePermissions[scope as keyof typeof PluginScopePermissions]).toEqual([
        permission
      ])
      for (const [other, granted] of Object.entries(PluginScopePermissions)) {
        if (other !== scope) expect(granted).not.toContain(permission)
      }
    }
  })

  it('grants no scope the override of a price: a plugin sells at the price of the catalog', () => {
    for (const granted of Object.values(PluginScopePermissions)) {
      expect(granted).not.toContain(Permissions.ORDERS_OVERRIDE_PRICE)
    }
  })

  it('does not let a scope that creates an order confirm it, cancel it or touch its stock', () => {
    expect(PluginScopePermissions[PluginScopes.ORDERS_WRITE]).toEqual([
      Permissions.ORDERS_CREATE,
      Permissions.ORDERS_CHANGE_STATUS
    ])
  })

  it('lets the webhooks scope grant no human permission', () => {
    expect(PluginScopePermissions[PluginScopes.WEBHOOKS_WRITE]).toEqual([])
  })
})
