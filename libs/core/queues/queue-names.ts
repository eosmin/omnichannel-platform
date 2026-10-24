// Seven queues plus the dead-letter queue.
export const QueueNames = {
  EMAIL: 'email',
  WEBHOOKS: 'webhooks',
  NOTIFICATIONS: 'notifications',
  ANALYTICS: 'analytics',
  EXPORTS: 'exports',
  HEAVY_PROCESSING: 'heavy-processing',
  INBOUND: 'inbound', // Channel webhook events, TDD_10 §4
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
  GENERATE_MEDIA_ZIP: 'generate-media-zip',
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

  // inbound
  PROCESS_CHANNEL_EVENT: 'process-channel-event',

  // dead letter
  EXHAUSTED: 'exhausted'
} as const

export type JobName = (typeof JobNames)[keyof typeof JobNames]
