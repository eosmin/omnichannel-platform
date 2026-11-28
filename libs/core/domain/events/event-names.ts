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
  // The mark that asks for attention in the list was put or taken off (it crosses the worker bridge: the
  // sweep that wakes a snoozed conversation puts it)
  CONVERSATION_ATTENTION_CHANGED: 'conversation.attention_changed',
  // An agent marked a conversation as unread again (api only: it never crosses the worker bridge)
  CONVERSATION_UNREAD: 'conversation.unread',
  CONVERSATION_DELETED: 'conversation.deleted',
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
  // A message that was due did not go and a person should know (ids and the reason only, never the text)
  ORDER_MESSAGE_NOT_SENT: 'order.message_not_sent',
  ORDER_PRICE_OVERRIDDEN: 'order.price_overridden',
  ORDER_PRICE_APPROVAL_REQUESTED: 'order.price_approval_requested',
  ORDER_PRICE_APPROVED: 'order.price_approved',
  ORDER_PRICE_REJECTED: 'order.price_rejected',
  // The packing note changed (ids only: the text of a note never travels in an event)
  ORDER_PACKING_NOTE_CHANGED: 'order.packing_note_changed',
  ORDER_PAYMENT_RECORDED: 'order.payment_recorded',

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
  // A count went to review: the people who may apply it are told (TDD_16 §4.6)
  COUNT_SUBMITTED: 'count.submitted',
  COUNT_APPLIED: 'count.applied',

  // Shipping, returns and remittances
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_STATUS_CHANGED: 'shipment.status_changed',
  SHIPMENT_CANCELLED: 'shipment.cancelled',
  SHIPMENT_REQUIRES_REVIEW: 'shipment.requires_review',
  // The carrier could not void a guide, or has no way to: the people who manage shipments are told to settle it (TDD_17 §4.8)
  SHIPMENT_CANCEL_FAILED: 'shipment.cancel_failed',
  // A carrier sent a status nobody has mapped, for the first time: the people who manage carriers are told (TDD_17 §4.17)
  CARRIER_STATUS_UNMAPPED: 'carrier.status_unmapped',
  // The balance of prepaid guides of a connection fell to its low-balance threshold or to zero, and the refund benefit got worse
  // (TDD_17 §4.18): both are raised inside the move that caused them, in the api or in the worker
  CARRIER_GUIDE_BALANCE_ALERT: 'carrier.guide_balance_alert',
  CARRIER_BENEFIT_ALERT: 'carrier.benefit_alert',
  // A bulk run of labels advanced, and ended: the person who asked hears it, and is told when the file is ready (TDD_17 §4.6)
  BULK_LABELS_PROGRESS: 'bulk_labels.progress',
  BULK_LABELS_DONE: 'bulk_labels.done',
  PICKUP_REQUESTED: 'pickup.requested',
  PICKUP_UPDATED: 'pickup.updated',
  // A pickup that a person has to arrange with the carrier: it has no API, or did not take the request (TDD_17 §4.10). The
  // people who manage pickups are told
  PICKUP_MANUAL_REQUIRED: 'pickup.manual_required',
  // The cutoff of a pickup day is near and guides still wait for a pickup (TDD_17 §4.10): raised once per connection and day
  PICKUP_CUTOFF_APPROACHING: 'pickup.cutoff_approaching',
  RETURN_REQUESTED: 'return.requested',
  RETURN_APPROVED: 'return.approved',
  // The goods are on their way back: the people who receive them are told (`return.awaiting_receipt`)
  RETURN_IN_TRANSIT: 'return.in_transit',
  RETURN_RECEIVED: 'return.received',
  // A person recorded the refund they paid out when completing a return (TDD_18 §4.2 E14): the books settle the customer's advance
  RETURN_REFUND_RECORDED: 'return.refund_recorded',
  REMITTANCE_CONFIRMED: 'remittance.confirmed',
  REMITTANCE_VOIDED: 'remittance.voided',
  // A person wrote off the difference of a guide that did not match its remittance (TDD_18 §4.2 E7): the books follow
  REMITTANCE_DIFFERENCE_WRITTEN_OFF: 'remittance.difference_written_off',
  // A person recorded a purchase of guides of a prepaid connection, or voided one (TDD_18 §4.2 E15, E16): the books follow. Api only
  CARRIER_GUIDES_PURCHASED: 'carrier.guides_purchased',
  CARRIER_GUIDES_PURCHASE_VOIDED: 'carrier.guides_purchase_voided',
  // A carrier has kept cash on delivery for longer than the store allows (the daily check, TDD_17 §4.15)
  REMITTANCE_OVERDUE: 'remittance.overdue',

  // Finance (TDD_18 §3): an entry was added to the journal, and one reversed it. Api only: they never cross the worker
  // bridge to a browser (the ledger is read by request). The rest of the finance events come with their steps.
  FINANCE_ENTRY_POSTED: 'finance.entry_posted',
  FINANCE_ENTRY_REVERSED: 'finance.entry_reversed',
  // An automatic entry could not be posted and a person must fix it (TDD_18 §6.1). Api and worker only, ids and a reason code.
  FINANCE_POSTING_FAILED: 'finance.posting_failed',
  // The weekly check of the hash chain found the journal altered, and no check has passed since (TDD_18 §11). Api and worker only: ids and
  // a reason code, never an entry.
  FINANCE_CHAIN_BROKEN: 'finance.chain_broken',
  // A fiscal document was accepted by the authority: its receiver is owed the files (the rule on delivering the files of a document). Worker and api: ids
  // only, never the receiver's data.
  FISCAL_DOCUMENT_ACCEPTED: 'fiscal.document_accepted',
  // A fiscal document was voided: its receiver is owed the event of the invalidation. Worker and api: ids only, never the receiver's data.
  FISCAL_DOCUMENT_VOIDED: 'fiscal.document_voided',
  // The files of an accepted document could not be given to its receiver and a person must (api only): ids and a reason code.
  FISCAL_DELIVERY_NOT_SENT: 'fiscal.delivery_not_sent',
  // A fiscal document was refused by the provider or the authority and a person must fix it (TDD_18 §8.3). Api and worker only:
  // ids and a reason code, never the receiver's data.
  FISCAL_DOCUMENT_REJECTED: 'fiscal.document_rejected',
  // A fiscal document ran out of attempts while it was still waiting for the provider: nobody is retrying it any more and a person must
  // (Step 4B.7b-2). Api and worker only: ids and the count, never the receiver's data.
  FISCAL_DOCUMENT_STUCK: 'fiscal.document_stuck',
  // The window to correct and send again a document the authority refused is closing or over (D14). Api and worker only: ids and whether it
  // is over, never the receiver's data.
  FISCAL_RETRANSMIT_DEADLINE: 'fiscal.retransmit_deadline',
  // The same for an invalidation the authority refused (D14b): its own event, so its notice is never taken for the one of the document
  FISCAL_VOID_RETRANSMIT_DEADLINE: 'fiscal.void_retransmit_deadline',
  // A guide was cancelled while the remission note that backs its goods is accepted: the note stays alive until a person voids it, and the
  // authority gives a few days to do it (D3b-3). Api only (the guide's event reaches the api, which tells the people who manage the documents):
  // the ids and the last instant to void it, never the receiver's data.
  FISCAL_REMISSION_VOID_DEADLINE: 'fiscal.remission_void_deadline',
  // The daily check found a sale document whose total or tax differs from the entry of the books for the same sale (TDD_18 §8.3, §11, Step
  // 4B.8b-2b). Api and worker only: the organization, one document id and the count, never an amount or the receiver's data.
  FISCAL_ENTRY_MISMATCH: 'fiscal.entry_mismatch',
  // A contingency of an issuer needs a person (Step 4B.7c-7): the lifecycle opened one by itself, the event that reports one was not
  // accepted, or the window to send its documents is closing. Api and worker only: the organization, the contingency and the kind.
  FISCAL_CONTINGENCY_ALERT: 'fiscal.contingency_alert',
  // A month was closed, and the latest closed one was reopened (TDD_18 §5, Step 4B.8). Api only; ids and the month, never an amount or the reason.
  FINANCE_PERIOD_CLOSED: 'finance.period_closed',
  FINANCE_PERIOD_REOPENED: 'finance.period_reopened',
  // Goods of a purchase order were received into a warehouse (TDD_18 §3, E10). Api only, like the finance ones.
  PURCHASE_ORDER_RECEIVED: 'purchase_order.received',

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
  // Who can be given a conversation changed (a member joined, left, was suspended, came back or changed role, or a
  // role changed its permissions): the inbox of every open session reads the directory again. Ids only.
  TEAM_DIRECTORY_CHANGED: 'team.directory_changed',

  // Channels and plugins
  CHANNEL_CONNECTED: 'channel.connected',
  CHANNEL_DISCONNECTED: 'channel.disconnected',
  CHANNEL_TOKEN_EXPIRING: 'channel.token_expiring',
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
  // The scan of a file of a message gave up for good: ids only
  MEDIA_UNSCANNABLE: 'media.unscannable',
  // A file the customer sent could not be kept (refused, unsafe or unreachable): ids only
  MEDIA_UNAVAILABLE: 'media.unavailable',

  // Exports and compliance
  EXPORT_REQUESTED: 'export.requested',
  EXPORT_READY: 'export.ready',
  EXPORT_FAILED: 'export.failed',
  DSR_CREATED: 'dsr.created',
  DSR_COMPLETED: 'dsr.completed',
  // The worker watches the data requests (Step 7.2-H2b-2): a request near its legal deadline, one given back to the review queue, and
  // one whose closing notice never reached the person. The api tells the reviewers
  DSR_DEADLINE_APPROACHING: 'dsr.deadline_approaching',
  DSR_RETURNED_TO_REVIEW: 'dsr.returned_to_review',
  // The api itself: a request whose person proved their mailbox waits for a reviewer (not bridged; it is born in the api)
  DSR_MANUAL_REVIEW: 'dsr.manual_review',
  DSR_NOTICE_FAILED: 'dsr.notice_failed'
} as const

