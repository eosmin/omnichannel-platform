// AuditAction values intentionally overlap with Events values where the same thing is both a
// domain event and an audited action; they are separate constants because not every event is
// audited and not every audited action is an event.
export const AuditAction = {
  // Auth
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  MAGIC_LINK_REQUESTED: 'user.magic_link_requested',
  MAGIC_LINK_CONSUMED: 'user.magic_link_consumed',
  SESSION_FAMILY_REVOKED: 'user.session_family_revoked',
  SESSION_REFRESH_GRACE: 'user.session_refresh_grace',
  ACCOUNT_PROFILE_UPDATED: 'user.profile_updated',
  ACCOUNT_PREFERENCES_UPDATED: 'user.preferences_updated',

  // Tenancy
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  STORE_CREATED: 'store.created',
  STORE_UPDATED: 'store.updated',
  STORE_DELETED: 'store.deleted',
  MEMBER_INVITED: 'member.invited',
  INVITATION_REVOKED: 'member.invitation_revoked',
  INVITATION_RESENT: 'member.invitation_resent',
  MEMBER_JOINED: 'member.joined',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_SUSPENDED: 'member.suspended',
  MEMBER_REACTIVATED: 'member.reactivated',
  ROLE_CHANGED: 'member.role_changed',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  PERMISSION_DENIED: 'permission.denied',
  TENANT_ACCESS_DENIED: 'tenant.access_denied',

  // Data access (sensitive reads)
  CUSTOMER_VIEWED: 'customer.viewed',
  CUSTOMER_EXPORTED: 'customer.exported',
  CONVERSATION_EXPORTED: 'conversation.exported',
  ORDER_EXPORTED: 'order.exported',
  ANALYTICS_EXPORTED: 'analytics.exported',
  MEDIA_BULK_DOWNLOADED: 'media.bulk_downloaded',
  MEDIA_INFECTED: 'media.infected',
  MEDIA_UNSCANNABLE: 'media.unscannable',
  AUDIT_LOG_VIEWED: 'audit_log.viewed',
  AUDIT_LOG_EXPORTED: 'audit_log.exported',

  // Data modification
  CUSTOMER_DELETED: 'customer.deleted',
  CUSTOMER_MERGED: 'customer.merged',
  CUSTOMER_UNMERGED: 'customer.unmerged',
  CUSTOMER_NOTE_DELETED: 'customer.note_deleted',
  CUSTOMER_CAUTION_SET: 'customer.caution_set',
  CUSTOMER_CAUTION_CLEARED: 'customer.caution_cleared',
  ORDER_CANCELLED: 'order.cancelled',
  PRODUCT_DELETED: 'product.deleted',
  PRODUCT_VARIANT_DELETED: 'product.variant_deleted',
  // The price a product or variant is sold at changed (old and new, in cents)
  PRODUCT_PRICE_CHANGED: 'product.price_changed',
  // The reference cost changed (old and new, in cents): it is the margin the finance module will read
  PRODUCT_COST_CHANGED: 'product.cost_changed',
  CONVERSATION_DELETED: 'conversation.deleted',
  BULK_ACTION_EXECUTED: 'conversation.bulk_action',
  // A person resolved a conversation, and took it back with the Undo of the toast: the thread keeps no
  // trace of an Undo inside its window, so this log is where both facts live, with who and when
  CONVERSATION_RESOLVED: 'conversation.resolved',
  CONVERSATION_RESOLVE_UNDONE: 'conversation.resolve_undone',

  // Orders (TDD_17 §3)
  ORDER_CONFIRMED: 'order.confirmed',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_DISCARDED: 'message.discarded',
  MESSAGE_DELETED_CONTENT_VIEWED: 'message.deleted_content_viewed',
  ORDER_MESSAGE_SENT: 'order.message_sent',
  ORDER_MESSAGE_NOT_SENT: 'order.message_not_sent',
  ORDER_TEMPLATE_UPDATED: 'order.template_updated',
  ORDER_TEMPLATE_DELETED: 'order.template_deleted',
  ORDER_PRICE_OVERRIDDEN: 'order.price_overridden',
  ORDER_DISCOUNT_APPLIED: 'order.discount_applied',
  ORDER_PRICE_APPROVAL_REQUESTED: 'order.price_approval_requested',
  ORDER_PRICE_APPROVED: 'order.price_approved',
  ORDER_PRICE_REJECTED: 'order.price_rejected',
  ORDER_CREATED: 'order.created',
  // Fields changed by an edit: the names, never the values of the notes (those have their own actions)
  ORDER_UPDATED: 'order.updated',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  // The scheduled delivery day moved (old and new day, decision D18)
  ORDER_SCHEDULE_CHANGED: 'order.schedule_changed',
  // The two internal notes: the old and the new text, because the audit log is where an edit of a note is found
  ORDER_INTERNAL_NOTE_CHANGED: 'order.internal_note_changed',
  ORDER_PACKING_NOTE_CHANGED: 'order.packing_note_changed',
  // A payment was recorded by hand, and its status moved (the v1.2 orders carry no online payment)
  ORDER_PAYMENT_RECORDED: 'order.payment_recorded',
  ORDER_PAYMENT_STATUS_CHANGED: 'order.payment_status_changed',

  // Inventory (TDD_16 §3)
  WAREHOUSE_CREATED: 'warehouse.created',
  WAREHOUSE_UPDATED: 'warehouse.updated',
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  // A draft transfer made or changed (the lines and the warehouses): what the TDD does not name but §8 asks for
  // ("every mutation is audited")
  TRANSFER_CREATED: 'transfer.created',
  TRANSFER_UPDATED: 'transfer.updated',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  TRANSFER_RECEIVED: 'transfer.received',
  TRANSFER_CLOSED_WITH_SHORTAGE: 'transfer.closed_with_shortage',
  TRANSFER_CANCELLED: 'transfer.cancelled',
  COUNT_CREATED: 'count.created',
  COUNT_STARTED: 'count.started',
  COUNT_LINES_UPDATED: 'count.lines_updated',
  COUNT_SUBMITTED: 'count.submitted',
  COUNT_REOPENED: 'count.reopened',
  COUNT_APPLIED: 'count.applied',
  COUNT_CANCELLED: 'count.cancelled',

  // Shipping, returns and remittances (TDD_17 §3)
  CARRIER_CONNECTED: 'carrier.connected',
  CARRIER_UPDATED: 'carrier.updated',
  CARRIER_DISCONNECTED: 'carrier.disconnected',
  CARRIER_STATUS_MAPPING_CHANGED: 'carrier.status_mapping_changed',
  CARRIER_WEBHOOK_SECRET_ROTATED: 'carrier.webhook_secret_rotated',
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_CANCELLED: 'shipment.cancelled',
  SHIPMENT_CANCEL_REQUESTED: 'shipment.cancel_requested',
  SHIPMENT_STATUS_SET_MANUALLY: 'shipment.status_set_manually',
  PICKUP_REQUESTED: 'pickup.requested',
  PICKUP_MODIFIED: 'pickup.modified',
  PICKUP_CANCELLED: 'pickup.cancelled',
  RETURN_CREATED: 'return.created',
  RETURN_APPROVED: 'return.approved',
  RETURN_REJECTED: 'return.rejected',
  RETURN_CANCELLED: 'return.cancelled',
  RETURN_IN_TRANSIT: 'return.in_transit',
  RETURN_RECEIVED: 'return.received',
  RETURN_REFUND_RECORDED: 'return.refund_recorded',
  RETURN_COMPLETED: 'return.completed',
  RETURN_RECEIVED_BY_SCAN: 'return.received_by_scan',
  RETURN_RECEPTION_BATCH_COMPLETED: 'return.reception_batch_completed',
  BULK_LABELS_REQUESTED: 'bulk_labels.requested',
  SHIPMENT_LABELS_MERGED: 'shipment.labels_merged',
  REMITTANCE_IMPORTED: 'remittance.imported',
  REMITTANCE_CONFIRMED: 'remittance.confirmed',
  REMITTANCE_VOIDED: 'remittance.voided',
  STORE_PREFERENCES_UPDATED: 'store_preferences.updated',

  // Security configuration
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_UPDATED: 'webhook.updated',
  WEBHOOK_DELETED: 'webhook.deleted',
  PLUGIN_INSTALLED: 'plugin.installed',
  PLUGIN_REVOKED: 'plugin.revoked',
  CHANNEL_CONNECTED: 'channel.connected',
  CHANNEL_DISCONNECTED: 'channel.disconnected',
  CHANNEL_TOKEN_UPDATED: 'channel.token_updated',
  CHANNEL_RENAMED: 'channel.renamed',
  WIDGET_ORIGINS_CHANGED: 'channel.widget_origins_changed',
  WIDGET_PRE_CHAT_CHANGED: 'channel.widget_pre_chat_changed',
  SETTINGS_CHANGED: 'settings.changed',
  ROUTING_RULE_CHANGED: 'routing_rule.changed',
  RETENTION_CHANGED: 'retention.changed',

  // Compliance
  DSR_CREATED: 'dsr.created',
  DSR_VERIFIED: 'dsr.verified',
  DSR_ERASURE_COMPLETED: 'dsr.erasure_completed',
  DSR_EXPORT_COMPLETED: 'dsr.export_completed',
  DSR_REJECTED: 'dsr.rejected',
  CONSENT_RECORDED: 'consent.recorded'
} as const

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction]
