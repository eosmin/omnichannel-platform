import { Permissions, type Permission } from '@platform/core/auth'

export const PluginScopes = {
  CONVERSATIONS_READ: 'conversations:read',
  CONVERSATIONS_WRITE: 'conversations:write',
  MESSAGES_READ: 'messages:read',
  MESSAGES_WRITE: 'messages:write',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  ORDERS_READ: 'orders:read',
  ORDERS_WRITE: 'orders:write',
  PRODUCTS_READ: 'products:read',
  WEBHOOKS_WRITE: 'webhooks:write',
  ANALYTICS_READ: 'analytics:read',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',
  SHIPMENTS_READ: 'shipments:read',
  SHIPMENTS_WRITE: 'shipments:write'
} as const

export type PluginScope = (typeof PluginScopes)[keyof typeof PluginScopes]

// Each scope grants a fixed subset of the human Permissions: a plugin can never exceed what a
// human could do.
export const PluginScopePermissions: Record<PluginScope, readonly Permission[]> = {
  [PluginScopes.CONVERSATIONS_READ]: [
    Permissions.CONVERSATIONS_VIEW,
    Permissions.CONVERSATIONS_VIEW_ALL
  ],
  [PluginScopes.CONVERSATIONS_WRITE]: [
    Permissions.CONVERSATIONS_CREATE,
    Permissions.CONVERSATIONS_ASSIGN,
    Permissions.CONVERSATIONS_RESOLVE,
    Permissions.CONVERSATIONS_SNOOZE
  ],
  [PluginScopes.MESSAGES_READ]: [Permissions.MESSAGES_VIEW],
  [PluginScopes.MESSAGES_WRITE]: [Permissions.MESSAGES_SEND, Permissions.MESSAGES_INTERNAL_NOTE],
  [PluginScopes.CUSTOMERS_READ]: [Permissions.CUSTOMERS_VIEW],
  [PluginScopes.CUSTOMERS_WRITE]: [Permissions.CUSTOMERS_CREATE, Permissions.CUSTOMERS_EDIT],
  [PluginScopes.ORDERS_READ]: [Permissions.ORDERS_VIEW],
  [PluginScopes.ORDERS_WRITE]: [Permissions.ORDERS_CREATE, Permissions.ORDERS_CHANGE_STATUS],
  [PluginScopes.PRODUCTS_READ]: [Permissions.PRODUCTS_VIEW],
  [PluginScopes.WEBHOOKS_WRITE]: [],
  [PluginScopes.ANALYTICS_READ]: [Permissions.ANALYTICS_VIEW],
  [PluginScopes.INVENTORY_READ]: [Permissions.INVENTORY_VIEW],
  [PluginScopes.INVENTORY_WRITE]: [Permissions.INVENTORY_ADJUST],
  [PluginScopes.SHIPMENTS_READ]: [Permissions.SHIPPING_VIEW],
  [PluginScopes.SHIPMENTS_WRITE]: [Permissions.SHIPPING_MANAGE]
}