// How long the first api instance to take an event of the bridge holds it
export const EVENTS_BRIDGE_CLAIM_SECONDS = 60

// The base name of the Redis channel that carries the domain events of the worker to the api
// instances, which are the only processes that hold sockets. Never subscribe to it bare: Redis
// pub/sub has no key prefix, so two stacks on one Redis would hear each other's events (each event
// then arrived once per stack). The real channel is `eventsBridgeChannel(prefix)`, with the same
// prefix as the queues.
export const EVENTS_BRIDGE_CHANNEL = 'platform:events-bridge'

export function eventsBridgeChannel(prefix: string): string {
  return `${prefix}:${EVENTS_BRIDGE_CHANNEL}`
}

export type EventName = (typeof Events)[keyof typeof Events]

// The events the worker passes to the api instances, which turn them into what the browsers hear.
// Only these leave the worker, and each with the fields of its schema in bridged-payloads.ts: the
// text of MESSAGE_RECEIVED and CONVERSATION_CREATED is left behind, nothing with text crosses.
export const BridgedEvents = [
  Events.CONVERSATION_CREATED,
  Events.MESSAGE_RECEIVED,
  Events.CONVERSATION_STATUS_CHANGED,
  Events.CONVERSATION_ASSIGNED,
  Events.CONVERSATION_SNOOZE_EXPIRED,
  Events.CONVERSATION_REOPENED,
  Events.CONVERSATION_UNASSIGNED,
  Events.CONVERSATION_READ,
  Events.CONVERSATION_ATTENTION_CHANGED,
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
  Events.MEDIA_UNSCANNABLE,
  Events.MEDIA_UNAVAILABLE,
  Events.EXPORT_READY,
  Events.EXPORT_FAILED,
  Events.CHANNEL_DISCONNECTED,
  Events.CHANNEL_TOKEN_EXPIRING,
  Events.CHANNEL_HEALTH_RESTORED,
  // The worker moves shipments (a carrier event, a poll): the order follows, and the team is told, in the api
  Events.SHIPMENT_STATUS_CHANGED,
  Events.SHIPMENT_REQUIRES_REVIEW,
  // The worker voids the guides: the team is told in the api when the carrier could not
  Events.SHIPMENT_CANCEL_FAILED,
  // The worker reads what the carriers push: the owner is told in the api
  Events.CARRIER_STATUS_UNMAPPED,
  // The worker moves shipments too: the team is told in the api
  Events.CARRIER_GUIDE_BALANCE_ALERT,
  Events.CARRIER_BENEFIT_ALERT,
  // The daily check of the cash owed runs in the worker and the team is told in the api
  Events.REMITTANCE_OVERDUE,
  // The worker runs the bulk generation of labels: the requester hears it in the api
  Events.BULK_LABELS_PROGRESS,
  Events.BULK_LABELS_DONE,
  // The worker asks the carriers for pickups: the team is told in the api when a pickup needs a person
  Events.PICKUP_MANUAL_REQUIRED,
  Events.PICKUP_CUTOFF_APPROACHING,
  // The worker creates customers (a first inbound message) and shipments (bulk labels): the webhooks of the stores are queued in the api
  Events.CUSTOMER_CREATED,
  Events.SHIPMENT_CREATED,
  Events.SHIPMENT_CANCELLED,
  // The worker delivers the webhooks and turns one off after too many failures: the admins are told in the api
  Events.WEBHOOK_AUTO_DISABLED,
  // The worker turns the webhooks of a plugin off after too many failures in a row: the admins are told in the api
  Events.PLUGIN_ERROR,
  // The worker says it once when an automatic entry of the books fails; the api tells whoever can fix it
  Events.FINANCE_POSTING_FAILED,
  // The worker says it once when the weekly check opens an incident of the chain; the api tells whoever closes the months
  Events.FINANCE_CHAIN_BROKEN,
  // The worker says it when a fiscal document was accepted; the api gives its files to the receiver
  Events.FISCAL_DOCUMENT_ACCEPTED,
  // The worker says it again when the daily check finds a voided document with no delivery of its invalidation; the api gives the files
  Events.FISCAL_DOCUMENT_VOIDED,
  // The worker says it when a fiscal document was refused or ran out of attempts; the api tells whoever can act on it
  Events.FISCAL_DOCUMENT_REJECTED,
  Events.FISCAL_DOCUMENT_STUCK,
  Events.FISCAL_RETRANSMIT_DEADLINE,
  Events.FISCAL_VOID_RETRANSMIT_DEADLINE,
  // The worker says it when the daily check finds a document that disagrees with its entry; the api tells whoever can act on it
  Events.FISCAL_ENTRY_MISMATCH,
  // The worker says it when a contingency needs a person; the api tells whoever can act on it
  Events.FISCAL_CONTINGENCY_ALERT,
  // The worker watches the data requests: the api tells whoever reviews them (ids and a reason code, never a person)
  Events.DSR_DEADLINE_APPROACHING,
  Events.DSR_RETURNED_TO_REVIEW,
  Events.DSR_NOTICE_FAILED
] as const satisfies readonly EventName[]

export type BridgedEvent = (typeof BridgedEvents)[number]
