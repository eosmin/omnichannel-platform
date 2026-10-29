// Format: resource:action. Never invent one inline.
export const Permissions = {
  // Conversations
  CONVERSATIONS_VIEW: 'conversations:view',
  CONVERSATIONS_VIEW_ALL: 'conversations:view_all', // vs only assigned to me
  CONVERSATIONS_CREATE: 'conversations:create',
  CONVERSATIONS_ASSIGN: 'conversations:assign',
  CONVERSATIONS_RESOLVE: 'conversations:resolve',
  CONVERSATIONS_SNOOZE: 'conversations:snooze',
  CONVERSATIONS_ARCHIVE: 'conversations:archive',
  CONVERSATIONS_DELETE: 'conversations:delete',
  CONVERSATIONS_EXPORT: 'conversations:export',

  // Messages
  MESSAGES_VIEW: 'messages:view',
  MESSAGES_SEND: 'messages:send',
  MESSAGES_SEND_TEMPLATE: 'messages:send_template',
  MESSAGES_INTERNAL_NOTE: 'messages:internal_note',
  MESSAGES_DELETE: 'messages:delete',
  // Reads the text of a message the customer deleted, while it is kept (every read is audited)
  MESSAGES_VIEW_DELETED: 'messages:view_deleted',

  // Customers
  CUSTOMERS_VIEW: 'customers:view',
  CUSTOMERS_CREATE: 'customers:create',
  CUSTOMERS_EDIT: 'customers:edit',
  CUSTOMERS_DELETE: 'customers:delete',
  CUSTOMERS_MERGE: 'customers:merge',
  CUSTOMERS_EXPORT: 'customers:export',
  CUSTOMERS_FLAG_CAUTION: 'customers:flag_caution',

  // Orders
  ORDERS_VIEW: 'orders:view',
  ORDERS_CREATE: 'orders:create',
  ORDERS_EDIT: 'orders:edit',
  ORDERS_CANCEL: 'orders:cancel',
  ORDERS_CHANGE_STATUS: 'orders:change_status',
  ORDERS_EXPORT: 'orders:export',
  ORDERS_CONFIRM: 'orders:confirm',
  ORDERS_SEND_MESSAGES: 'orders:send_messages',
  ORDERS_OVERRIDE_PRICE: 'orders:override_price',
  ORDERS_APPROVE_PRICE: 'orders:approve_price',

  // Products and inventory
  PRODUCTS_VIEW: 'products:view',
  PRODUCTS_CREATE: 'products:create',
  PRODUCTS_EDIT: 'products:edit',
  PRODUCTS_DELETE: 'products:delete',
  INVENTORY_VIEW: 'inventory:view',
  INVENTORY_ADJUST: 'inventory:adjust',
  INVENTORY_MANAGE_TRANSFERS: 'inventory:manage_transfers',
  INVENTORY_RECEIVE_TRANSFERS: 'inventory:receive_transfers',
  INVENTORY_MANAGE_COUNTS: 'inventory:manage_counts',
  INVENTORY_APPLY_COUNTS: 'inventory:apply_counts',

  // Shipping, returns and remittances
  SHIPPING_VIEW: 'shipping:view',
  SHIPPING_MANAGE: 'shipping:manage', // create, cancel, print, edit status by hand
  SHIPPING_MANAGE_PICKUPS: 'shipping:manage_pickups',
  RETURNS_VIEW: 'returns:view',
  RETURNS_MANAGE: 'returns:manage',
  REMITTANCES_VIEW: 'remittances:view',
  REMITTANCES_MANAGE: 'remittances:manage',

  // Media
  MEDIA_VIEW: 'media:view',
  MEDIA_UPLOAD: 'media:upload',
  MEDIA_DOWNLOAD_ALL: 'media:download_all',

  // Team
  TEAM_VIEW: 'team:view',
  TEAM_INVITE: 'team:invite',
  TEAM_REMOVE: 'team:remove',
  TEAM_MANAGE_ROLES: 'team:manage_roles',

  // Settings
  SETTINGS_VIEW: 'settings:view',
  SETTINGS_EDIT: 'settings:edit',
  SETTINGS_MANAGE_PLUGINS: 'settings:manage_plugins',
  SETTINGS_MANAGE_WEBHOOKS: 'settings:manage_webhooks',
  SETTINGS_MANAGE_API_KEYS: 'settings:manage_api_keys',
  SETTINGS_MANAGE_RETENTION: 'settings:manage_retention',
  SETTINGS_MANAGE_ROUTING: 'settings:manage_routing',
  SETTINGS_MANAGE_CARRIERS: 'settings:manage_carriers', // connections, credentials, services, pickup rules
  SETTINGS_MANAGE_ORDER_TEMPLATES: 'settings:manage_order_templates',
  SETTINGS_MANAGE_PREFERENCES: 'settings:manage_preferences',

  // Analytics
  ANALYTICS_VIEW: 'analytics:view',
  ANALYTICS_EXPORT: 'analytics:export',
  ANALYTICS_MANAGE_REPORTS: 'analytics:manage_reports',

  // Organization
  ORG_MANAGE_STORES: 'org:manage_stores',
  ORG_MANAGE_WAREHOUSES: 'org:manage_warehouses',
  ORG_VIEW_AUDIT_LOG: 'org:view_audit_log',
  ORG_MANAGE_COMPLIANCE: 'org:manage_compliance'
} as const

