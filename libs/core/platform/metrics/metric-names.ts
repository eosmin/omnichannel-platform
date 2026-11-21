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

  // Object storage (TDD_03 §7.3): 1 per protection (encryption at rest, versioning) the bucket does not show as on when the api
  // starts; a gauge, so an alert clears itself once the bucket is configured and the api restarts
  STORAGE_BUCKET_PROTECTION_GAP: 'platform_storage_bucket_protection_gap',

  // 1 while the role the worker connects with can skip row-level security (BYPASSRLS), 0 when it cannot (TDD_01 §3.2)
  WORKER_ROLE_BYPASSES_RLS: 'platform_worker_role_bypasses_rls',

  // Inventory (TDD_16 §3)
  INVENTORY_RECONCILIATION_MISMATCHES: 'platform_inventory_reconciliation_mismatches_total',

  // Finance (TDD_18 §3): the sources the sweep found with no entry (a gauge per run), the failures of the books that a person must
  // fix, and the balances that disagree with their lines (any non-zero value is an incident: nothing fixes itself)
  FINANCE_UNPOSTED_SOURCES: 'platform_finance_unposted_sources',
  FINANCE_POSTING_FAILURES: 'platform_finance_posting_failures_total',
  FINANCE_BALANCE_MISMATCHES: 'platform_finance_balance_mismatches',
  // What the daily check of the fiscal documents found, by kind: a gauge of how many there are now, so it goes back to zero when they are fixed
  FINANCE_FISCAL_FINDINGS: 'platform_finance_fiscal_findings',
  // 1 while the last weekly check of the hash chain found the journal altered, 0 once a check passes again (a gauge, like the one above,
  // so an alert clears itself when the books are sound again)
  FINANCE_CHAIN_BREAKS: 'platform_finance_chain_breaks',

  // Shipping (TDD_17 §3); labels of the carrier errors: carrier, code
  SHIPMENTS_CREATED_TOTAL: 'platform_shipments_created_total',
  SHIPMENT_CARRIER_ERRORS_TOTAL: 'platform_shipment_carrier_errors_total',
  SHIPMENT_UNKNOWN_STATUS_TOTAL: 'platform_shipment_unknown_status_total',
  CARRIER_WEBHOOK_RECEIVED: 'platform_carrier_webhook_received_total',
  CARRIER_WEBHOOK_REJECTED: 'platform_carrier_webhook_rejected_total',
  PICKUPS_REQUESTED_TOTAL: 'platform_pickups_requested_total',

  // Security
  AUTH_FAILURES: 'platform_auth_failures_total',
  PERMISSION_DENIALS: 'platform_permission_denials_total',
  TENANT_VIOLATIONS: 'platform_tenant_violations_total', // Any non-zero value is an incident
  RATE_LIMIT_HITS: 'platform_rate_limit_hits_total',
  // How much of its budget a person had spent in the window when a request was counted (spent / limit, by throttler): the fitting of
  // the quota reads it (TDD_05 §3.1). Never labelled with the person
  RATE_LIMIT_BUDGET_USAGE: 'platform_rate_limit_budget_usage_ratio',
  AUDIT_WRITE_FAILURES: 'platform_audit_write_failures_total', // Any non-zero value: an action left no trace

  // Queues
  QUEUE_DEPTH: 'platform_queue_depth',
  QUEUE_PROCESSED: 'platform_queue_processed_total',
  QUEUE_FAILED: 'platform_queue_failed_total',
  QUEUE_PROCESSING_DURATION: 'platform_queue_processing_duration_seconds',

  // Webhooks: the deliveries of an event that were never queued (label `reason`, WebhookDispatchLossReasons). Any non-zero rate is a
  // delivery lost with no other trace than the log: alert on it
  WEBHOOK_DISPATCH_LOST: 'platform_webhook_dispatch_lost_total',

  // Channels
  CHANNEL_WEBHOOK_RECEIVED: 'platform_channel_webhook_received_total',
  CHANNEL_WEBHOOK_REJECTED: 'platform_channel_webhook_rejected_total',
  CHANNEL_API_ERRORS: 'platform_channel_api_errors_total',
  CHANNEL_CONNECTIONS_ACTIVE: 'platform_channel_connections_active',
  // An event a remote channel plugin reported and the platform dropped (TDD_10 §6.7.5), by reason
  PLUGIN_EVENT_REJECTED: 'platform_plugin_event_rejected_total',

  // A job whose row (an export, a report) is not there for its own store when the job runs: the row was deleted, or a context that
  // hides it from its own store hid it (RLS phase 5). By `job`
  WORKER_JOB_SUBJECT_MISSING: 'worker_job_subject_missing_total',

  // Outbound webhooks and email
  WEBHOOK_DELIVERIES: 'platform_webhook_deliveries_total',
  // A delivery whose log row the policy refused because its webhook (or plugin installation) was deleted meanwhile. By `target`
  WEBHOOK_GONE_BEHIND_POLICY: 'platform_webhook_gone_behind_policy_total',
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

// The `target` label of MetricNames.WEBHOOK_DELIVERIES: whose webhook was delivered, so the counter
// does not add a store's own webhooks and the webhooks of a plugin into one number.
export const WebhookMetricTarget = {
  TENANT: 'tenant',
  PLUGIN: 'plugin'
} as const
export type WebhookMetricTargetType = (typeof WebhookMetricTarget)[keyof typeof WebhookMetricTarget]
