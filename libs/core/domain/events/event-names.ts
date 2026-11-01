export const Events = {
  // Organizations and stores. ORGANIZATION_CREATED is declared but not emitted: the seed creates it.
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  STORE_CREATED: 'store.created',
  STORE_UPDATED: 'store.updated',
  STORE_SETTINGS_UPDATED: 'store.settings_updated',
  STORE_DELETED: 'store.deleted',

  // Conversations
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_UNASSIGNED: 'conversation.unassigned',
  CONVERSATION_STATUS_CHANGED: 'conversation.status_changed',
  CONVERSATION_RESOLVED: 'conversation.resolved',
  CONVERSATION_REOPENED: 'conversation.reopened',
  CONVERSATION_SNOOZED: 'conversation.snoozed',
  CONVERSATION_SNOOZE_EXPIRED: 'conversation.snooze_expired',
  CONVERSATION_ARCHIVED: 'conversation.archived',
  CONVERSATION_TAGGED: 'conversation.tagged',
  CONVERSATION_READ: 'conversation.read',
  // An agent marked a conversation as unread again (api only: it never crosses the worker bridge)
  CONVERSATION_UNREAD: 'conversation.unread',
  // The customer is typing (api only, and never written down: it is emitted on the bus directly, not
  // through DomainEvents, since there is no transaction to wait for)
  CUSTOMER_TYPING: 'customer.typing',

  // Messages
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',
  // A reply an agent wrote, stored and waiting for its channel (MESSAGE_SENT is for one the channel took)
  MESSAGE_QUEUED: 'message.queued',
  MESSAGE_NOTE_ADDED: 'message.note_added',
  // Someone reacted to a message, or took the reaction back (ids only, like MESSAGE_SENT)
  MESSAGE_REACTION: 'message.reaction',
  // A message changed its text or was deleted, by an agent or at the provider (ids only, like MESSAGE_SENT)
  MESSAGE_EDITED: 'message.edited',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_FAILED: 'message.failed',
  MESSAGE_MENTION: 'message.mention',

  // Customers
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  CUSTOMER_MERGED: 'customer.merged',
  CUSTOMER_UNMERGED: 'customer.unmerged',
  CUSTOMER_IDENTITY_LINKED: 'customer.identity_linked',
  CUSTOMER_ERASED: 'customer.erased',
  CUSTOMER_CAUTION_CHANGED: 'customer.caution_changed',

  // Orders
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_DELIVERED: 'order.delivered',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_PAYMENT_STATUS_CHANGED: 'order.payment_status_changed',
  ORDER_MESSAGE_SENT: 'order.message_sent',
  ORDER_MESSAGE_FAILED: 'order.message_failed',
  ORDER_PRICE_OVERRIDDEN: 'order.price_overridden',
  ORDER_PRICE_APPROVAL_REQUESTED: 'order.price_approval_requested',
  ORDER_PRICE_APPROVED: 'order.price_approved',
  ORDER_PRICE_REJECTED: 'order.price_rejected',

  // Products and inventory
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_DELETED: 'product.deleted',
  INVENTORY_MOVED: 'inventory.moved',
  INVENTORY_LOW: 'inventory.low',
  WAREHOUSE_CREATED: 'warehouse.created',
  WAREHOUSE_UPDATED: 'warehouse.updated',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  TRANSFER_RECEIVED: 'transfer.received',
  TRANSFER_CANCELLED: 'transfer.cancelled',
  COUNT_APPLIED: 'count.applied',

  // Shipping, returns and remittances
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_STATUS_CHANGED: 'shipment.status_changed',
  SHIPMENT_CANCELLED: 'shipment.cancelled',
  SHIPMENT_REQUIRES_REVIEW: 'shipment.requires_review',
  PICKUP_REQUESTED: 'pickup.requested',
  PICKUP_UPDATED: 'pickup.updated',
  RETURN_REQUESTED: 'return.requested',
  RETURN_APPROVED: 'return.approved',
  RETURN_RECEIVED: 'return.received',
  REMITTANCE_CONFIRMED: 'remittance.confirmed',
  REMITTANCE_VOIDED: 'remittance.voided',

  // Tags and snippets
  TAG_CREATED: 'tag.created',
  TAG_UPDATED: 'tag.updated',
  TAG_DELETED: 'tag.deleted',
  SNIPPET_CREATED: 'snippet.created',
  SNIPPET_UPDATED: 'snippet.updated',
  SNIPPET_DELETED: 'snippet.deleted',

  // Users and auth. USER_SIGNED_UP is emitted when accepting an invitation creates an account.
  USER_SIGNED_UP: 'user.signed_up',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_PREFERENCES_UPDATED: 'user.preferences_updated',

  // Team
  MEMBER_INVITED: 'member.invited',
  MEMBER_JOINED: 'member.joined',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  ROLE_UPDATED: 'role.updated',

  // Channels and plugins
  CHANNEL_CONNECTED: 'channel.connected',
  CHANNEL_DISCONNECTED: 'channel.disconnected',
  CHANNEL_HEALTH_RESTORED: 'channel.health_restored',
  PLUGIN_INSTALLED: 'plugin.installed',
  PLUGIN_ENABLED: 'plugin.enabled',
  PLUGIN_DISABLED: 'plugin.disabled',
  PLUGIN_REVOKED: 'plugin.revoked',
  PLUGIN_ERROR: 'plugin.error',

  // Webhooks (tenant-configured outbound webhooks)
  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_UPDATED: 'webhook.updated',
  WEBHOOK_DELETED: 'webhook.deleted',
  WEBHOOK_TRIGGERED: 'webhook.triggered',
  WEBHOOK_FAILED: 'webhook.failed',
  WEBHOOK_AUTO_DISABLED: 'webhook.auto_disabled',

  // API keys
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',

  // Media
  MEDIA_UPLOADED: 'media.uploaded',
  MEDIA_PROCESSED: 'media.processed',
  MEDIA_INFECTED: 'media.infected',

  // Exports and compliance
  EXPORT_REQUESTED: 'export.requested',
  EXPORT_READY: 'export.ready',
  DSR_CREATED: 'dsr.created',
  DSR_COMPLETED: 'dsr.completed'
} as const

