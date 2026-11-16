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

const CUSTOMER_MERGE =
  'Merging customers, undoing a merge and its preview: the merge writes who did it (`mergedById`), and the profile names that person, so it waits for a plugin to have an actor of its own to show (Step 5.6 W1); the permission has no scope either'
const CUSTOMER_NOTE_AUTHOR =
  'Writing and deleting the notes of a customer: a note keeps its author, a person the profile shows by name, and only the author or CUSTOMERS_DELETE may remove it; a plugin reads the notes (GET) and does not write them until it has an actor to show (Step 5.6 W1)'

const ANALYTICS_DASHBOARD =
  'No server route of its own: the dashboard is drawn by the web from the metrics, which a plugin reads at /plugin-api/analytics/metrics'
const ANALYTICS_REPORTS =
  'The scheduled reports send the figures out by email to addresses of people, and a report keeps who made it: a plugin reads the metrics and asks for a file of them, and the reports wait for an actor that the screen can show (Step 5.6 PR E7-2)'

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
const WIDGET_HOST =
  'The host of the widgets in the agent sidebar (TDD_10 §7): the signed-in agent’s page lists them, opens a session for one conversation and forwards what a frame asks over its port; a plugin has no sidebar of its own to host and reaches the same data through its own scopes'
const COMPLIANCE = 'Data subject requests and consent: a person, and the owner who answers them'
const PUBLIC =
  'Public route that authenticates by its own means (signature, state or site key); never with the key of a plugin'
const ORDER_PRINT =
  'No server route that a plugin needs: the sheet is printed by the browser from the order a plugin already reads'
const CARRIER_ADMIN =
  'The credentials, webhook secret and status mappings of a carrier connection: owner only, secrets never leave the store'
const GUIDE_BALANCE =
  'What the owner paid for prepaid guides and the refund terms agreed with a carrier: owner only (Admin preset), finance data that no plugin scope needs'
const CHANNEL_ADMIN =
  'The connection of a channel account (tokens, labels, OAuth): owner only; a channel plugin registers its own through plugin-api/channel (Step 5.6)'
const SETTINGS_ADMIN =
  'A setting of how the store works (routing, hours, snippets, inbox behaviour): the owner decides it, a plugin reads the effect'
const OWN_PERFORMANCE =
  'The figures of one person for their inbox widget: the id comes from the token; a plugin reads the metrics of the store'
const SEARCH_CLICK =
  'The record that a person opened a search result, written from the screen the person is using: a plugin has no palette or results page to click on'
const SEARCH_REPORT =
  'The report of what people searched in the store, for the dashboard: a plugin has no screen for it and reads the metrics of the store'
