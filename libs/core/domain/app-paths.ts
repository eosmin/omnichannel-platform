// The only place frontend paths are built. Notification.actionPath, search hits and the PWA
// manifest all use these.

export const StoreSettingsSections = {
  GENERAL: 'general',
  CHANNELS: 'channels',
  PLUGINS: 'plugins',
  TEAM: 'team',
  ROUTING: 'routing',
  BUSINESS_HOURS: 'business-hours',
  TAGS: 'tags',
  SNIPPETS: 'snippets',
  INBOX: 'inbox',
  SAFETY: 'safety',
  RETENTION: 'retention',
  WEBHOOKS: 'webhooks',
  API_KEYS: 'api-keys',
  INVENTORY: 'inventory',
  CARRIERS: 'carriers',
  ORDER_TEMPLATES: 'order-templates',
  RETURNS: 'returns',
  PREFERENCES: 'preferences'
} as const

export type StoreSettingsSection =
  (typeof StoreSettingsSections)[keyof typeof StoreSettingsSections]

export const AppPaths = {
  home: '/', // Has no content: it goes to the store used last, or to the login
  login: '/login',
  magicLink: '/login/verify', // The one page that POSTs the magic-link token
  noAccess: '/no-access', // A user with no membership: after a revocation or a removal
  invitation: (token: string) => `/invitations/${token}`,
  store: {
    inbox: (storeId: string) => `/s/${storeId}/inbox`,
    conversation: (storeId: string, conversationId: string) =>
      `/s/${storeId}/inbox/${conversationId}`,
    customers: (storeId: string) => `/s/${storeId}/customers`,
    customer: (storeId: string, customerId: string) => `/s/${storeId}/customers/${customerId}`,
    orders: (storeId: string) => `/s/${storeId}/orders`,
    order: (storeId: string, orderId: string) => `/s/${storeId}/orders/${orderId}`,
    newOrder: (storeId: string) => `/s/${storeId}/orders/new`,
    products: (storeId: string) => `/s/${storeId}/products`,
    inventory: (storeId: string) => `/s/${storeId}/inventory`,
    shipments: (storeId: string) => `/s/${storeId}/shipments`,
    pickups: (storeId: string) => `/s/${storeId}/pickups`,
    returns: (storeId: string) => `/s/${storeId}/returns`,
    returnsReception: (storeId: string) => `/s/${storeId}/returns/receive`,
    remittances: (storeId: string) => `/s/${storeId}/remittances`,
    analytics: (storeId: string) => `/s/${storeId}/analytics`,
    settings: (storeId: string, section: StoreSettingsSection = StoreSettingsSections.GENERAL) =>
      `/s/${storeId}/settings/${section}`,
    exports: (storeId: string) => `/s/${storeId}/exports`,
    exportDownload: (storeId: string, exportId: string) => `/s/${storeId}/exports/${exportId}`
  },
  org: {
    stores: '/org/stores',
    warehouses: '/org/warehouses',
    transfers: '/org/transfers',
    counts: '/org/counts',
    auditLog: '/org/audit-log',
    compliance: '/org/compliance'
  },
  account: {
    profile: '/account/profile',
    preferences: '/account/preferences',
    notifications: '/account/notifications',
    security: '/account/security'
  }
} as const