// How long the first api instance to take an event of the bridge holds it
export const EVENTS_BRIDGE_CLAIM_SECONDS = 60

// The Redis channel that carries the domain events of the worker to the api instances, which are the
// only processes that hold sockets
export const EVENTS_BRIDGE_CHANNEL = 'platform:events-bridge'

export type EventName = (typeof Events)[keyof typeof Events]

// The events the worker passes to the api instances, which turn them into what the browsers hear.
// Only these leave the worker, and each with the fields of its schema in bridged-payloads.ts: the
// text of MESSAGE_RECEIVED and CONVERSATION_CREATED is left behind, nothing with text crosses.
export const BridgedEvents = [
  Events.CONVERSATION_CREATED,
  Events.MESSAGE_RECEIVED,
  Events.CONVERSATION_STATUS_CHANGED,
  Events.CONVERSATION_ASSIGNED,
  Events.CONVERSATION_READ,
  Events.MESSAGE_QUEUED,
  Events.MESSAGE_SENT,
  Events.MESSAGE_DELIVERED,
  Events.MESSAGE_READ,
  Events.MESSAGE_FAILED,
  Events.MESSAGE_NOTE_ADDED,
  Events.MESSAGE_REACTION,
  Events.MESSAGE_EDITED,
  Events.MESSAGE_DELETED,
  Events.MEDIA_PROCESSED,
  Events.MEDIA_INFECTED,
  Events.CHANNEL_DISCONNECTED,
  Events.CHANNEL_HEALTH_RESTORED
] as const satisfies readonly EventName[]

export type BridgedEvent = (typeof BridgedEvents)[number]
