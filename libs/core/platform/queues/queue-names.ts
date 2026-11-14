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
  // A login link was asked for: the worker looks the address up, so the request never does
  REQUEST_MAGIC_LINK: 'request-magic-link',

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
  FETCH_ORIGIN_MEDIA: 'fetch-origin-media', // The picture or the thumbnail of an ad: one job each
  ENFORCE_RETENTION: 'enforce-retention',
  RECONCILE_INVENTORY: 'reconcile-inventory',
  CREATE_SHIPMENTS: 'create-shipments', // One batch
  BULK_LABELS_MERGE: 'bulk-labels-merge',
  CANCEL_SHIPMENT: 'cancel-shipment',
  SYNC_PICKUP: 'sync-pickup', // Asks the carrier for a pickup, or tells it the new count
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
  // Only the text under a file, sent again as a message of its own when the first try failed
  SEND_OUTBOUND_CAPTION: 'send-outbound-caption',
  // The blue ticks: the customer's channel is told that an agent read up to a message
  SEND_OUTBOUND_READ_RECEIPT: 'send-outbound-read-receipt',
  // The agent started or stopped typing: the customer's channel shows it when it can
  SEND_OUTBOUND_TYPING: 'send-outbound-typing',

  // dead letter
  EXHAUSTED: 'exhausted'
} as const

// One job per picture of an ad: asked twice (a retry of the event) it is one job
export const originMediaJobId = (originId: string, slot: string): string =>
  `${JobNames.FETCH_ORIGIN_MEDIA}-${originId}-${slot}`

// One reconciliation per store and UTC day (TDD_16 §4.8): the scheduler run twice in a day asks for the same job. Dashes,
// because BullMQ refuses a custom id with a colon.
// One check of the cash owed per store and day: the scheduler run twice in a day asks for the same job (dashes, no colon)
export const checkRemittancesJobId = (storeId: string, day: string): string =>
  `${JobNames.CHECK_REMITTANCES}-${storeId}-${day}`

// One rollup job per store, period and run: the run is the start of the hour or day that queued it, so the same run asked twice by
// two replicas is one job while the run after recomputes the period again (a late webhook). Dashes, no colon.
export const rollupJobId = (
  jobName: typeof JobNames.ROLLUP_HOURLY | typeof JobNames.ROLLUP_DAILY,
  storeId: string,
  periodStart: Date,
  runStart: Date
): string => `${jobName}-${storeId}-${periodStart.getTime()}-${runStart.getTime()}`

// The advisory lock of one rollup (a store and a period): two runs of the same one never write at the same time
export const rollupLockKey = (
  jobName: typeof JobNames.ROLLUP_HOURLY | typeof JobNames.ROLLUP_DAILY,
  storeId: string,
  periodStart: Date
): string => `${jobName}-${storeId}-${periodStart.getTime()}`

export const reconcileInventoryJobId = (storeId: string, day: string): string =>
  `${JobNames.RECONCILE_INVENTORY}-${storeId}-${day}`

// One poll per connection and interval bucket: the scheduler run twice in a bucket asks for the same job (dashes, no colon)
export const pollShipmentStatusJobId = (connectionId: string, bucket: number): string =>
  `${JobNames.POLL_SHIPMENT_STATUS}-${connectionId}-${bucket}`

// One job per bulk run: the request asked twice is one job (dashes, no colon)
export const bulkLabelsMergeJobId = (jobId: string): string =>
  `${JobNames.BULK_LABELS_MERGE}-${jobId}`

// One void per guide and request: the request asked twice is one job, and a retry of a failed void (a later request) is another
// (dashes, no colon)
// One sync per pickup and revision of its count: two requests of one moment are one job, a later change of the count is another
// (dashes, no colon)
export const syncPickupJobId = (pickupId: string, revision: number): string =>
  `${JobNames.SYNC_PICKUP}-${pickupId}-${revision}`

// One evaluation of the pickups per minute (TDD_17 §4.10): the scheduler of any replica, or two ticks of one minute, ask for the same job
export const evaluatePickupsJobId = (minute: number): string =>
  `${JobNames.EVALUATE_PICKUPS}-${minute}`

// The sweep asks the carrier about a pickup again at most once in a bucket of time, apart from the request side's own job
export const syncPickupSweepJobId = (pickupId: string, bucket: number): string =>
  `${JobNames.SYNC_PICKUP}-${pickupId}-sweep-${bucket}`

export const cancelShipmentJobId = (shipmentId: string, requestedAtMs: number): string =>
  `${JobNames.CANCEL_SHIPMENT}-${shipmentId}-${requestedAtMs}`

export type JobName = (typeof JobNames)[keyof typeof JobNames]