const FINANCE =
  'The books of the organization (TDD_18 §14): finance is not exposed to plugins in the MVP, so no scope reaches the ledger, the chart or the periods'
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
  'settings.webhookSecret': { none: SECURITY_SETTINGS },
  'settings.apiKeys': { none: SECURITY_SETTINGS },
  'settings.apiKeyById': { none: SECURITY_SETTINGS },
  'settings.retention': { none: SECURITY_SETTINGS },
  'plugins.available': { none: PLUGIN_ADMIN },
  'plugins.install': { none: PLUGIN_ADMIN },
  'plugins.register': { none: PLUGIN_ADMIN },
  'plugins.byId': { none: PLUGIN_ADMIN },
  'plugins.revoke': { none: PLUGIN_ADMIN },
  'plugins.consent': { none: PLUGIN_ADMIN },
  'plugins.setupCode': { none: PLUGIN_ADMIN },
  'plugins.commandSecret': { none: PLUGIN_ADMIN },
  'pluginWidgets.list': { none: WIDGET_HOST },
  'pluginWidgets.sessions': { none: WIDGET_HOST },
  'pluginWidgets.bridge': { none: WIDGET_HOST },
  'pluginWidgets.settings': { none: PLUGIN_ADMIN },
  'pluginWidgets.visibility': { none: PLUGIN_ADMIN },
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
  'conversations.list': { scope: 'conversations:read', exposed: '/plugin-api/conversations' },
  'conversations.byId': { scope: 'conversations:read', exposed: '/plugin-api/conversations/:id' },
  'conversations.messages': { scope: ['conversations:read', 'messages:read'] },
  'conversations.origins': {
    scope: ['conversations:read', 'messages:read'],
    exposed: '/plugin-api/conversations/:id/origins'
  },
  'conversations.messagingWindow': {
    scope: 'conversations:read',
    exposed: '/plugin-api/conversations/:id/messaging-window'
  },
  'conversations.assign': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/:id/assign'
  },
  'conversations.status': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/:id/status'
  },
  'conversations.snooze': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/:id/snooze'
  },
  'conversations.tags': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/:id/tags'
  },
  'conversations.tagById': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/:id/tags/:tagId'
  },
  'conversations.read': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/:id/read'
  },
  'conversations.unread': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/:id/unread'
  },
  'conversations.bulk': {
    scope: ['conversations:read', 'conversations:write'],
    exposed: '/plugin-api/conversations/bulk'
  },
  'conversations.export': { scope: ['conversations:read', 'exports:write'] },
  // Seeing a conversation is `conversations:read` for a plugin as for a person, so each message route names it too
  'messages.create': {
    scope: ['conversations:read', 'messages:write'],
    exposed: '/plugin-api/messages'
  },
  // PR M1c: the core takes an actor that is not a person (`ActorIdentity`), so a plugin edits, deletes, sends again, discards and reacts.
  // PATCH/DELETE of an id are one key; deleting needs MESSAGES_DELETE, which only the scope `messages:delete` grants
  'messages.byId': {
    scope: ['conversations:read', 'messages:write', 'messages:delete'],
    exposed: '/plugin-api/messages/:id'
  },
  'messages.resend': {
    scope: ['conversations:read', 'messages:write'],
    exposed: '/plugin-api/messages/:id/resend'
  },
  'messages.discard': {
    scope: ['conversations:read', 'messages:write', 'messages:delete'],
    exposed: '/plugin-api/messages/:id/discard'
  },
  'messages.resendCaption': {
    scope: ['conversations:read', 'messages:write'],
    exposed: '/plugin-api/messages/:id/resend-caption'
  },
  'messages.refetchFile': {
    scope: ['conversations:read', 'messages:write'],
    exposed: '/plugin-api/messages/:id/files/:index/refetch'
  },
  'messages.reaction': {
    scope: ['conversations:read', 'messages:write'],
    exposed: '/plugin-api/messages/:id/reaction'
  },
  'messages.deletedContent': {
    scope: ['conversations:read', 'messages:read-deleted'],
    exposed: '/plugin-api/messages/:id/deleted-content'
  },
  'messages.revisions': {
    scope: ['conversations:read', 'messages:read'],
    exposed: '/plugin-api/messages/:id/revisions'
  },

  // Customers (`customers:*` exist)
  'customers.list': {
    scope: ['customers:read', 'customers:write'],
    exposed: '/plugin-api/customers'
  },
  'customers.byId': {
    scope: ['customers:read', 'customers:write', 'customers:delete'],
    exposed: '/plugin-api/customers/:id'
  },
  'customers.identities': {
    scope: ['customers:read', 'customers:write'],
    exposed: '/plugin-api/customers/:id/identities'
  },
  'customers.identityById': {
    scope: ['customers:read', 'customers:write'],
    exposed: '/plugin-api/customers/:id/identities/:identityId'
  },
  'customers.merge': { none: CUSTOMER_MERGE },
  'customers.unmerge': { none: CUSTOMER_MERGE },
  'customers.mergePreview': { none: CUSTOMER_MERGE },
  'customers.orders': {
    scope: ['customers:read', 'orders:read'],
    exposed: '/plugin-api/customers/:id/orders'
  },
  'customers.conversations': {
    scope: ['customers:read', 'conversations:read'],
    exposed: '/plugin-api/customers/:id/conversations'
  },
  // The notes are read; writing one is CUSTOMER_NOTE_AUTHOR
  'customers.notes': {
    scope: 'customers:read',
    exposed: '/plugin-api/customers/:id/notes'
  },
  'customers.noteById': { none: CUSTOMER_NOTE_AUTHOR },
  'customers.addresses': {
    scope: ['customers:read', 'customers:write'],
    exposed: '/plugin-api/customers/:id/addresses'
  },
  'customers.addressById': {
    scope: ['customers:read', 'customers:write'],
    exposed: '/plugin-api/customers/:id/addresses/:addressId'
  },
  'customers.tags': {
    scope: ['customers:read', 'customers:write'],
    exposed: '/plugin-api/customers/:id/tags'
  },
  'customers.tagById': {
    scope: ['customers:read', 'customers:write'],
    exposed: '/plugin-api/customers/:id/tags/:tagId'
  },
  'customers.media': { scope: ['customers:read', 'media:read'] },
  'customers.timeline': {
    scope: 'customers:read',
    exposed: '/plugin-api/customers/:id/timeline'
  },
  'customers.caution': {
    scope: ['customers:read', 'customers:flag-caution'],
    exposed: '/plugin-api/customers/:id/caution'
  },
  'customers.export': { scope: ['customers:read', 'exports:write'] },

  // Orders (`orders:*` exist); the messages and templates of an order are a scope of their own
  'orders.list': { scope: 'orders:read', exposed: '/plugin-api/orders' },
  'orders.create': { scope: ['orders:read', 'orders:write'], exposed: '/plugin-api/orders' },
  // The GET is exposed by PR E3a (`orders:read`) and the PATCH by PR E3b (`orders:edit`, with the plugin as the actor)
  'orders.byId': {
    scope: ['orders:read', 'orders:edit'],
    exposed: '/plugin-api/orders/:id'
  },
  'orders.cancel': {
    scope: ['orders:read', 'orders:cancel'],
    exposed: '/plugin-api/orders/:id/cancel'
  },
  'orders.status': {
    scope: ['orders:read', 'orders:write'],
    exposed: '/plugin-api/orders/:id/status'
  },
  // The lines of an order are edited through the PATCH of the order itself (`items`): there is no route of the people for them either
  'orders.items': { scope: ['orders:read', 'orders:edit'], exposed: '/plugin-api/orders/:id' },
  'orders.print': { none: ORDER_PRINT },
  'orders.export': { scope: ['orders:read', 'exports:write'] },
  'orders.confirm': {
    scope: ['orders:read', 'orders:confirm'],
    exposed: '/plugin-api/orders/:id/confirm'
  },
  'orders.confirmBulk': {
    scope: ['orders:read', 'orders:confirm'],
    exposed: '/plugin-api/orders/confirm-bulk'
  },
  // The draft carries the customer, the address, the phones and the product ids that `orders:read` withholds, so the route names the
  // scope of each (PR E3a debt (c)), and it leaves out the internal and packing notes (a plugin never reads them)
  'orders.copy': {
    scope: ['orders:read', 'orders:write', 'customers:read', 'products:read'],
    exposed: '/plugin-api/orders/:id/copy'
  },
  // The GET (the history) is `orders:read` + `order-messages:read` (PR E3a); sending a message is `order-messages:write` (PR E3b)
  'orders.messages': {
    scope: ['orders:read', 'order-messages:read', 'order-messages:write'],
    exposed: '/plugin-api/orders/:id/messages'
  },
  'orders.payment': {
    scope: ['orders:read', 'orders:edit'],
    exposed: '/plugin-api/orders/:id/payment'
  },
  'orders.priceApprovalApprove': {
    scope: ['orders:read', 'orders:approve-price'],
    exposed: '/plugin-api/orders/:id/price-approval/approve'
  },
  'orders.priceApprovalReject': {
    scope: ['orders:read', 'orders:approve-price'],
    exposed: '/plugin-api/orders/:id/price-approval/reject'
  },
  'orderTemplates.list': { scope: 'order-messages:read', exposed: '/plugin-api/order-templates' },
  'orderTemplates.preview': {
    scope: 'order-templates:write',
    exposed: '/plugin-api/order-templates/preview'
  },
  // The GET is `order-messages:read` (PR E3a); the PUT and the DELETE are `order-templates:write` (PR E3b, audited as the plugin)
  'orderTemplates.byKindAndLocale': {
    scope: ['order-messages:read', 'order-templates:write'],
    exposed: '/plugin-api/order-templates/:kind/locales/:locale'
  },

  // Catalog (Step 5.6 PR E4a). Every route holds `products:read`, a write `products:write` besides and a delete `products:delete`
  // instead; no scope grants the cost or the tax of a product, so a plugin neither reads nor writes them
  'products.list': {
    scope: ['products:read', 'products:write'],
    exposed: '/plugin-api/products'
  },
  'products.create': {
    scope: 'products:write',
    exposed: '/plugin-api/products'
  },
  'products.byId': {
    scope: ['products:read', 'products:write', 'products:delete'],
    exposed: '/plugin-api/products/:id'
  },
  'products.variants': {
    scope: ['products:read', 'products:write'],
    exposed: '/plugin-api/products/:id/variants'
  },
  'products.images': {
    scope: ['products:read', 'products:write'],
    exposed: '/plugin-api/products/:id/images'
  },
  'products.variantById': {
    scope: ['products:write', 'products:delete'],
    exposed: '/plugin-api/products/:id/variants/:variantId'
  },
  'products.search': { scope: 'products:read', exposed: '/plugin-api/products/search' },
  'products.inventory': { scope: 'inventory:read', exposed: '/plugin-api/products/:id/inventory' },

  // Finance (the books of the organization; no plugin scope in the MVP)
  'finance.setup': { none: FINANCE },
  'finance.settings': { none: FINANCE },
  'finance.accounts.list': { none: FINANCE },
  'finance.accounts.create': { none: FINANCE },
  'finance.accounts.byId': { none: FINANCE },
  'finance.accounts.deactivate': { none: FINANCE },
  'finance.accounts.reactivate': { none: FINANCE },
  'finance.accountRoles.list': { none: FINANCE },
  'finance.accountRoles.byRole': { none: FINANCE },
  'finance.taxRates.list': { none: FINANCE },
  'finance.taxRates.create': { none: FINANCE },
  'finance.taxRates.byId': { none: FINANCE },
  'finance.taxRates.deactivate': { none: FINANCE },
  'finance.taxRates.reactivate': { none: FINANCE },
  'finance.reports.vat': { none: FINANCE },
  'finance.reports.vatCsv': { none: FINANCE },
  'finance.reports.trialBalance': { none: FINANCE },
  'finance.reports.ledger': { none: FINANCE },
  'finance.reports.trialBalanceCsv': { none: FINANCE },
  'finance.reports.ledgerCsv': { none: FINANCE },
  'finance.reports.journalCsv': { none: FINANCE },
  'finance.reports.verifyChain': { none: FINANCE },
  'finance.periods.close': { none: FINANCE },
  'finance.periods.reopen': { none: FINANCE },
  'finance.storeTaxSettings': { none: FINANCE },
  'finance.paymentAccounts.list': { none: FINANCE },
  'finance.paymentAccounts.set': { none: FINANCE },
  'finance.paymentAccounts.byId': { none: FINANCE },
  'finance.periods.list': { none: FINANCE },
  'finance.periods.open': { none: FINANCE },
  'finance.periods.byId': { none: FINANCE },
  'finance.entries.list': { none: FINANCE },
  'finance.entries.manual': { none: FINANCE },
  'finance.entries.byId': { none: FINANCE },
  'finance.entries.reverse': { none: FINANCE },
  'finance.transactions.list': { none: FINANCE },
  'finance.transactions.record': { none: FINANCE },
  'finance.transactions.byId': { none: FINANCE },
  'finance.transactions.void': { none: FINANCE },
  'finance.transactions.replace': { none: FINANCE },
  'finance.transactions.document': { none: FINANCE },
  'finance.bank.profiles': { none: FINANCE },
  'finance.bank.profileById': { none: FINANCE },
  'finance.bank.profilePreview': { none: FINANCE },
  'finance.bank.imports': { none: FINANCE },
  'finance.bank.importById': { none: FINANCE },
  'finance.bank.importLines': { none: FINANCE },
  'finance.bank.confirmExact': { none: FINANCE },
  'finance.bank.difference': { none: FINANCE },
  'finance.bank.lineMatches': { none: FINANCE },
  'finance.bank.lineRejections': { none: FINANCE },
  'finance.bank.lineRegisterDraft': { none: FINANCE },
  'finance.bank.matchUndo': { none: FINANCE },
  'finance.bank.status': { none: FINANCE },
  'finance.balances': { none: FINANCE },
  'finance.postings': { none: FINANCE },
  'finance.postingRetry': { none: FINANCE },
  'fiscal.providers': { none: FINANCE },
  'fiscal.issuer': { none: FINANCE },
  'fiscal.documents.list': { none: FINANCE },
  'fiscal.documents.byId': { none: FINANCE },
  'fiscal.documents.receiver': { none: FINANCE },
  'fiscal.documents.retry': { none: FINANCE },
  'fiscal.documents.void': { none: FINANCE },
  'suppliers.list': { none: FINANCE },
  'suppliers.create': { none: FINANCE },
  'suppliers.byId': { none: FINANCE },
  'suppliers.update': { none: FINANCE },
  'suppliers.payables': { none: FINANCE },
  'suppliers.balance': { none: FINANCE },
  'suppliers.payments': { none: FINANCE },
  'suppliers.recordPayment': { none: FINANCE },
  'supplierPayments.void': { none: FINANCE },
  'purchaseOrders.list': { none: FINANCE },
  'purchaseOrders.create': { none: FINANCE },
  'purchaseOrders.byId': { none: FINANCE },
  'purchaseOrders.update': { none: FINANCE },
  'purchaseOrders.order': { none: FINANCE },
  'purchaseOrders.receive': { none: FINANCE },
  'purchaseOrders.close': { none: FINANCE },
  'purchaseOrders.cancel': { none: FINANCE },
  'purchaseOrders.payments': { none: FINANCE },
  'purchaseOrders.recordPayment': { none: FINANCE },

  // Stock (Step 5.6 PR E4a reads it; the transfers and counts are scopes of their own, PR E4b)
  'warehouses.list': {
    scope: 'warehouses:read',
    exposed: '/plugin-api/warehouses'
  },
  // The writes of a warehouse (create, change) are organization-wide (ORG_MANAGE_WAREHOUSES) and a key is bound to one store: PR E4a-2
  // did NOT expose them, and the decision on their reach is the owner's ("Left by PR E4a-2" (a) in the plan). The GET of `byId` is exposed
  'warehouses.create': { proposed: 'warehouses:write', step: STEP },
  'warehouses.byId': {
    proposed: ['warehouses:read', 'warehouses:write'],
    step: STEP,
    exposed: '/plugin-api/warehouses/:id'
  },
  // Replacing the store links of a warehouse moves it between stores of the organization, and the key of a plugin is bound to one
  // store: not exposed until the owner decides the plugin's reach over other stores ("Left by PR E4a-2" (a) in the plan)
  'warehouses.stores': { proposed: ['warehouses:read', 'warehouses:write'], step: STEP },
  'inventory.levels': { scope: 'inventory:read', exposed: '/plugin-api/inventory/levels' },
  'inventory.summary': { scope: 'inventory:read', exposed: '/plugin-api/inventory/summary' },
  'inventory.movements': { scope: 'inventory:read', exposed: '/plugin-api/inventory/movements' },
  'inventory.kardex': { scope: 'inventory:read', exposed: '/plugin-api/inventory/kardex' },
  // The movement of an adjustment records the plugin as its author (`createdByPluginId`, the actor of PR M1c), PR E4a-2
  'inventory.adjustments': {
    scope: ['inventory:read', 'inventory:write'],
    exposed: '/plugin-api/inventory/adjustments'
  },
  // Transfers and counts (Step 5.6 PR E4b reads, PR E4b-2 writes): a scope of its own each, and a write names its own scope AND the
  // read one. A key is bound to ONE store, so it reads the lines of its store and the transfers and counts that have one (a key of a
  // sibling store, or of another organization, gets a 404), and WRITES only a transfer whose every line is of its store (409
  // otherwise) and a count limited to its store (403 otherwise, and a count it opens is limited to it). The transfer, the count, the
  // movements of stock and the audit entry name the plugin (migration `stock_plugin_actor`).
  'transfers.list': { scope: 'transfers:read', exposed: '/plugin-api/transfers' },
  'transfers.create': {
    scope: ['transfers:write', 'transfers:read'],
    exposed: '/plugin-api/transfers'
  },
  // The GET is read, the PATCH (change a draft) a write of the same path
  'transfers.byId': {
    scope: ['transfers:read', 'transfers:write'],
    exposed: '/plugin-api/transfers/:id'
  },
  'transfers.dispatch': {
    scope: ['transfers:write', 'transfers:read'],
    exposed: '/plugin-api/transfers/:id/dispatch'
  },
  'transfers.receive': {
    scope: ['transfers:receive', 'transfers:read'],
    exposed: '/plugin-api/transfers/:id/receive'
  },
  'transfers.close': {
    scope: ['transfers:receive', 'transfers:read'],
    exposed: '/plugin-api/transfers/:id/close'
  },
  'transfers.cancel': {
    scope: ['transfers:write', 'transfers:read'],
    exposed: '/plugin-api/transfers/:id/cancel'
  },
  'counts.list': { scope: 'counts:read', exposed: '/plugin-api/counts' },
  'counts.create': { scope: ['counts:write', 'counts:read'], exposed: '/plugin-api/counts' },
  'counts.byId': { scope: 'counts:read', exposed: '/plugin-api/counts/:id' },
  'counts.start': {
    scope: ['counts:write', 'counts:read'],
    exposed: '/plugin-api/counts/:id/start'
  },
  'counts.lines': {
    scope: ['counts:write', 'counts:read'],
    exposed: '/plugin-api/counts/:id/lines'
  },
  'counts.submit': {
    scope: ['counts:write', 'counts:read'],
    exposed: '/plugin-api/counts/:id/submit'
  },
  'counts.reopen': {
    scope: ['counts:write', 'counts:read'],
    exposed: '/plugin-api/counts/:id/reopen'
  },
  'counts.apply': {
    scope: ['counts:apply', 'counts:read'],
    exposed: '/plugin-api/counts/:id/apply'
  },
  'counts.cancel': {
    scope: ['counts:write', 'counts:read'],
    exposed: '/plugin-api/counts/:id/cancel'
  },

  // Shipping (`shipments:*` exist; carriers, pickups, returns and remittances are scopes of their own). Step 5.6 PR E5 exposes the
  // reads of shipments, carrier connections and pickups, over the same services as the screens, for the one store of the key. The
  // views of a plugin name their fields (no credentials, no webhook secret, no fees, commission or rates of a carrier, no cost or
  // remittance of a guide, no id of a person). Everything that writes, the link of a label and the run of labels wait for PR E5-2.
  'carriers.list': { scope: 'carriers:read', exposed: '/plugin-api/carriers' },
  'carriers.create': { none: CARRIER_ADMIN },
  'carriers.registry': { scope: 'carriers:read', exposed: '/plugin-api/carriers/registry' },
  // The GET is exposed; the PATCH of a connection is the owner's and has no plugin route
  'carriers.byId': { scope: 'carriers:read', exposed: '/plugin-api/carriers/:id' },
  'carriers.test': { none: CARRIER_ADMIN },
  'carriers.disconnect': { none: CARRIER_ADMIN },
  'carriers.webhookSecret': { none: CARRIER_ADMIN },
  // Asks the carrier with the credentials of the owner on every call, and the plugin limit is per IP: waits for PR E5-2 (a budget per installation)
  'carriers.locations': { scope: 'carriers:read' },
  'carriers.statusCatalog': {
    scope: 'carriers:read',
    exposed: '/plugin-api/carriers/:id/status-catalog'
  },
  'carriers.statusMappings': { none: CARRIER_ADMIN },
  'carriers.statusMappingByCode': { none: CARRIER_ADMIN },
  'carriers.unmappedStatuses': {
    scope: 'carriers:read',
    exposed: '/plugin-api/carriers/:id/unmapped-statuses'
  },
  'carriers.guideBalance': { none: GUIDE_BALANCE },
  'carriers.guideMovements': { none: GUIDE_BALANCE },
  'carriers.guidePurchases': { none: GUIDE_BALANCE },
  'carriers.guidePurchaseVoid': { none: GUIDE_BALANCE },
  'carriers.guideAdjustments': { none: GUIDE_BALANCE },
  'carriers.guidePolicy': { none: GUIDE_BALANCE },
  'carriers.benefit': { none: GUIDE_BALANCE },
  'carriers.benefitPeriods': { none: GUIDE_BALANCE },
  'shipments.list': { scope: 'shipments:read', exposed: '/plugin-api/shipments' },
  'shipments.byId': { scope: 'shipments:read', exposed: '/plugin-api/shipments/:id' },
  'shipments.forOrder': { scope: ['shipments:read', 'shipments:write'] },
  'shipments.bulk': { scope: 'shipments:write' },
  'shipments.bulkJob': { scope: 'shipments:read' },
  'shipments.mergeLabels': { scope: 'shipments:write' },
  'shipments.label': { scope: ['shipments:read', 'shipments:write'] },
  'shipments.cancel': { scope: 'shipments:write' },
  'shipments.status': { scope: 'shipments:write' },
  'shipments.check': { scope: 'shipments:write' },
  'shipments.markVoided': { scope: 'shipments:write' },
  'pickups.list': { scope: 'pickups:read', exposed: '/plugin-api/pickups' },
  'pickups.create': { proposed: 'pickups:write', step: STEP },
  'pickups.shipments': { proposed: 'pickups:write', step: STEP },
  'pickups.shipmentById': { proposed: 'pickups:write', step: STEP },
  'pickups.confirm': { proposed: 'pickups:write', step: STEP },
  'pickups.cancel': { proposed: 'pickups:write', step: STEP },
  // Names the recipients and the guide, shipment and order of each parcel: `customers:read` and `shipments:read` as well
  'pickups.manifest': {
    scope: ['pickups:read', 'customers:read', 'shipments:read'],
    exposed: '/plugin-api/pickups/:id/manifest'
  },
  // Step 5.6 PR E6: the returns, the batches of the scanner that receives them and the remittances of cash collected on delivery are
  // exposed READ ONLY (`returns:read`, `remittances:read`, which grant RETURNS_VIEW and REMITTANCES_VIEW). Every write stores the id of a
  // person (`createdBy`, who approved, who received, who confirmed or voided a remittance), puts stock back through movements that
  // keep a person, may make a replacement order or a return guide that costs money, or moves money (confirming a remittance settles
  // what a carrier owes): they wait for PR E6-2 and the plugin actor of the contract of M1c, with scopes of their own.
  'returns.list': {
    proposed: ['returns:read', 'returns:write'],
    step: STEP,
    exposed: '/plugin-api/returns'
  },
  'returns.create': { proposed: 'returns:write', step: STEP },
  'returns.byId': { scope: 'returns:read', exposed: '/plugin-api/returns/:id' },
  'returns.approve': { proposed: 'returns:write', step: STEP },
  'returns.reject': { proposed: 'returns:write', step: STEP },
  'returns.cancel': { proposed: 'returns:write', step: STEP },
  'returns.inTransit': { proposed: 'returns:write', step: STEP },
  'returns.receive': { proposed: 'returns:write', step: STEP },
  'returns.complete': { proposed: 'returns:write', step: STEP },
  'returns.returnShipment': { proposed: 'returns:write', step: STEP },
  // The GET lists the batches; the POST opens one in the name of a person and stays pending
  'returns.reception.batches': {
    proposed: ['returns:read', 'returns:write'],
    step: STEP,
    exposed: '/plugin-api/returns/reception/batches'
  },
  'returns.reception.batchById': {
    scope: 'returns:read',
    exposed: '/plugin-api/returns/reception/batches/:id'
  },
  'returns.reception.scan': { proposed: 'returns:write', step: STEP },
  'returns.reception.itemById': { proposed: 'returns:write', step: STEP },
  'returns.reception.complete': { proposed: 'returns:write', step: STEP },
  // The GET is exposed; the POST (a draft) is a write and stays pending with the others
  'remittances.list': {
    proposed: ['remittances:read', 'remittances:write'],
    step: STEP,
    exposed: '/plugin-api/remittances'
  },
  // The GET is exposed; the DELETE (a draft) is a write
  'remittances.byId': {
    proposed: ['remittances:read', 'remittances:write'],
    step: STEP,
    exposed: '/plugin-api/remittances/:id'
  },
  'remittances.imports': { proposed: 'remittances:write', step: STEP },
  'remittances.importPreview': { proposed: 'remittances:write', step: STEP },
  'remittances.pending': { scope: 'remittances:read', exposed: '/plugin-api/remittances/pending' },
  'remittances.lines': { proposed: 'remittances:write', step: STEP },
  'remittances.lineById': { proposed: 'remittances:write', step: STEP },
  'remittances.confirm': { proposed: 'remittances:write', step: STEP },
  'remittances.void': { proposed: 'remittances:write', step: STEP },
  // Moves money in the books (E7) and needs the permission to move it: it waits for PR E6-2 and the plugin actor, with a scope of its own
  'remittances.writeOff': { proposed: 'remittances:write', step: STEP },
  // The GET is exposed; creating, changing and deleting a profile are writes
  'remittances.importProfiles': {
    proposed: ['remittances:read', 'remittances:write'],
    step: STEP,
    exposed: '/plugin-api/remittances/import-profiles'
  },
  'remittances.importProfileById': { proposed: 'remittances:write', step: STEP },

  // Media, exports, search, analytics
  'media.uploadUrl': { scope: 'media:write', exposed: '/plugin-api/media/upload-url' },
  'media.confirmUpload': { scope: 'media:write', exposed: '/plugin-api/media/confirm-upload' },
  'media.byId': { scope: 'media:read', exposed: '/plugin-api/media/:id' },
  'media.downloadAll': {
    scope: ['customers:read', 'media:read', 'conversations:read', 'exports:write'],
    exposed: '/plugin-api/media/download-all'
  },
  'exports.list': { scope: 'exports:read', exposed: '/plugin-api/exports' },
  'exports.byId': { scope: 'exports:read', exposed: '/plugin-api/exports/:id' },
  'exports.download': { scope: 'exports:read', exposed: '/plugin-api/exports/:id/download' },
  'search.global': { none: BELL_AND_SEARCH },
  'search.messages': {
    scope: ['conversations:read', 'messages:read'],
    exposed: '/plugin-api/search/messages'
  },
  'search.customers': { scope: 'customers:read', exposed: '/plugin-api/search/customers' },
  'search.orders': { scope: 'orders:read', exposed: '/plugin-api/search/orders' },
  'search.products': { scope: 'products:read', exposed: '/plugin-api/search/products' },
  'search.clicks': { none: SEARCH_CLICK },
  'analytics.metrics': { scope: 'analytics:read', exposed: '/plugin-api/analytics/metrics' },
  'analytics.myPerformance': { none: OWN_PERFORMANCE },
  'analytics.dashboard': { none: ANALYTICS_DASHBOARD },
  'analytics.reports': { none: ANALYTICS_REPORTS },
  'analytics.reportById': { none: ANALYTICS_REPORTS },
  'analytics.search': { none: SEARCH_REPORT },
  'analytics.export': {
    scope: ['analytics:read', 'exports:write'],
    exposed: '/plugin-api/analytics/export'
  },

  // Channels and settings
  'channels.connections': { none: CHANNEL_ADMIN },
  'channels.directory': { scope: 'channels:read', exposed: '/plugin-api/channels/directory' },
  'channels.connect': { none: CHANNEL_ADMIN },
  'channels.connectionById': { none: CHANNEL_ADMIN },
  'channels.test': { none: CHANNEL_ADMIN },
  'channels.disconnect': { none: CHANNEL_ADMIN },
  'channels.updateToken': { none: CHANNEL_ADMIN },
  'channels.label': { none: CHANNEL_ADMIN },
  'channels.templates': {
    scope: 'channels:read',
    exposed: '/plugin-api/channels/:pluginId/templates'
  },
  'channels.widgetEmbed': { none: CHANNEL_ADMIN },
  'channels.widgetOrigins': { none: CHANNEL_ADMIN },
  'channels.widgetPreChat': { none: CHANNEL_ADMIN },
  'channels.oauthStart': { none: CHANNEL_ADMIN },
  'channels.oauthAssets': { none: CHANNEL_ADMIN },
  'channels.oauthComplete': { none: CHANNEL_ADMIN },
  'channels.oauthSession': { none: CHANNEL_ADMIN },
  'settings.inbox': { none: SETTINGS_ADMIN },
  'settings.inboxBehavior': { none: SETTINGS_ADMIN },
  // Read only, as every other setting of how the store works: the owner changes them (the PUT and PATCH stay human)
  'settings.preferences': { scope: 'settings:read', exposed: '/plugin-api/settings/preferences' },
  'settings.returns': { scope: 'settings:read', exposed: '/plugin-api/settings/returns' },
  'settings.inventory': { proposed: ['inventory:read', 'settings:write'], step: STEP },
  'settings.routing': { none: SETTINGS_ADMIN },
  'settings.routingOrder': { none: SETTINGS_ADMIN },
  'settings.routingRuleById': { none: SETTINGS_ADMIN },
  'settings.businessHours': { none: SETTINGS_ADMIN },
  // The tag catalog of the store, over the same service as the screen (PR E4a-2)
  'settings.tags': {
    scope: ['tags:read', 'tags:write'],
    exposed: '/plugin-api/settings/tags'
  },
  'settings.tagById': {
    scope: ['tags:read', 'tags:write'],
    exposed: '/plugin-api/settings/tags/:id'
  },
  'settings.snippets': { none: SETTINGS_ADMIN },
  'settings.snippetById': { none: SETTINGS_ADMIN }
}
