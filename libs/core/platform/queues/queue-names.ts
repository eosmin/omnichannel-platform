// Nine queues plus the dead-letter queue.
export const QueueNames = {
  EMAIL: 'email',
  WEBHOOKS: 'webhooks',
  NOTIFICATIONS: 'notifications',
  ANALYTICS: 'analytics',
  EXPORTS: 'exports',
  HEAVY_PROCESSING: 'heavy-processing',
  INBOUND: 'inbound', // Channel webhook events, TDD_10 §4
  OUTBOUND: 'outbound', // The replies of the team on their way to a channel, TDD_10 §6.7.4
  // The name and photo of customers, read from the channel: a slow provider must not delay messages
  CUSTOMER_PROFILES: 'customer-profiles',
  DEAD_LETTER: 'dead-letter'
} as const

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames]

export const JobNames = {
  // email: one job, the template decides the content (TDD_07 §5)
  SEND_EMAIL: 'send-email',

  // webhooks
  TRIGGER_WEBHOOK: 'trigger-webhook',
  TRIGGER_PLUGIN_WEBHOOK: 'trigger-plugin-webhook',
  PROCESS_CARRIER_EVENT: 'process-carrier-event', // The inbound carrier webhook, validated then queued

  // notifications
  SEND_WEB_PUSH: 'send-web-push',
  QUEUE_EMAIL_DIGEST: 'queue-email-digest',
  SEND_EMAIL_DIGEST: 'send-email-digest',
  EVALUATE_PICKUPS: 'evaluate-pickups',
  SEND_ORDER_MESSAGE: 'send-order-message',
  CHECK_REMITTANCES: 'check-remittances',

  // analytics
  TRACK_EVENT: 'track-event',
  TRACK_SEARCH: 'track-search',
  ROLLUP_HOURLY: 'rollup-hourly',
  ROLLUP_DAILY: 'rollup-daily',

  // exports
  GENERATE_EXPORT: 'generate-export',
  GENERATE_SCHEDULED_REPORT: 'generate-scheduled-report',
  DSR_EXPORT_DATA: 'dsr-export-data',
  DSR_ERASE_DATA: 'dsr-erase-data',
  EXPORT_AUDIT_LOGS_TO_COLD_STORAGE: 'export-audit-logs-to-cold-storage',

  // heavy processing
  SCAN_FILE: 'scan-file',
  PROCESS_IMAGE: 'process-image', // Enqueued by SCAN_FILE only after a clean result
  FETCH_INBOUND_MEDIA: 'fetch-inbound-media',
  ENFORCE_RETENTION: 'enforce-retention',
  RECONCILE_INVENTORY: 'reconcile-inventory',
  CREATE_SHIPMENTS: 'create-shipments', // One batch
  BULK_LABELS_MERGE: 'bulk-labels-merge',
  CANCEL_SHIPMENT: 'cancel-shipment',
  POLL_SHIPMENT_STATUS: 'poll-shipment-status',
  REPROCESS_CARRIER_EVENTS: 'reprocess-carrier-events', // After the owner maps a carrier status code

  // inbound
  PROCESS_CHANNEL_EVENT: 'process-channel-event',
  // The name and photo of a customer, read from the channel after the message is stored
  FETCH_CUSTOMER_PROFILE: 'fetch-customer-profile',

  // outbound
  SEND_OUTBOUND_MESSAGE: 'send-outbound-message',
  SEND_OUTBOUND_REACTION: 'send-outbound-reaction',
  // An agent's edit or deletion of a message of ours, sent to the channel that supports it
  SEND_OUTBOUND_EDIT: 'send-outbound-edit',
  SEND_OUTBOUND_DELETE: 'send-outbound-delete',
  // The blue ticks: the customer's channel is told that an agent read up to a message
  SEND_OUTBOUND_READ_RECEIPT: 'send-outbound-read-receipt',
  // The agent started or stopped typing: the customer's channel shows it when it can
  SEND_OUTBOUND_TYPING: 'send-outbound-typing',

  // dead letter
  EXHAUSTED: 'exhausted'
} as const

export type JobName = (typeof JobNames)[keyof typeof JobNames]