export type Permission = (typeof Permissions)[keyof typeof Permissions]

export const RoleNames = {
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  AGENT: 'Agent',
  VIEWER: 'Viewer'
} as const

export type RoleName = (typeof RoleNames)[keyof typeof RoleNames]

export const RolePresets: Record<RoleName, readonly Permission[]> = {
  [RoleNames.ADMIN]: Object.values(Permissions),

  [RoleNames.SUPERVISOR]: [
    Permissions.CONVERSATIONS_VIEW,
    Permissions.CONVERSATIONS_VIEW_ALL,
    Permissions.CONVERSATIONS_CREATE,
    Permissions.CONVERSATIONS_ASSIGN,
    Permissions.CONVERSATIONS_RESOLVE,
    Permissions.CONVERSATIONS_SNOOZE,
    Permissions.CONVERSATIONS_ARCHIVE,
    Permissions.CONVERSATIONS_EXPORT,
    Permissions.MESSAGES_VIEW,
    Permissions.MESSAGES_SEND,
    Permissions.MESSAGES_SEND_TEMPLATE,
    Permissions.MESSAGES_INTERNAL_NOTE,
    Permissions.CUSTOMERS_VIEW,
    Permissions.CUSTOMERS_CREATE,
    Permissions.CUSTOMERS_EDIT,
    Permissions.CUSTOMERS_MERGE,
    Permissions.CUSTOMERS_FLAG_CAUTION,
    Permissions.ORDERS_VIEW,
    Permissions.ORDERS_CREATE,
    Permissions.ORDERS_EDIT,
    Permissions.ORDERS_CANCEL,
    Permissions.ORDERS_CHANGE_STATUS,
    Permissions.ORDERS_CONFIRM,
    Permissions.ORDERS_SEND_MESSAGES,
    Permissions.ORDERS_APPROVE_PRICE,
    Permissions.PRODUCTS_VIEW,
    Permissions.INVENTORY_VIEW,
    Permissions.INVENTORY_ADJUST,
    Permissions.INVENTORY_MANAGE_TRANSFERS,
    Permissions.INVENTORY_RECEIVE_TRANSFERS,
    Permissions.INVENTORY_MANAGE_COUNTS,
    Permissions.SHIPPING_VIEW,
    Permissions.SHIPPING_MANAGE,
    Permissions.SHIPPING_MANAGE_PICKUPS,
    Permissions.RETURNS_VIEW,
    Permissions.RETURNS_MANAGE,
    Permissions.REMITTANCES_VIEW,
    Permissions.REMITTANCES_MANAGE,
    Permissions.MEDIA_VIEW,
    Permissions.MEDIA_UPLOAD,
    Permissions.MEDIA_DOWNLOAD_ALL,
    Permissions.TEAM_VIEW,
    Permissions.ANALYTICS_VIEW,
    Permissions.ANALYTICS_EXPORT
  ],

  [RoleNames.AGENT]: [
    Permissions.CONVERSATIONS_VIEW,
    Permissions.CONVERSATIONS_CREATE,
    Permissions.CONVERSATIONS_RESOLVE,
    Permissions.CONVERSATIONS_SNOOZE,
    Permissions.MESSAGES_VIEW,
    Permissions.MESSAGES_SEND,
    Permissions.MESSAGES_SEND_TEMPLATE,
    Permissions.MESSAGES_INTERNAL_NOTE,
    Permissions.CUSTOMERS_VIEW,
    Permissions.CUSTOMERS_CREATE,
    Permissions.CUSTOMERS_EDIT,
    Permissions.CUSTOMERS_FLAG_CAUTION,
    Permissions.ORDERS_VIEW,
    Permissions.ORDERS_CREATE,
    Permissions.ORDERS_CONFIRM,
    Permissions.ORDERS_SEND_MESSAGES,
    Permissions.PRODUCTS_VIEW,
    Permissions.INVENTORY_VIEW,
    Permissions.SHIPPING_VIEW,
    Permissions.SHIPPING_MANAGE,
    Permissions.RETURNS_VIEW,
    Permissions.MEDIA_VIEW,
    Permissions.MEDIA_UPLOAD
  ],

  [RoleNames.VIEWER]: [
    Permissions.CONVERSATIONS_VIEW,
    Permissions.MESSAGES_VIEW,
    Permissions.CUSTOMERS_VIEW,
    Permissions.ORDERS_VIEW,
    Permissions.PRODUCTS_VIEW,
    Permissions.INVENTORY_VIEW,
    Permissions.SHIPPING_VIEW,
    Permissions.RETURNS_VIEW,
    Permissions.REMITTANCES_VIEW,
    Permissions.MEDIA_VIEW,
    Permissions.ANALYTICS_VIEW
  ]
}
