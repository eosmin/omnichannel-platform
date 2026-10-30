// Routes are full paths relative to the version prefix. Controllers declare @Controller() with
// no prefix and use the constant on the method, passing ':id' placeholders to the path builders:
//
//   @Get(ApiRoutes.conversations.byId(':id'))   // '/conversations/:id'
//
// No route constant contains /api/v1: the frontend apiClient prepends it once.
//
// Literal siblings of a parameterised route (/orders/export next to /orders/:id, and the same for
// bulk, search, registry, available and pending) must be declared BEFORE it in the controller:
// Express matches in registration order, so the other way round 'export' is read as an id.
export const ApiRoutes = {
  // Login is a magic link: there is no password, no signup and no OAuth (TDD_02 v1.2 trim).
  auth: {
    magicLinkRequest: '/auth/magic-link/request',
    magicLinkConsume: '/auth/magic-link/consume', // POST with the token in the body, never a GET
    logout: '/auth/logout',
    refresh: '/auth/refresh',
    me: '/auth/me',
    sessions: '/auth/sessions',
    sessionById: (id: string) => `/auth/sessions/${id}`
  },

  // The organization is created by the seed only: read and update, never create.
  organizations: {
    current: '/organizations/current',
    stores: '/organizations/current/stores',
    storeById: (id: string) => `/organizations/current/stores/${id}`,
    auditLog: '/organizations/current/audit-log'
  },

  // Public. Accepting creates the account (when there is none), the membership and the session.
  invitations: {
    byToken: (token: string) => `/invitations/${token}`, // Preview
    accept: (token: string) => `/invitations/${token}/accept`
  },

  conversations: {
    list: '/conversations',
    byId: (id: string) => `/conversations/${id}`,
    messages: (id: string) => `/conversations/${id}/messages`,
    assign: (id: string) => `/conversations/${id}/assign`,
    status: (id: string) => `/conversations/${id}/status`,
    snooze: (id: string) => `/conversations/${id}/snooze`,
    tags: (id: string) => `/conversations/${id}/tags`,
    tagById: (id: string, tagId: string) => `/conversations/${id}/tags/${tagId}`,
    read: (id: string) => `/conversations/${id}/read`,
    messagingWindow: (id: string) => `/conversations/${id}/messaging-window`,
    origins: (id: string) => `/conversations/${id}/origins`,
    bulk: '/conversations/bulk',
    export: '/conversations/export'
  },

  messages: {
    create: '/messages',
    byId: (id: string) => `/messages/${id}`,
    markRead: (id: string) => `/messages/${id}/read`,
    reaction: (id: string) => `/messages/${id}/reaction`,
    deletedContent: (id: string) => `/messages/${id}/deleted-content`,
    revisions: (id: string) => `/messages/${id}/revisions`
  },

  customers: {
    list: '/customers',
    byId: (id: string) => `/customers/${id}`,
    identities: (id: string) => `/customers/${id}/identities`,
    identityById: (id: string, identityId: string) => `/customers/${id}/identities/${identityId}`,
    merge: (id: string) => `/customers/${id}/merge`,
    unmerge: (id: string) => `/customers/${id}/unmerge`,
    orders: (id: string) => `/customers/${id}/orders`,
    conversations: (id: string) => `/customers/${id}/conversations`,
    notes: (id: string) => `/customers/${id}/notes`,
    noteById: (id: string, noteId: string) => `/customers/${id}/notes/${noteId}`,
    addresses: (id: string) => `/customers/${id}/addresses`,
    addressById: (id: string, addressId: string) => `/customers/${id}/addresses/${addressId}`,
    tags: (id: string) => `/customers/${id}/tags`,
    tagById: (id: string, tagId: string) => `/customers/${id}/tags/${tagId}`,
    media: (id: string) => `/customers/${id}/media`,
    timeline: (id: string) => `/customers/${id}/timeline`,
    caution: (id: string) => `/customers/${id}/caution`, // PUT sets it with a reason, DELETE clears it
    export: '/customers/export'
  },

  orders: {
    list: '/orders',
    create: '/orders',
    byId: (id: string) => `/orders/${id}`,
    cancel: (id: string) => `/orders/${id}/cancel`,
    status: (id: string) => `/orders/${id}/status`,
    items: (id: string) => `/orders/${id}/items`,
    print: (id: string, doc: string) => `/orders/${id}/print/${doc}`,
    export: '/orders/export',
    confirm: (id: string) => `/orders/${id}/confirm`,
    confirmBulk: '/orders/confirm-bulk',
    copy: (id: string) => `/orders/${id}/copy`, // A prefilled draft: nothing is written
    messages: (id: string) => `/orders/${id}/messages`, // ?preview=true renders without sending
    priceApprovalApprove: (id: string) => `/orders/${id}/price-approval/approve`,
    priceApprovalReject: (id: string) => `/orders/${id}/price-approval/reject`
  },

  products: {
    list: '/products',
    create: '/products',
    byId: (id: string) => `/products/${id}`,
    variants: (id: string) => `/products/${id}/variants`,
    search: '/products/search',
    inventory: (id: string) => `/products/${id}/inventory` // Levels per warehouse, read only
  },

  // Organization-scoped (TDD_16 §6)
  warehouses: {
    list: '/warehouses',
    create: '/warehouses',
    byId: (id: string) => `/warehouses/${id}`,
    stores: (id: string) => `/warehouses/${id}/stores` // PUT replaces the store links atomically
  },

  inventory: {
    levels: '/inventory/levels',
    movements: '/inventory/movements',
    kardex: '/inventory/kardex',
    adjustments: '/inventory/adjustments'
  },

  transfers: {
    list: '/transfers',
    create: '/transfers',
    byId: (id: string) => `/transfers/${id}`,
    dispatch: (id: string) => `/transfers/${id}/dispatch`,
    receive: (id: string) => `/transfers/${id}/receive`,
    close: (id: string) => `/transfers/${id}/close`,
    cancel: (id: string) => `/transfers/${id}/cancel`
  },

  counts: {
    list: '/counts',
    create: '/counts',
    byId: (id: string) => `/counts/${id}`,
    start: (id: string) => `/counts/${id}/start`,
    lines: (id: string) => `/counts/${id}/lines`,
    submit: (id: string) => `/counts/${id}/submit`,
    apply: (id: string) => `/counts/${id}/apply`,
    cancel: (id: string) => `/counts/${id}/cancel`
  },

  // Shipping (TDD_17 §6)
  carriers: {
    list: '/carriers',
    create: '/carriers',
    registry: '/carriers/registry', // Which official carriers exist and their capabilities
    byId: (id: string) => `/carriers/${id}`,
    test: (id: string) => `/carriers/${id}/test`,
    disconnect: (id: string) => `/carriers/${id}/disconnect`,
    locations: (id: string) => `/carriers/${id}/locations`,
    statusMappings: (id: string) => `/carriers/${id}/status-mappings`,
    statusMappingByCode: (id: string, code: string) => `/carriers/${id}/status-mappings/${code}`, // PUT maps it, DELETE restores the plugin default
    unmappedStatuses: (id: string) => `/carriers/${id}/unmapped-statuses`
  },

  shipments: {
    list: '/shipments',
    byId: (id: string) => `/shipments/${id}`,
    forOrder: (orderId: string) => `/orders/${orderId}/shipments`, // POST creates the guide
    bulk: '/shipments/bulk', // At most 100 ids, answers 202 with the job id
    bulkJob: (jobId: string) => `/shipments/bulk/${jobId}`,
    mergeLabels: '/shipments/labels/merge',
    label: (id: string) => `/shipments/${id}/label`,
    cancel: (id: string) => `/shipments/${id}/cancel`,
    status: (id: string) => `/shipments/${id}/status`, // A manual event
    check: (id: string) => `/shipments/${id}/check`, // Ask the carrier
    markVoided: (id: string) => `/shipments/${id}/mark-voided`
  },

  pickups: {
    list: '/pickups',
    create: '/pickups', // Request now, with the chosen shipments
    shipments: (id: string) => `/pickups/${id}/shipments`,
    shipmentById: (id: string, shipmentId: string) => `/pickups/${id}/shipments/${shipmentId}`,
    confirm: (id: string) => `/pickups/${id}/confirm`, // Manual
    cancel: (id: string) => `/pickups/${id}/cancel`,
    manifest: (id: string) => `/pickups/${id}/manifest` // Printable list
  },

  orderTemplates: {
    list: '/order-templates',
    byKindAndLocale: (kind: string, locale: string) => `/order-templates/${kind}/locales/${locale}` // GET, PUT (upsert), DELETE
  },

  returns: {
    list: '/returns',
    create: '/returns',
    byId: (id: string) => `/returns/${id}`,
    approve: (id: string) => `/returns/${id}/approve`,
    reject: (id: string) => `/returns/${id}/reject`,
    cancel: (id: string) => `/returns/${id}/cancel`,
    inTransit: (id: string) => `/returns/${id}/in-transit`,
    receive: (id: string) => `/returns/${id}/receive`, // With the line conditions
    complete: (id: string) => `/returns/${id}/complete`,
    returnShipment: (id: string) => `/returns/${id}/return-shipment`,
    reception: {
      batches: '/returns/reception/batches',
      batchById: (id: string) => `/returns/reception/batches/${id}`,
      scan: (id: string) => `/returns/reception/batches/${id}/scan`, // A code
      itemById: (id: string, itemId: string) => `/returns/reception/batches/${id}/items/${itemId}`,
      complete: (id: string) => `/returns/reception/batches/${id}/complete`
    }
  },

  remittances: {
    list: '/remittances',
    byId: (id: string) => `/remittances/${id}`,
    imports: '/remittances/imports', // A file or pasted text; creates a draft
    pending: '/remittances/pending',
    lines: (id: string) => `/remittances/${id}/lines`,
    lineById: (id: string, lineId: string) => `/remittances/${id}/lines/${lineId}`,
    confirm: (id: string) => `/remittances/${id}/confirm`,
    void: (id: string) => `/remittances/${id}/void`,
    importProfiles: '/remittances/import-profiles',
    importProfileById: (id: string) => `/remittances/import-profiles/${id}`
  },

  media: {
    uploadUrl: '/media/upload-url',
    confirmUpload: '/media/confirm-upload',
    byId: (id: string) => `/media/${id}`,
    downloadAll: '/media/download-all'
  },

  exports: {
    list: '/exports',
    byId: (id: string) => `/exports/${id}`,
    download: (id: string) => `/exports/${id}/download`
  },

  search: {
    global: '/search',
    messages: '/search/messages',
    customers: '/search/customers',
    orders: '/search/orders',
    products: '/search/products'
  },

  notifications: {
    list: '/notifications',
    unreadCount: '/notifications/unread-count',
    markRead: '/notifications/read',
    markAllRead: '/notifications/read-all',
    preferences: '/notifications/preferences',
    pushSubscription: '/notifications/push-subscription'
  },

  analytics: {
    metrics: '/analytics/metrics',
    dashboard: '/analytics/dashboard',
    reports: '/analytics/reports',
    reportById: (id: string) => `/analytics/reports/${id}`,
    export: '/analytics/export'
  },

  plugins: {
    list: '/plugins',
    available: '/plugins/available',
    install: '/plugins/install',
    register: '/plugins/register', // The owner pastes a manifest (SETTINGS_MANAGE_PLUGINS)
    byId: (id: string) => `/plugins/${id}`,
    enable: (id: string) => `/plugins/${id}/enable`,
    disable: (id: string) => `/plugins/${id}/disable`,
    revoke: (id: string) => `/plugins/${id}/revoke`, // Uninstalls: the id is the installation's
    config: (id: string) => `/plugins/${id}/config`
  },

  channels: {
    connections: '/channels/connections',
    connect: (pluginId: string) => `/channels/${pluginId}/connect`,
    connectionById: (id: string) => `/channels/connections/${id}`,
    test: (id: string) => `/channels/connections/${id}/test`,
    disconnect: (id: string) => `/channels/connections/${id}/disconnect`,
    templates: (pluginId: string) => `/channels/${pluginId}/templates`,
    // The web widget's own settings: the sites that may load it and the snippet to paste
    widgetEmbed: (id: string) => `/channels/connections/${id}/widget`,
    widgetOrigins: (id: string) => `/channels/connections/${id}/widget/origins`
  },

  // Who of the team is connected to the store of the request, read once when the inbox opens; the
  // sockets keep it current after that
  presence: {
    team: '/presence'
  },

  // Who the active members of the store are, for anyone who may see conversations: the inbox names
  // an assignee, a mention and the author of a note with it. It carries no email, status or permission
  members: {
    directory: '/members'
  },

  settings: {
    store: '/settings/store',
    inbox: '/settings/inbox',
    safety: '/settings/safety',
    preferences: '/settings/preferences', // GET and PUT, parsed through storePreferencesSchema
    team: '/settings/team',
    members: '/settings/team/members',
    memberById: (id: string) => `/settings/team/members/${id}`,
    invitations: '/settings/team/invitations',
    invitationById: (id: string) => `/settings/team/invitations/${id}`,
    roles: '/settings/roles',
    roleById: (id: string) => `/settings/roles/${id}`,
    routing: '/settings/routing',
    routingOrder: '/settings/routing/order', // PATCH, declared before routingRuleById
    routingRuleById: (id: string) => `/settings/routing/${id}`,
    businessHours: '/settings/business-hours',
    tags: '/settings/tags',
    tagById: (id: string) => `/settings/tags/${id}`,
    snippets: '/settings/snippets',
    snippetById: (id: string) => `/settings/snippets/${id}`,
    webhooks: '/settings/webhooks',
    webhookById: (id: string) => `/settings/webhooks/${id}`,
    webhookDeliveries: (id: string) => `/settings/webhooks/${id}/deliveries`,
    apiKeys: '/settings/api-keys',
    apiKeyById: (id: string) => `/settings/api-keys/${id}`,
    retention: '/settings/retention'
  },

  account: {
    profile: '/account/profile',
    preferences: '/account/preferences'
  },

  compliance: {
    dsr: '/compliance/dsr',
    dsrById: (id: string) => `/compliance/dsr/${id}`,
    dsrVerify: '/compliance/dsr/verify', // Public, token in body
    consent: '/compliance/consent',
    cookieConsent: '/compliance/cookie-consent'
  },

  // Public, unauthenticated. No AuthGuard/TenantGuard; each has its own verification.
  webhooks: {
    resend: '/webhooks/resend',
    channel: (pluginId: string) => `/webhooks/channels/${pluginId}`,
    carrier: (connectionId: string) => `/webhooks/carriers/${connectionId}` // The signature authenticates it
  },

  // Web widget public API (visitor-facing, signed with the site key). TDD_10 §5.4
  widget: {
    bootstrap: '/widget/bootstrap',
    messages: '/widget/messages',
    upload: '/widget/upload-url'
  }
} as const

// Mounted OUTSIDE the /api/v1 prefix.
export const InfraRoutes = {
  healthLive: '/health',
  healthReady: '/health/ready',
  metrics: '/metrics',
  docs: '/docs',
  queues: '/admin/queues' // Bull Board, behind the JWT + BULL_BOARD_ADMIN_EMAILS middleware
} as const
