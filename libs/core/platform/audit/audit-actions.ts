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

  // Tenancy
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  STORE_CREATED: 'store.created',
  STORE_UPDATED: 'store.updated',
  STORE_DELETED: 'store.deleted',
  MEMBER_INVITED: 'member.invited',
  INVITATION_REVOKED: 'member.invitation_revoked',
  MEMBER_JOINED: 'member.joined',
  MEMBER_REMOVED: 'member.removed',
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
  AUDIT_LOG_VIEWED: 'audit_log.viewed',
  AUDIT_LOG_EXPORTED: 'audit_log.exported',

  // Data modification
  CUSTOMER_DELETED: 'customer.deleted',
  CUSTOMER_MERGED: 'customer.merged',
  CUSTOMER_UNMERGED: 'customer.unmerged',
  CUSTOMER_CAUTION_SET: 'customer.caution_set',
  CUSTOMER_CAUTION_CLEARED: 'customer.caution_cleared',
  ORDER_CANCELLED: 'order.cancelled',
  CONVERSATION_DELETED: 'conversation.deleted',
  BULK_ACTION_EXECUTED: 'conversation.bulk_action',

  // Orders (TDD_17 §3)
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_MESSAGE_SENT: 'order.message_sent',
  ORDER_TEMPLATE_UPDATED: 'order.template_updated',
  ORDER_PRICE_OVERRIDDEN: 'order.price_overridden',
  ORDER_DISCOUNT_APPLIED: 'order.discount_applied',
  ORDER_PRICE_APPROVAL_REQUESTED: 'order.price_approval_requested',
  ORDER_PRICE_APPROVED: 'order.price_approved',
  ORDER_PRICE_REJECTED: 'order.price_rejected',

  // Inventory (TDD_16 §3)
  WAREHOUSE_CREATED: 'warehouse.created',
  WAREHOUSE_UPDATED: 'warehouse.updated',
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  TRANSFER_RECEIVED: 'transfer.received',
  TRANSFER_CLOSED_WITH_SHORTAGE: 'transfer.closed_with_shortage',
  TRANSFER_CANCELLED: 'transfer.cancelled',
  COUNT_APPLIED: 'count.applied',

  // Shipping, returns and remittances (TDD_17 §3)
  CARRIER_CONNECTED: 'carrier.connected',
  CARRIER_UPDATED: 'carrier.updated',
  CARRIER_DISCONNECTED: 'carrier.disconnected',
  CARRIER_STATUS_MAPPING_CHANGED: 'carrier.status_mapping_changed',
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_CANCELLED: 'shipment.cancelled',
  SHIPMENT_STATUS_SET_MANUALLY: 'shipment.status_set_manually',
  PICKUP_REQUESTED: 'pickup.requested',
  PICKUP_MODIFIED: 'pickup.modified',
  PICKUP_CANCELLED: 'pickup.cancelled',
  RETURN_CREATED: 'return.created',
  RETURN_APPROVED: 'return.approved',
  RETURN_RECEIVED: 'return.received',
  RETURN_COMPLETED: 'return.completed',
  RETURN_RECEIVED_BY_SCAN: 'return.received_by_scan',
  BULK_LABELS_REQUESTED: 'bulk_labels.requested',
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
