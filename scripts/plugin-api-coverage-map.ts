import type { PluginApiCoverage } from './lib/plugin-api-coverage'

// For each route of the API: the scope through which a plugin of a third party reaches it under
// /api/v1/plugin-api/* (owner, 2026-11-12: everything the product does must be reachable from the SDK), or
// why no plugin does. scripts/check-plugin-api-coverage.ts (`pnpm validate:plugin-api`) fails when a route
// is not here, is here and does not exist, or names a scope that is neither in `PluginScopes`
// (libs/plugins/sdk/src/plugin-scopes.ts) nor proposed with the step that adds it.
//
// `scope` is a scope that exists; `proposed` is one that does not yet (Step 5.6 adds it to `PluginScopes`
// and to `PluginScopePermissions`). A list names every scope that some method of the route needs; the
// controller of Step 5.6 states, for each method, which of them it takes, and ALL the human permissions of
// that method must be inside the scopes it takes (a plugin never exceeds what a person could do, so a
// permission that no scope grants, such as ORDERS_CANCEL or CUSTOMERS_MERGE, is a scope of its own, never a
// wider `orders:write`). A route with only a read scope exposes its GET and no more: the other methods of the
// human route (a PATCH of a carrier connection) stay human. A route with a scope and no `exposed` is still to build: it is
// frozen in scripts/plugin-api-baseline.json, which can only shrink. When the controller of the plugin
// API exists (Step 5.6), the entry says its path in `exposed` and the route leaves the baseline.
// A session that adds a route maps it here, in its own PR, and writes "plugin-api: Step 5.6 (scope ...)"
// in the step of the plan that builds it.

const STEP = '5.6'

const SESSION = "A person's own session: a plugin has an API key, not a login"
const ACCOUNT =
  "A person's own account (their name, picture and preferences): the id comes from their token"
const OWN_NOTIFICATIONS =
  'The notifications of one person and their push subscription; a plugin raises its own through its webhooks and the plugin.error type'
const PRESENCE = 'Who of the team is connected: the sockets of the agents, not data of the store'
const TEAM_PEOPLE =
  'The directory of the people of the team: a plugin names a person by the user id it is given, never lists the team'
const INVITE = 'Public invitation of a person: preview and accept belong to the invited person'
const ORGANIZATION =
  'The organization and its stores: owner only, a key is bound to exactly one store'
const TEAM_ADMIN =
  'Team, roles and permissions: a plugin can never change what a human could not give it (TDD_10 §9)'
const SECURITY_SETTINGS =
  'Security settings (safety, webhooks, API keys, retention): a plugin must not reach the keys and hooks that govern plugins'
const PLUGIN_ADMIN =
  'Registering, installing and revoking plugins is the owner’s (SETTINGS_MANAGE_PLUGINS); a plugin does not manage plugins'
const COMPLIANCE = 'Data subject requests and consent: a person, and the owner who answers them'
const PUBLIC =
  'Public route that authenticates by its own means (signature, state or site key); never with the key of a plugin'
const ORDER_PRINT =
  'No server route that a plugin needs: the sheet is printed by the browser from the order a plugin already reads'
const CARRIER_ADMIN =
  'The credentials, webhook secret and status mappings of a carrier connection: owner only, secrets never leave the store'
const CHANNEL_ADMIN =
  'The connection of a channel account (tokens, labels, OAuth): owner only; a channel plugin registers its own through plugin-api/channel (Step 5.6)'
const SETTINGS_ADMIN =
  'A setting of how the store works (routing, hours, snippets, inbox behaviour): the owner decides it, a plugin reads the effect'
const BELL_AND_SEARCH =
  'Search over what the person sees in the app bar; a plugin lists with the filters of each resource'

