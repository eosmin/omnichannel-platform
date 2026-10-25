export const MetricNames = {
  // HTTP (auto-collected)
  HTTP_REQUESTS_TOTAL: 'http_requests_total',
  HTTP_REQUEST_DURATION: 'http_request_duration_seconds',

  // Business
  CONVERSATIONS_CREATED: 'platform_conversations_created_total',
  CONVERSATIONS_RESOLVED: 'platform_conversations_resolved_total',
  MESSAGES_RECEIVED: 'platform_messages_received_total',
  MESSAGES_SENT: 'platform_messages_sent_total',
  MESSAGE_SEND_DURATION: 'platform_message_send_duration_seconds',
  ORDERS_CREATED: 'platform_orders_created_total',
  ORDER_VALUE: 'platform_order_value_usd',
  ORDER_MESSAGES_FAILED_TOTAL: 'platform_order_messages_failed_total',

  // Inventory (TDD_16 §3)
  INVENTORY_RECONCILIATION_MISMATCHES: 'platform_inventory_reconciliation_mismatches_total',

  // Shipping (TDD_17 §3); labels of the carrier errors: carrier, code
  SHIPMENTS_CREATED_TOTAL: 'platform_shipments_created_total',
  SHIPMENT_CARRIER_ERRORS_TOTAL: 'platform_shipment_carrier_errors_total',
  SHIPMENT_UNKNOWN_STATUS_TOTAL: 'platform_shipment_unknown_status_total',
  PICKUPS_REQUESTED_TOTAL: 'platform_pickups_requested_total',

  // Security
  AUTH_FAILURES: 'platform_auth_failures_total',
  PERMISSION_DENIALS: 'platform_permission_denials_total',
  TENANT_VIOLATIONS: 'platform_tenant_violations_total', // Any non-zero value is an incident
  RATE_LIMIT_HITS: 'platform_rate_limit_hits_total',
  AUDIT_WRITE_FAILURES: 'platform_audit_write_failures_total', // Any non-zero value: an action left no trace

  // Queues
  QUEUE_DEPTH: 'platform_queue_depth',
  QUEUE_PROCESSED: 'platform_queue_processed_total',
  QUEUE_FAILED: 'platform_queue_failed_total',
  QUEUE_PROCESSING_DURATION: 'platform_queue_processing_duration_seconds',

  // Channels
  CHANNEL_WEBHOOK_RECEIVED: 'platform_channel_webhook_received_total',
  CHANNEL_WEBHOOK_REJECTED: 'platform_channel_webhook_rejected_total',
  CHANNEL_API_ERRORS: 'platform_channel_api_errors_total',
  CHANNEL_CONNECTIONS_ACTIVE: 'platform_channel_connections_active',

  // Outbound webhooks and email
  WEBHOOK_DELIVERIES: 'platform_webhook_deliveries_total',
  EMAILS_SENT: 'platform_emails_sent_total',

  // Realtime
  WEBSOCKET_CONNECTIONS: 'platform_websocket_connections',
  WEBSOCKET_EVENTS_EMITTED: 'platform_websocket_events_emitted_total',

  // Cache
  CACHE_HITS: 'platform_cache_hits_total',
  CACHE_MISSES: 'platform_cache_misses_total',

  // Database
  DB_QUERY_DURATION: 'platform_db_query_duration_seconds'
} as const

export type MetricName = (typeof MetricNames)[keyof typeof MetricNames]

// The `status` label of MetricNames.EMAILS_SENT: what happened to an email, from the worker that
// sent it and from the Resend webhook that reports on it afterwards.
export const EmailMetricStatus = {
  SENT: 'sent',
  FAILED: 'failed',
  BOUNCED: 'bounced',
  COMPLAINED: 'complained'
} as const
export type EmailMetricStatusType = (typeof EmailMetricStatus)[keyof typeof EmailMetricStatus]
