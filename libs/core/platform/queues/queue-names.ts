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
  // The email of an invitation waits in the outbox of the invitation: this job asks the worker to deliver it now (the sweep does it if it is lost)
  DELIVER_INVITATION_EMAIL: 'deliver-invitation-email',

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
  // Clears what hangs from an erased customer: the text of its messages, its files, the names in its notifications (Step 7.2-C)
  ERASE_CUSTOMER_DATA: 'erase-customer-data',
  // The intake of a public data subject request (Step 7.2-H1a); the sweeps of the flow add their names with their steps (H1b, H2b)
  DSR_INTAKE: 'dsr-intake',
  RECONCILE_INVENTORY: 'reconcile-inventory',
  // The automatic entry of one event of one source (TDD_18 §6.1): the worker loads the current rows and posts it under its key
  POST_FINANCE_EVENT: 'post-finance-event',
  // The daily check of the books of one organization (TDD_18 §6.1, §11): the sweep of sources with no entry and the balances
  RECONCILE_FINANCE: 'reconcile-finance',
  // The weekly check of the hash chain of the journal of one organization (TDD_18 §11): read only, it opens or clears an incident
  VERIFY_LEDGER_CHAIN: 'verify-ledger-chain',
  // Builds, signs and submits the fiscal document of a sale through the provider of the issuer (TDD_18 §8.3)
  SUBMIT_FISCAL_DOCUMENT: 'submit-fiscal-document',
  // Reports a contingency of an issuer to the authority, so that the documents made in it can be sent (Step 4B.7c-7)
  REPORT_FISCAL_CONTINGENCY: 'report-fiscal-contingency',
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

// One scheduled report per report and day of its own zone: the dispatcher run twice in an hour asks for the same job (dashes, no colon)
export const scheduledReportJobId = (reportId: string, day: string): string =>
  `${JobNames.GENERATE_SCHEDULED_REPORT}-${reportId}-${day}`

export const reconcileInventoryJobId = (storeId: string, day: string): string =>
  `${JobNames.RECONCILE_INVENTORY}-${storeId}-${day}`

// One posting job per source and event for each UTC day when it is the sweep that asks (dashes, no colon): the sweep run twice, or
// retried, asks for the same job
export const postFinanceEventJobId = (kind: string, sourceId: string, day: string): string =>
  `${JobNames.POST_FINANCE_EVENT}-${kind}-${sourceId}-${day}`

// One check of the books per organization and UTC day: the schedule run twice (two replicas, a restart) asks for the same job
export const reconcileFinanceJobId = (organizationId: string, day: string): string =>
  `${JobNames.RECONCILE_FINANCE}-${organizationId}-${day}`

// One check of the chain per organization and UTC day (the schedule fires on one day a week): asked twice, it is one job
export const verifyLedgerChainJobId = (organizationId: string, day: string): string =>
  `${JobNames.VERIFY_LEDGER_CHAIN}-${organizationId}-${day}`

// One check of the chain asked by a person per organization at a time: asked again while it waits, it is the same job
export const requestedVerifyLedgerChainJobId = (organizationId: string): string =>
  `${JobNames.VERIFY_LEDGER_CHAIN}-${organizationId}-requested`

// One submission job per fiscal document and SUBMISSION (the counter of the document): the retries of a submission are one job, and a
// document that was refused, fixed and sent again is a new one (dashes, no colon)
export const submitFiscalDocumentJobId = (documentId: string, submission: number): string =>
  `${JobNames.SUBMIT_FISCAL_DOCUMENT}-${documentId}-${submission}`

// One report job per contingency: the retries of the report are one job; a person who asks again after a refusal needs a new one, so the
// number of the ask counts (dashes, no colon)
export const reportFiscalContingencyJobId = (contingencyId: string, ask: number): string =>
  `${JobNames.REPORT_FISCAL_CONTINGENCY}-${contingencyId}-${ask}`

// One retention run per store and local day: the hourly scheduler run twice in the same hour (or the store's hour of
// 03:00 seen twice around a change of the clock) asks for the same job (dashes, no colon)
export const enforceRetentionJobId = (storeId: string, localDay: string): string =>
  `${JobNames.ENFORCE_RETENTION}-${storeId}-${localDay}`

// One job per erased customer: asking for it again while it waits adds nothing (dashes, no colon)
export const eraseCustomerDataJobId = (customerId: string): string =>
  `${JobNames.ERASE_CUSTOMER_DATA}-${customerId}`

// The second run of that job, a little later (the same job id would be ignored while the first is kept)
export const eraseCustomerDataRecheckJobId = (customerId: string): string =>
  `${JobNames.ERASE_CUSTOMER_DATA}-recheck-${customerId}`

// One cold export per month of the run: the monthly scheduler run twice is one job (dashes, no colon)
export const exportAuditLogsJobId = (month: string): string =>
  `${JobNames.EXPORT_AUDIT_LOGS_TO_COLD_STORAGE}-${month}`

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