export const PLUGIN_API_COVERAGE: Readonly<Record<string, PluginApiCoverage>> = {
  // Sessions, account, notifications, team, organization, plugins, compliance
  'auth.magicLinkRequest': { none: SESSION },
  'auth.magicLinkConsume': { none: SESSION },
  'auth.logout': { none: SESSION },
  'auth.refresh': { none: SESSION },
  'auth.me': { none: SESSION },
  'auth.sessions': { none: SESSION },
  'auth.sessionById': { none: SESSION },
  'account.profile': { none: ACCOUNT },
  'account.preferences': { none: ACCOUNT },
  'account.avatarUploadUrl': { none: ACCOUNT },
  'account.avatarConfirm': { none: ACCOUNT },
  'notifications.list': { none: OWN_NOTIFICATIONS },
  'notifications.unreadCount': { none: OWN_NOTIFICATIONS },
  'notifications.markRead': { none: OWN_NOTIFICATIONS },
  'notifications.markAllRead': { none: OWN_NOTIFICATIONS },
  'notifications.preferences': { none: OWN_NOTIFICATIONS },
  'notifications.pushSubscription': { none: OWN_NOTIFICATIONS },
  'notifications.pushSubscriptionRemove': { none: OWN_NOTIFICATIONS },
  'presence.team': { none: PRESENCE },
  'members.directory': { none: TEAM_PEOPLE },
  'invitations.byToken': { none: INVITE },
  'invitations.accept': { none: INVITE },
  'organizations.current': { none: ORGANIZATION },
  'organizations.stores': { none: ORGANIZATION },
  'organizations.storeById': { none: ORGANIZATION },
  'organizations.auditLog': { none: ORGANIZATION },
  'settings.members': { none: TEAM_ADMIN },
  'settings.memberById': { none: TEAM_ADMIN },
  'settings.memberSuspend': { none: TEAM_ADMIN },
  'settings.memberReactivate': { none: TEAM_ADMIN },
  'settings.invitations': { none: TEAM_ADMIN },
  'settings.invitationById': { none: TEAM_ADMIN },
  'settings.invitationResend': { none: TEAM_ADMIN },
  'settings.roles': { none: TEAM_ADMIN },
  'settings.roleById': { none: TEAM_ADMIN },
  'settings.safety': { none: SECURITY_SETTINGS },
  'settings.webhooks': { none: SECURITY_SETTINGS },
  'settings.webhookById': { none: SECURITY_SETTINGS },
  'settings.webhookDeliveries': { none: SECURITY_SETTINGS },
  'settings.apiKeys': { none: SECURITY_SETTINGS },
  'settings.apiKeyById': { none: SECURITY_SETTINGS },
  'settings.retention': { none: SECURITY_SETTINGS },
  'plugins.list': { none: PLUGIN_ADMIN },
  'plugins.available': { none: PLUGIN_ADMIN },
  'plugins.install': { none: PLUGIN_ADMIN },
  'plugins.register': { none: PLUGIN_ADMIN },
  'plugins.byId': { none: PLUGIN_ADMIN },
  'plugins.enable': { none: PLUGIN_ADMIN },
  'plugins.disable': { none: PLUGIN_ADMIN },
  'plugins.revoke': { none: PLUGIN_ADMIN },
  'plugins.config': { none: PLUGIN_ADMIN },
  'compliance.dsr': { none: COMPLIANCE },
  'compliance.dsrById': { none: COMPLIANCE },
  'compliance.dsrVerify': { none: COMPLIANCE },
  'compliance.consent': { none: COMPLIANCE },
  'compliance.cookieConsent': { none: COMPLIANCE },
  // Public routes
  'webhooks.resend': { none: PUBLIC },
  'webhooks.channel': { none: PUBLIC },
  'webhooks.carrier': { none: PUBLIC },
  'widget.bootstrap': { none: PUBLIC },
  'widget.messages': { none: PUBLIC },
  'widget.upload': { none: PUBLIC },
  'widget.download': { none: PUBLIC },
  'channels.oauthCallback': { none: PUBLIC },

  // Conversations and messages (`conversations:*` and `messages:*` exist)
  'conversations.list': { scope: 'conversations:read' },
  'conversations.byId': { scope: 'conversations:read' },
  'conversations.messages': { scope: ['conversations:read', 'messages:read'] },
  'conversations.origins': { scope: 'conversations:read' },
  'conversations.messagingWindow': { scope: 'conversations:read' },
  'conversations.assign': { scope: 'conversations:write' },
  'conversations.status': { scope: 'conversations:write' },
  'conversations.snooze': { scope: 'conversations:write' },
  'conversations.tags': { scope: 'conversations:write' },
  'conversations.tagById': { scope: 'conversations:write' },
  'conversations.read': { scope: 'conversations:write' },
  'conversations.unread': { scope: 'conversations:write' },
  'conversations.bulk': { scope: 'conversations:write' },
  'conversations.export': { proposed: ['conversations:read', 'exports:write'], step: STEP },
  'messages.create': { scope: 'messages:write' },
  'messages.byId': { scope: 'messages:write' },
  'messages.resend': { scope: 'messages:write' },
  'messages.discard': { scope: 'messages:write' },
  'messages.resendCaption': { scope: 'messages:write' },
  'messages.refetchFile': { scope: 'messages:write' },
  'messages.reaction': { scope: ['conversations:read', 'messages:write'] },
  'messages.deletedContent': {
    proposed: ['conversations:read', 'messages:read-deleted'],
    step: STEP
  },
  'messages.revisions': { scope: 'messages:read' },

  // Customers (`customers:*` exist)
  'customers.list': { scope: ['customers:read', 'customers:write'] },
  'customers.byId': { scope: ['customers:read', 'customers:write'] },
  'customers.identities': { scope: ['customers:read', 'customers:write'] },
  'customers.identityById': { scope: 'customers:write' },
  'customers.merge': { proposed: 'customers:merge', step: STEP },
  'customers.unmerge': { proposed: 'customers:merge', step: STEP },
  'customers.mergePreview': { proposed: 'customers:merge', step: STEP },
  'customers.orders': { scope: 'customers:read' },
  'customers.conversations': { scope: 'customers:read' },
  'customers.notes': { scope: ['customers:read', 'customers:write'] },
  'customers.noteById': { scope: 'customers:write' },
  'customers.addresses': { scope: ['customers:read', 'customers:write'] },
  'customers.addressById': { scope: 'customers:write' },
  'customers.tags': { scope: ['customers:read', 'customers:write'] },
  'customers.tagById': { scope: 'customers:write' },
  'customers.media': { proposed: ['customers:read', 'media:read'], step: STEP },
  'customers.timeline': { scope: 'customers:read' },
  'customers.caution': { scope: 'customers:write' },
  'customers.export': { proposed: ['customers:read', 'exports:write'], step: STEP },

  // Orders (`orders:*` exist); the messages and templates of an order are a scope of their own
  'orders.list': { scope: ['orders:read', 'orders:write'] },
  'orders.create': { scope: 'orders:write' },
  'orders.byId': { proposed: ['orders:read', 'orders:edit'], step: STEP },
  'orders.cancel': { proposed: 'orders:cancel', step: STEP },
  'orders.status': { scope: 'orders:write' },
  'orders.items': { proposed: 'orders:edit', step: STEP },
  'orders.print': { none: ORDER_PRINT },
  'orders.export': { proposed: ['orders:read', 'exports:write'], step: STEP },
  'orders.confirm': { proposed: 'orders:confirm', step: STEP },
  'orders.confirmBulk': { proposed: 'orders:confirm', step: STEP },
  'orders.copy': { scope: ['orders:read', 'orders:write'] },
  'orders.messages': { proposed: ['order-messages:read', 'order-messages:write'], step: STEP },
  'orders.payment': { proposed: 'orders:edit', step: STEP },
  'orders.priceApprovalApprove': { proposed: 'orders:approve-price', step: STEP },
  'orders.priceApprovalReject': { proposed: 'orders:approve-price', step: STEP },
  'orderTemplates.list': { proposed: ['order-messages:read', 'order-templates:write'], step: STEP },
  'orderTemplates.preview': { proposed: 'order-templates:write', step: STEP },
  'orderTemplates.byKindAndLocale': {
    proposed: ['order-messages:read', 'order-templates:write'],
    step: STEP
  },

  // Catalog (`products:read` exists; writing a product is `products:write`)
  'products.list': { proposed: ['products:read', 'products:write'], step: STEP },
  'products.create': { proposed: 'products:write', step: STEP },
  'products.byId': { proposed: ['products:read', 'products:write'], step: STEP },
  'products.variants': { proposed: ['products:read', 'products:write'], step: STEP },
  'products.images': { proposed: ['products:read', 'products:write'], step: STEP },
  'products.variantById': { proposed: 'products:write', step: STEP },
  'products.search': { scope: 'products:read' },
  'products.inventory': { scope: 'inventory:read' },

  // Stock (`inventory:*` exist; the warehouses, transfers and counts are scopes of their own)
  'warehouses.list': { proposed: ['warehouses:read', 'warehouses:write'], step: STEP },
  'warehouses.create': { proposed: 'warehouses:write', step: STEP },
  'warehouses.byId': { proposed: ['warehouses:read', 'warehouses:write'], step: STEP },
  'warehouses.stores': { proposed: ['warehouses:read', 'warehouses:write'], step: STEP },
  'inventory.levels': { scope: 'inventory:read' },
  'inventory.summary': { scope: 'inventory:read' },
  'inventory.movements': { scope: 'inventory:read' },
  'inventory.kardex': { scope: 'inventory:read' },
  'inventory.adjustments': { scope: 'inventory:write' },
  'transfers.list': { proposed: ['transfers:read', 'transfers:write'], step: STEP },
  'transfers.create': { proposed: 'transfers:write', step: STEP },
  'transfers.byId': { proposed: ['transfers:read', 'transfers:write'], step: STEP },
  'transfers.dispatch': { proposed: 'transfers:write', step: STEP },
  'transfers.receive': { proposed: 'transfers:write', step: STEP },
  'transfers.close': { proposed: 'transfers:write', step: STEP },
  'transfers.cancel': { proposed: 'transfers:write', step: STEP },
  'counts.list': { proposed: ['counts:read', 'counts:write'], step: STEP },
  'counts.create': { proposed: 'counts:write', step: STEP },
  'counts.byId': { proposed: 'counts:read', step: STEP },
  'counts.start': { proposed: 'counts:write', step: STEP },
  'counts.lines': { proposed: ['counts:read', 'counts:write'], step: STEP },
  'counts.submit': { proposed: 'counts:write', step: STEP },
  'counts.reopen': { proposed: 'counts:write', step: STEP },
  'counts.apply': { proposed: 'counts:write', step: STEP },
  'counts.cancel': { proposed: 'counts:write', step: STEP },

  // Shipping (`shipments:*` exist; carriers, pickups, returns and remittances are scopes of their own)
  'carriers.list': { proposed: 'carriers:read', step: STEP },
  'carriers.create': { none: CARRIER_ADMIN },
  'carriers.registry': { proposed: 'carriers:read', step: STEP },
  'carriers.byId': { proposed: 'carriers:read', step: STEP },
  'carriers.test': { none: CARRIER_ADMIN },
  'carriers.disconnect': { none: CARRIER_ADMIN },
  'carriers.webhookSecret': { none: CARRIER_ADMIN },
  'carriers.locations': { proposed: 'carriers:read', step: STEP },
  'carriers.statusMappings': { none: CARRIER_ADMIN },
  'carriers.statusMappingByCode': { none: CARRIER_ADMIN },
  'carriers.unmappedStatuses': { proposed: 'carriers:read', step: STEP },
  'shipments.list': { scope: 'shipments:read' },
  'shipments.byId': { scope: 'shipments:read' },
  'shipments.forOrder': { scope: ['shipments:read', 'shipments:write'] },
  'shipments.bulk': { scope: 'shipments:write' },
  'shipments.bulkJob': { scope: 'shipments:read' },
  'shipments.mergeLabels': { scope: 'shipments:write' },
  'shipments.label': { scope: ['shipments:read', 'shipments:write'] },
  'shipments.cancel': { scope: 'shipments:write' },
  'shipments.status': { scope: 'shipments:write' },
  'shipments.check': { scope: 'shipments:write' },
  'shipments.markVoided': { scope: 'shipments:write' },
  'pickups.list': { proposed: ['pickups:read', 'pickups:write'], step: STEP },
  'pickups.create': { proposed: 'pickups:write', step: STEP },
  'pickups.shipments': { proposed: 'pickups:write', step: STEP },
  'pickups.shipmentById': { proposed: 'pickups:write', step: STEP },
  'pickups.confirm': { proposed: 'pickups:write', step: STEP },
  'pickups.cancel': { proposed: 'pickups:write', step: STEP },
  'pickups.manifest': { proposed: 'pickups:read', step: STEP },
  'returns.list': { proposed: ['returns:read', 'returns:write'], step: STEP },
  'returns.create': { proposed: 'returns:write', step: STEP },
  'returns.byId': { proposed: 'returns:read', step: STEP },
  'returns.approve': { proposed: 'returns:write', step: STEP },
  'returns.reject': { proposed: 'returns:write', step: STEP },
  'returns.cancel': { proposed: 'returns:write', step: STEP },
  'returns.inTransit': { proposed: 'returns:write', step: STEP },
  'returns.receive': { proposed: 'returns:write', step: STEP },
  'returns.complete': { proposed: 'returns:write', step: STEP },
  'returns.returnShipment': { proposed: 'returns:write', step: STEP },
  'returns.reception.batches': { proposed: ['returns:read', 'returns:write'], step: STEP },
  'returns.reception.batchById': { proposed: 'returns:read', step: STEP },
  'returns.reception.scan': { proposed: 'returns:write', step: STEP },
  'returns.reception.itemById': { proposed: 'returns:write', step: STEP },
  'returns.reception.complete': { proposed: 'returns:write', step: STEP },
  'remittances.list': { proposed: ['remittances:read', 'remittances:write'], step: STEP },
  'remittances.byId': { proposed: ['remittances:read', 'remittances:write'], step: STEP },
  'remittances.imports': { proposed: 'remittances:write', step: STEP },
  'remittances.pending': { proposed: 'remittances:read', step: STEP },
  'remittances.lines': { proposed: 'remittances:write', step: STEP },
  'remittances.lineById': { proposed: 'remittances:write', step: STEP },
  'remittances.confirm': { proposed: 'remittances:write', step: STEP },
  'remittances.void': { proposed: 'remittances:write', step: STEP },
  'remittances.importProfiles': { proposed: ['remittances:read', 'remittances:write'], step: STEP },
  'remittances.importProfileById': { proposed: 'remittances:write', step: STEP },

  // Media, exports, search, analytics
  'media.uploadUrl': { proposed: 'media:write', step: STEP },
  'media.confirmUpload': { proposed: 'media:write', step: STEP },
  'media.byId': { proposed: ['media:read', 'media:write'], step: STEP },
  'media.downloadAll': { proposed: 'exports:write', step: STEP },
  'exports.list': { proposed: 'exports:read', step: STEP },
  'exports.byId': { proposed: 'exports:read', step: STEP },
  'exports.download': { proposed: 'exports:read', step: STEP },
  'search.global': { none: BELL_AND_SEARCH },
  'search.messages': { scope: 'messages:read' },
  'search.customers': { scope: 'customers:read' },
  'search.orders': { scope: 'orders:read' },
  'search.products': { scope: 'products:read' },
  'analytics.metrics': { scope: 'analytics:read' },
  'analytics.dashboard': { scope: 'analytics:read' },
  'analytics.reports': { scope: 'analytics:read' },
  'analytics.reportById': { scope: 'analytics:read' },
  'analytics.export': { proposed: ['analytics:read', 'exports:write'], step: STEP },

  // Channels and settings
  'channels.connections': { none: CHANNEL_ADMIN },
  'channels.directory': { proposed: 'channels:read', step: STEP },
  'channels.connect': { none: CHANNEL_ADMIN },
  'channels.connectionById': { none: CHANNEL_ADMIN },
  'channels.test': { none: CHANNEL_ADMIN },
  'channels.disconnect': { none: CHANNEL_ADMIN },
  'channels.updateToken': { none: CHANNEL_ADMIN },
  'channels.label': { none: CHANNEL_ADMIN },
  'channels.templates': { proposed: 'channels:read', step: STEP },
  'channels.widgetEmbed': { none: CHANNEL_ADMIN },
  'channels.widgetOrigins': { none: CHANNEL_ADMIN },
  'channels.widgetPreChat': { none: CHANNEL_ADMIN },
  'channels.oauthStart': { none: CHANNEL_ADMIN },
  'channels.oauthAssets': { none: CHANNEL_ADMIN },
  'channels.oauthComplete': { none: CHANNEL_ADMIN },
  'channels.oauthSession': { none: CHANNEL_ADMIN },
  'settings.inbox': { none: SETTINGS_ADMIN },
  'settings.inboxBehavior': { none: SETTINGS_ADMIN },
  'settings.preferences': { proposed: ['settings:read', 'settings:write'], step: STEP },
  'settings.inventory': { proposed: ['inventory:read', 'settings:write'], step: STEP },
  'settings.routing': { none: SETTINGS_ADMIN },
  'settings.routingOrder': { none: SETTINGS_ADMIN },
  'settings.routingRuleById': { none: SETTINGS_ADMIN },
  'settings.businessHours': { none: SETTINGS_ADMIN },
  'settings.tags': { proposed: ['tags:read', 'tags:write'], step: STEP },
  'settings.tagById': { proposed: ['tags:read', 'tags:write'], step: STEP },
  'settings.snippets': { none: SETTINGS_ADMIN },
  'settings.snippetById': { none: SETTINGS_ADMIN }
}
