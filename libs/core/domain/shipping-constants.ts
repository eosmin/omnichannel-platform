import {
  CodStatus,
  OrderReturnStatus,
  PickupStatus,
  PriceApprovalStatus,
  RemittanceStatus,
  ShipmentStatus
} from './status-enums'

export const CarrierId = { FORZA: 'forza', C807: 'c807', LOCAL: 'local' } as const
export type CarrierIdType = (typeof CarrierId)[keyof typeof CarrierId]

export const LabelFormat = {
  PDF_100X150: 'pdf_100x150',
  PDF_A6: 'pdf_a6',
  PDF_A4: 'pdf_a4'
} as const
export type LabelFormatType = (typeof LabelFormat)[keyof typeof LabelFormat]

// The page of each label format, in millimetres (TDD_17 §4.6): 100x150 is the usual 4x6 inch thermal roll. A new
// format is a line here, not code.
export const LabelPageSizesMm: Record<LabelFormatType, { widthMm: number; heightMm: number }> = {
  [LabelFormat.PDF_100X150]: { widthMm: 100, heightMm: 150 },
  [LabelFormat.PDF_A6]: { widthMm: 105, heightMm: 148 },
  [LabelFormat.PDF_A4]: { widthMm: 210, heightMm: 297 }
}

// The guide of the `local` carrier is `{prefix}-{sequence}`, for example JM-000123 (TDD_17 §4.2). The prefix is
// short and printable in Code 128 and in the guide column of a spreadsheet; the sequence is padded so the guides
// of a connection sort.
export const LocalGuide = {
  SEPARATOR: '-',
  SEQUENCE_DIGITS: 6,
  PREFIX_PATTERN: /^[A-Z0-9]{1,6}$/
} as const

export function formatLocalGuideNumber(prefix: string, sequence: number): string {
  // A guide that is not printable in Code 128 or does not sort is never made: the caller's bug, loudly
  if (!LocalGuide.PREFIX_PATTERN.test(prefix)) throw new RangeError('Invalid guide prefix')
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new RangeError('Invalid guide sequence')
  return `${prefix}${LocalGuide.SEPARATOR}${String(sequence).padStart(LocalGuide.SEQUENCE_DIGITS, '0')}`
}

// The carriers are one plugin of the catalog, `shipping` (D19): a store installs it once and then connects as many
// carriers as it needs, each a CarrierConnection. The row of the catalog is written from the carrier registry at boot.
export const ShippingPlugin = {
  ID: 'shipping',
  NAME: 'Shipping'
} as const

// The bounds of what a store configures for a carrier connection (TDD_17 §2, §4.13). The prefix of a guide is the one
// `LocalGuide` and the database allow; a fee is a money amount in the cents of the store currency.
export const CarrierConnectionLimits = {
  DISPLAY_NAME_MAX_LENGTH: 80,
  MAX_PER_STORE: 50,
  MAX_FEE_CENTS: 100_000_000,
  MAX_SERVICES: 50,
  SERVICE_LABEL_MAX_LENGTH: 80,
  SERVICE_CODE_MAX_LENGTH: 40,
  MAX_REMINDER_MINUTES: 24 * 60,
  MAX_POLL_MINUTES: 24 * 60,
  MAX_DELIVERY_ATTEMPTS: 10,
  CONTACT_PHONE_MAX_LENGTH: 30,
  CONTACT_NOTES_MAX_LENGTH: 500,
  // What the connect and test calls to the carrier may take before the answer is given up (the outcome of a test is
  // not an unknown one: nothing was created)
  PROVIDER_TIMEOUT_MS: 15_000
} as const

// One writer at a time per store for what reads and writes the connections as a whole (the count of a store, its default)
export const CarrierLockScopes = { CONNECTIONS: 'carrier_connections' } as const

// Why a connection is not healthy, as a name of a closed list (never the carrier's words, which could carry a secret or
// a customer's data): what `CarrierConnection.lastError` holds and what the screen translates
export const CarrierHealthReasons = {
  AUTH: 'auth', // the carrier rejected the credentials
  REJECTED: 'rejected', // the carrier refused the request
  UNAVAILABLE: 'unavailable', // the carrier could not be reached, or did not answer in time
  INVALID_ANSWER: 'invalid_answer', // the plugin answered with something the platform cannot use
  CREDENTIALS_UNREADABLE: 'credentials_unreadable' // the stored credentials do not open (the key was rotated or the row is damaged)
} as const
export type CarrierHealthReason = (typeof CarrierHealthReasons)[keyof typeof CarrierHealthReasons]

// The size of a webhook secret the platform makes for a connection (bytes of randomness, shown once as base64url)
export const CARRIER_WEBHOOK_SECRET_BYTES = 32

// What the public carrier webhook accepts and keeps (TDD_17 §4.9, §4.12). The body is the carrier's, signed by it, but the
// route is open to the internet, so every size is bounded before anything is parsed or stored.
export const CarrierWebhookLimits = {
  // The raw body: a status push is a few hundred bytes, a batch of events a few kilobytes (the parser stops at 100 KB)
  MAX_BODY_BYTES: 65_536,
  // How many jobs go to the queue in one call (every event of a body is queued: the size of the body bounds them)
  BULK_CHUNK: 100
} as const

// The status-mapping tables of a connection (TDD_17 §4.17), bounded so a faulty or hostile sender cannot grow them
export const CarrierStatusLimits = {
  // A normalized code, composite `status:reason` included
  PROVIDER_CODE_MAX_LENGTH: 96,
  // The sample of what the carrier said, kept for the screen
  SAMPLE_MAX_LENGTH: 200,
  // The codes waiting for the owner, per connection: past it a new code is counted in the metric and the log only
  MAX_UNMAPPED_PER_CONNECTION: 200,
  // The rows of mappings one connection may hold (the catalog plus what the owner adds)
  MAX_MAPPINGS_PER_CONNECTION: 500
} as const

// Each value is an i18n key.
export const OrderReturnReasons = {
  DEFECTIVE: 'orders.return.reason.DEFECTIVE',
  WRONG_ITEM: 'orders.return.reason.WRONG_ITEM',
  NOT_AS_DESCRIBED: 'orders.return.reason.NOT_AS_DESCRIBED',
  DAMAGED_IN_TRANSIT: 'orders.return.reason.DAMAGED_IN_TRANSIT',
  DELIVERY_FAILED: 'orders.return.reason.DELIVERY_FAILED',
  REFUSED_BY_CUSTOMER: 'orders.return.reason.REFUSED_BY_CUSTOMER',
  CHANGED_MIND: 'orders.return.reason.CHANGED_MIND',
  OTHER: 'orders.return.reason.OTHER'
} as const

export const CarrierCapability = {
  CREATE_SHIPMENT: 'create_shipment', // a guide can be created on its own (standalone carriers)
  // Guides exist only inside a pickup request: one call creates the pickup and returns the guides
  // of every shipment in it (TDD_17 §4.5). Replaces CREATE_SHIPMENT.
  PICKUP_BOUND_GUIDES: 'pickup_bound_guides',
  CANCEL_SHIPMENT: 'cancel_shipment',
  RETURN_SHIPMENT: 'return_shipment', // can create a guide from the customer to the warehouse
  IDEMPOTENT_CREATE: 'idempotent_create', // accepts our reference as a unique key: a retry never makes a second guide
  FETCH_STATUS: 'fetch_status', // polling
  WEBHOOK_STATUS: 'webhook_status', // pushes status changes
  PICKUP_REQUEST: 'pickup_request',
  PICKUP_MODIFY: 'pickup_modify', // the package count of an existing pickup can change
  PICKUP_CANCEL: 'pickup_cancel',
  REQUIRES_LOCATION_IDS: 'requires_location_ids', // the API needs the carrier's own department, municipality and settlement ids
  INTERNAL_GUIDE: 'internal_guide', // 'local' only: the platform generates the guide and label
  COD: 'cod' // supports cash on delivery
} as const
export type CarrierCapabilityType = (typeof CarrierCapability)[keyof typeof CarrierCapability]

// The statuses a carrier can report, and so the only valid targets of a status mapping. The other
// shipment statuses are driven by our own actions (TDD_17 §4.17).
export const CarrierReportableStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.LABEL_CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED
]

// One code for "Entregado", "ENTREGADO " and "entregádo": trimmed, lowercased, accents removed and
// inner whitespace collapsed. The single definition used to store and to look up a mapping.
export function normalizeProviderStatusCode(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // Combining marks only: `\p{Diacritic}` also matches ^ ` and ¨, which are codes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// A code that can be stored and mapped: not empty, not longer than a column may hold, and no control character (a NUL is
// refused by the database, and a code nobody can type into a mapping can never be mapped)
export function isStorableProviderCode(code: string): boolean {
  return (
    code.length > 0 &&
    code.length <= CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH &&
    // eslint-disable-next-line no-control-regex -- a control character is what is refused
    !/[\u0000-\u001f\u007f]/.test(code)
  )
}

// The code a carrier event is looked up under (TDD_17 §4.17): the normalized status, and when the carrier sends a reason
// beside it (C807: `16` and `115`) the composite `status:reason`. The reason is part of the code only when it is not empty.
export function providerStatusCodeOf(rawStatus: string, rawReason?: string): string {
  const status = normalizeProviderStatusCode(rawStatus)
  const reason = rawReason === undefined ? '' : normalizeProviderStatusCode(rawReason)
  return reason === '' ? status : `${status}:${reason}`
}

// Transition tables, enforced inside the owning service (TDD_17 §3).

// Forward-only, with forward jumps allowed (TDD_17 §4.9). The last transition of CANCEL_FAILED is made by the agent
// ("mark as voided").
export const ShipmentStatusTransitions: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  [ShipmentStatus.CREATING]: [
    ShipmentStatus.LABEL_CREATED,
    ShipmentStatus.REQUIRES_REVIEW,
    ShipmentStatus.FAILED
  ],
  [ShipmentStatus.REQUIRES_REVIEW]: [ShipmentStatus.LABEL_CREATED, ShipmentStatus.FAILED],
  // A carrier may skip the intermediate events, so every later in-flight status is reachable
  [ShipmentStatus.LABEL_CREATED]: [
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.CANCEL_PENDING
  ],
  [ShipmentStatus.PICKED_UP]: [
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  [ShipmentStatus.IN_TRANSIT]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  [ShipmentStatus.OUT_FOR_DELIVERY]: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  // A repeated attempt is a transition to itself: carriers usually try up to three times
  [ShipmentStatus.FAILED_ATTEMPT]: [
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  [ShipmentStatus.RETURNING]: [ShipmentStatus.RETURNED],
  [ShipmentStatus.CANCEL_PENDING]: [ShipmentStatus.CANCELLED, ShipmentStatus.CANCEL_FAILED],
  [ShipmentStatus.CANCEL_FAILED]: [ShipmentStatus.CANCEL_PENDING, ShipmentStatus.CANCELLED],
  [ShipmentStatus.DELIVERED]: [],
  [ShipmentStatus.RETURNED]: [],
  [ShipmentStatus.CANCELLED]: [],
  [ShipmentStatus.FAILED]: []
}

export const OrderReturnStatusTransitions: Record<OrderReturnStatus, readonly OrderReturnStatus[]> =
  {
    [OrderReturnStatus.REQUESTED]: [
      OrderReturnStatus.APPROVED,
      OrderReturnStatus.REJECTED,
      OrderReturnStatus.CANCELLED
    ],
    [OrderReturnStatus.APPROVED]: [
      OrderReturnStatus.IN_TRANSIT,
      OrderReturnStatus.RECEIVED,
      OrderReturnStatus.CANCELLED
    ],
    [OrderReturnStatus.IN_TRANSIT]: [OrderReturnStatus.RECEIVED],
    [OrderReturnStatus.RECEIVED]: [OrderReturnStatus.COMPLETED],
    [OrderReturnStatus.REJECTED]: [],
    [OrderReturnStatus.CANCELLED]: [],
    [OrderReturnStatus.COMPLETED]: []
  }

// PENDING appears when a discount is above the store's limit or a shipping fee is outside the
// carrier's range; PENDING returns to NOT_REQUIRED when the order is brought back within both.
// An approved order whose edit brings the discount and the fee back inside the limit and the range is
// NOT_REQUIRED again, and a rejected one can still be approved later (TDD_17 §4.13).
export const PriceApprovalTransitions: Record<PriceApprovalStatus, readonly PriceApprovalStatus[]> =
  {
    [PriceApprovalStatus.NOT_REQUIRED]: [PriceApprovalStatus.PENDING],
    [PriceApprovalStatus.PENDING]: [
      PriceApprovalStatus.APPROVED,
      PriceApprovalStatus.REJECTED,
      PriceApprovalStatus.NOT_REQUIRED
    ],
    [PriceApprovalStatus.APPROVED]: [PriceApprovalStatus.PENDING, PriceApprovalStatus.NOT_REQUIRED],
    [PriceApprovalStatus.REJECTED]: [
      PriceApprovalStatus.APPROVED,
      PriceApprovalStatus.PENDING,
      PriceApprovalStatus.NOT_REQUIRED
    ]
  }

// NOT_APPLICABLE and VOID are terminal. REMITTED returns to PENDING_REMITTANCE when a remittance
// is voided.
export const CodStatusTransitions: Record<CodStatus, readonly CodStatus[]> = {
  [CodStatus.NOT_APPLICABLE]: [],
  [CodStatus.NOT_DELIVERED]: [CodStatus.PENDING_REMITTANCE, CodStatus.VOID],
  [CodStatus.PENDING_REMITTANCE]: [CodStatus.REMITTED, CodStatus.DISCREPANCY, CodStatus.VOID],
  [CodStatus.DISCREPANCY]: [CodStatus.REMITTED, CodStatus.PENDING_REMITTANCE],
  [CodStatus.REMITTED]: [CodStatus.PENDING_REMITTANCE],
  [CodStatus.VOID]: []
}

// The statuses of a package that never brought its cash: a cash-on-delivery guide that reaches one without having been
// delivered goes to VOID (TDD_17 §4.15)
export const CodVoidingStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.CANCELLED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED
]

export const RemittanceStatusTransitions: Record<RemittanceStatus, readonly RemittanceStatus[]> = {
  [RemittanceStatus.DRAFT]: [RemittanceStatus.CONFIRMED],
  [RemittanceStatus.CONFIRMED]: [RemittanceStatus.VOIDED],
  [RemittanceStatus.VOIDED]: []
}

export const PickupStatusTransitions: Record<PickupStatus, readonly PickupStatus[]> = {
  [PickupStatus.PENDING]: [
    PickupStatus.REQUESTED,
    PickupStatus.MANUAL_REQUIRED,
    PickupStatus.REQUIRES_REVIEW,
    PickupStatus.FAILED
  ],
  [PickupStatus.REQUIRES_REVIEW]: [PickupStatus.REQUESTED, PickupStatus.FAILED],
  [PickupStatus.REQUESTED]: [PickupStatus.CONFIRMED, PickupStatus.CANCELLED, PickupStatus.FAILED],
  [PickupStatus.MANUAL_REQUIRED]: [PickupStatus.CONFIRMED, PickupStatus.CANCELLED],
  [PickupStatus.CONFIRMED]: [PickupStatus.CANCELLED],
  [PickupStatus.CANCELLED]: [],
  [PickupStatus.FAILED]: []
}

// ---------------------------------------------------------------- the shipment engine (TDD_17 §4.5, §4.8)

// One guide at a time per order: the lock the write of a shipment takes (TDD_17 §4.5 step 7), kept apart from the lock of
// the row of the order that the order service takes
export const ShipmentLockScopes = { ORDER: 'order_shipping' } as const

export const ShipmentLimits = {
  // What a plugin may take for one call before the outcome is given up as unknown (a guide may exist: never "failed")
  PROVIDER_TIMEOUT_MS: 30_000,
  // A carrier that declares IDEMPOTENT_CREATE is asked again with the same key, never more than this many times in all
  IDEMPOTENT_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 250,
  // The most shipments one call of `createShipments` takes, and the most one pickup-bound call carries when the plugin
  // does not say
  MAX_REQUESTS: 100,
  DEFAULT_BATCH_SIZE: 50,
  // What `lastError` keeps of what a carrier said: one line, bounded
  LAST_ERROR_MAX_LENGTH: 300,
  // A label is a page or a few: anything bigger is not one
  LABEL_MAX_BYTES: 5 * 1024 * 1024,
  GUIDE_NUMBER_MAX_LENGTH: 100,
  NOTES_MAX_LENGTH: 500,
  DESCRIPTION_MAX_LENGTH: 300
} as const

// Why a shipment is where it is, as a name of a closed list, for what the platform decided (what a carrier said, when it
// refused, is its own message, trimmed)
export const ShipmentFailureReasons = {
  UNKNOWN_OUTCOME: 'unknown_outcome', // the call did not answer: a guide may exist
  INVALID_ANSWER: 'invalid_answer', // the plugin answered with something the platform cannot use
  AUTH: 'auth', // the carrier rejected the credentials
  CREDENTIALS_UNREADABLE: 'credentials_unreadable', // the stored credentials do not open
  LABEL_INVALID: 'label_invalid', // the label the carrier gave is not a PDF the platform can keep
  RECORD_FAILED: 'record_failed', // the carrier made the guide and the platform could not write it down
  MARKED_FAILED: 'marked_failed', // an agent decided it failed
  NOT_QUEUED: 'not_queued' // the void could not be handed to the queue: an agent asks again
} as const
export type ShipmentFailureReason =
  (typeof ShipmentFailureReasons)[keyof typeof ShipmentFailureReasons]

// The statuses in which a shipment still holds its order and warehouse in the database (the partial unique index
// `shipments_one_active_outbound` lists the complement: cancelled, failed and returned, a package that is back)
export const ShipmentInactiveStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.CANCELLED,
  ShipmentStatus.FAILED,
  ShipmentStatus.RETURNED
]

// A guide may exist and nobody knows: nothing may be created again for the order
export const ShipmentUnknownOutcomeStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.CREATING,
  ShipmentStatus.REQUIRES_REVIEW
]

// The package has left: the order cannot be cancelled any more (TDD_17 §4.8)
export const ShipmentPastPickupStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING
]

// The package is in the carrier's hands and on its way to the customer: the order has shipped (TDD_17 §4.9). Coming back
// (`RETURNING`, `RETURNED`) is not a shipment of the order: it has no effect on it
export const ShipmentLeftStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED
]

// What an agent may set by hand (TDD_17 §4.2, §4.9): the statuses the packages go through, and the two that settle a
// guide whose outcome was unknown. The table of transitions still decides from where.
export const ManualShipmentStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.LABEL_CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED,
  ShipmentStatus.FAILED
]

// The statuses whose stored label is a guide that is good to print (TDD_17 §4.6): made, and not voided, failed or unsure. A
// guide that was cancelled, that failed, whose outcome is unknown or whose cancellation is under way is never printed.
export const ShipmentPrintableStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.LABEL_CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED
]

// Voiding a guide at its carrier (TDD_17 §4.8): a carrier that does not answer is asked again this many times in all, with the
// pauses doubling from the base, and then the guide is left CANCEL_FAILED for an agent to settle
export const ShipmentCancelLimits = {
  JOB_ATTEMPTS: 5,
  BACKOFF_BASE_MS: 30_000
} as const

// What an edit of an order changes that a guide that already exists was made for (TDD_17 §4.8): the guide is voided and the
// agent makes another one
export const GuideAffectingFields = {
  ADDRESS: 'address',
  RECIPIENT_PHONES: 'recipient_phones',
  PAYMENT_METHOD: 'payment_method',
  ITEMS: 'items',
  COD_TOTAL: 'cod_total',
  CARRIER: 'carrier'
} as const
export type GuideAffectingField = (typeof GuideAffectingFields)[keyof typeof GuideAffectingFields]

// Bulk generation and the merge of stored labels (TDD_17 §4.6)
export const BulkLabelLimits = {
  // Orders of one run, and shipments of one merge
  MAX_ORDERS: ShipmentLimits.MAX_REQUESTS,
  // Guides asked of one standalone connection at the same time when its plugin does not say; a plugin may ask for fewer or more
  // but never beyond the ceiling
  DEFAULT_CONCURRENCY: 3,
  MAX_CONCURRENCY: 10,
  // What the merge keeps in memory: the stored labels it reads add up to at most this much, and the rest are left out and
  // reported (a label is a page: a hundred of them are a few megabytes)
  MAX_MERGE_INPUT_BYTES: 64 * 1024 * 1024,
  // A label a carrier made is scanned by the worker before it may be merged: the run waits this long for the scan, asking
  // every interval, and leaves out (and reports) the label that is still not clean
  SCAN_WAIT_MS: 60_000,
  SCAN_POLL_MS: 2_000,
  // Runs of one store that may be queued or running at the same time
  MAX_ACTIVE_RUNS: 5,
  // What a refused request is told to wait: a run takes about this long to end
  RETRY_AFTER_SECONDS: 60,
  // How long a merged file is kept when the store has no setting of its own (the column `StoreSettings.bulkLabelRetentionDays`
  // has the same default), and how many files one run of the cleanup removes
  DEFAULT_RETENTION_DAYS: 7,
  CLEAN_FILES_PER_RUN: 200,
  // A run that has been queued or running for this long is not going to end by itself (the worker died, or the queue lost the
  // job): the cleanup closes it as failed, so that the screen stops waiting for it
  STALE_JOB_HOURS: 2,
  // The attempts of the job in the queue: a second one finds what the first made (an order that has its guide is reused)
  JOB_ATTEMPTS: 2
} as const

// What happened to one order of a bulk run
export const BulkOrderOutcomes = {
  // A guide was made in this run
  CREATED: 'created',
  // The order already had a guide with a label that is good to print: its stored label is used, nobody is called
  REUSED: 'reused',
  // Nothing was asked of the carrier: the order did not qualify (`errorCode` says why)
  SKIPPED: 'skipped',
  // The carrier was asked and did not give a guide, or the guide is not in the file (`errorCode` / `reason` say why)
  FAILED: 'failed'
} as const
export type BulkOrderOutcome = (typeof BulkOrderOutcomes)[keyof typeof BulkOrderOutcomes]

// Why a label that exists is not in the merged file
export const BulkLabelLeftOutReasons = {
  // Cancelled, failed, unsure or being cancelled: a voided label is never printed
  NOT_PRINTABLE: 'not_printable',
  // The guide has no stored file (a carrier that gave none, or one the platform did not keep)
  NO_LABEL: 'no_label',
  // The file is not clean yet (the scan has not finished) or is gone
  NOT_READY: 'not_ready',
  // The file is not a PDF the platform can read
  UNREADABLE: 'unreadable',
  // The files already read fill what a merge may keep
  TOO_LARGE: 'too_large',
  // The shipment is not one of the store
  NOT_FOUND: 'not_found'
} as const
export type BulkLabelLeftOutReason =
  (typeof BulkLabelLeftOutReasons)[keyof typeof BulkLabelLeftOutReasons]

// The window of a pickup when nobody chose one (HH:mm, in the store timezone)
export const PickupDefaults = { WINDOW_FROM: '09:00', WINDOW_TO: '17:00' } as const

// The key a guide is asked for with (TDD_17 §4.5 step 2): the same order, origin and attempt always make the same key, so a
// carrier that keeps its promise never makes a second guide for it. The store is not part of it (the column is unique per
// store).
export function shipmentIdempotencyKey(
  orderId: string,
  originWarehouseId: string | null,
  attempt: number
): string {
  return `shipment:${orderId}:${originWarehouseId ?? 'none'}:${attempt}`
}

// What the history of a shipment says when the platform wrote the line itself: an i18n key, translated by the screen
// What a pickup is left saying when a cancelled shipment left it and the carrier could not be told (`PickupRequest.lastError`,
// TDD_17 §4.8): the agent settles it with the carrier
export const PickupLeaveNotes = {
  NOT_UPDATED: 'shipment_left_carrier_not_updated',
  EMPTY_NOT_CANCELLED: 'pickup_emptied_carrier_not_cancelled'
} as const

// The description of a manual event is a key the screen translates (Step 4.14 writes the texts)
export const ShipmentEventNotes = {
  FOUND_AT_CARRIER: 'shipping.event.foundAtCarrier',
  RECEIVED_AT_WAREHOUSE: 'shipping.event.receivedAtWarehouse'
} as const

// One writer at a time per connection when a pickup is made or joined (TDD_17 §4.10): a manual request and the scheduler never
// create two pickups for one connection and day. Kept apart from the lock of the order.
export const PickupLockScopes = { CONNECTION: 'pickup_connection' } as const

export const PickupLimits = {
  // The carrier is asked again by the queue while it does not answer; the last attempt leaves the pickup FAILED
  JOB_ATTEMPTS: 5,
  BACKOFF_BASE_MS: 30_000,
  // The most guides one request names
  MAX_SHIPMENTS: 200
} as const

// A pickup that is still alive: a connection has at most one of these per day (a standalone carrier), and a guide joins one of
// them. FAILED and CANCELLED are over.
export const PickupOpenStatuses: readonly PickupStatus[] = [
  PickupStatus.PENDING,
  PickupStatus.REQUIRES_REVIEW,
  PickupStatus.REQUESTED,
  PickupStatus.CONFIRMED,
  PickupStatus.MANUAL_REQUIRED
]

// Why a guide that was offered to a pickup was not put in it and waits for the next pickup day (TDD_17 §4.10): the agent is shown
// the reason
export const PickupWaitReasons = {
  // The pickup already reached the carrier and the carrier cannot change its count
  CARRIER_CANNOT_MODIFY: 'carrier_cannot_modify',
  // Nobody knows if the carrier took the request: nothing joins it until a person settles it
  UNDER_REVIEW: 'under_review',
  // The cutoff of the day passed: a change of the pickup of today needs the confirmation of a person
  CUTOFF_PASSED: 'cutoff_passed'
} as const
export type PickupWaitReason = (typeof PickupWaitReasons)[keyof typeof PickupWaitReasons]

// Why a pickup asks for a person (`pickup.manual_required`)
export const PickupManualReasons = {
  // The carrier has no pickup API (or no way to request one)
  NO_API: 'no_api',
  // The carrier did not take the request after every attempt
  FAILED: 'failed',
  // Nobody knows if the carrier took it: a person looks at the carrier before asking again
  REVIEW: 'review'
} as const
export type PickupManualReason = (typeof PickupManualReasons)[keyof typeof PickupManualReasons]

// What `PickupRequest.lastError` says when the platform ended a request itself (a refusal keeps the carrier's own line, bounded):
// names the screen translates
export const PickupFailureNotes = {
  UNAVAILABLE: 'carrier_unavailable',
  CREDENTIALS_REJECTED: 'credentials_rejected',
  CREDENTIALS_UNREADABLE: 'credentials_unreadable',
  UNKNOWN_OUTCOME: 'unknown_outcome',
  UNUSABLE_ANSWER: 'unusable_answer',
  CONNECTION_LOST: 'connection_not_active',
  EMPTY: 'pickup_empty'
} as const

// How a sync job is queued, wherever it comes from (a request, the scheduler, its sweep): the same attempts and backoff
export const pickupSyncJobOptions = (jobId: string) =>
  ({
    jobId,
    attempts: PickupLimits.JOB_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: PickupLimits.BACKOFF_BASE_MS }
  }) as const

// How the scheduler and its sweep behave (TDD_17 §4.10)
export const PickupSchedule = {
  // A pickup still PENDING after this long was never queued (the queue was down) or its job was lost: the sweep queues it again
  // (longer than the five attempts of a job with its backoff, so the sweep never doubles a job that is still asking again)
  PENDING_STALE_MS: 15 * 60 * 1000,
  // A pickup whose count the carrier has not acknowledged for this long is told again by the sweep, at most once per bucket
  RESYNC_AFTER_MS: 15 * 60 * 1000,
  SWEEP_BUCKET_MS: 30 * 60 * 1000,
  // The most pickups the sweep queues in one minute: the rest wait for the next
  SWEEP_BATCH: 100,
  // How long what the scheduler did for a day is remembered (the day of the store ends well inside it)
  MEMORY_TTL_SECONDS: 36 * 60 * 60,
  // How long the claim of a minute is kept (a tick of that minute is long over)
  EVALUATION_MEMORY_SECONDS: 3 * 60
} as const

export const PickupResourceTypes = { PICKUP: 'pickup' } as const

// The key a pickup is requested of the carrier with: the same pickup always makes the same key, so a carrier that keeps its
// promise never makes a second pickup for it
export const pickupRequestKey = (pickupId: string): string => `pickup-request:${pickupId}`

// The keys a carrier is called with besides the one of a guide (TDD_17 §4.5, §4.8): one for a whole pickup batch, one for a void
export const pickupBatchKey = (pickupId: string): string => `pickup:${pickupId}`
export const cancelShipmentKey = (guideKey: string): string => `cancel:${guideKey}`

export const ReturnResourceTypes = {
  RETURN: 'return'
} as const

export const ShipmentResourceTypes = {
  SHIPMENT: 'shipment',
  BULK_LABEL_JOB: 'bulk_label_job',
  REMITTANCE: 'remittance'
} as const

// The statuses a carrier moves a package into (TDD_17 §4.9; `CarrierReportableStatuses` is what a plugin may map to). Every other status is the platform's to set: a carrier that
// says "created" or "cancelled" in a poll is history, never a move
export const CarrierMovableStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED
]

// Polling (TDD_17 §4.9): each connection at its own interval, never below the minimum; one with a webhook only as a safety net;
// a package older than the cutoff is asked once a day
export const CarrierPolling = {
  DEFAULT_INTERVAL_MINUTES: 15,
  MIN_INTERVAL_MINUTES: 5,
  WEBHOOK_SAFETY_NET_MINUTES: 60,
  OLD_AFTER_DAYS: 14,
  // The hour (UTC) of the run that also asks the old packages
  OLD_RUN_HOUR_UTC: 4,
  BATCH_SIZE: 50,
  // The scheduler ticks every ten minutes: a bucket of an interval is queued on its first tick only
  TICK_MINUTES: 10
} as const

// What the engine did with an event of a carrier (a webhook or a poll)
export const CarrierEventOutcomes = {
  APPLIED: 'applied',
  // The same event again (its id, or its status and moment): nothing changes
  DUPLICATE: 'duplicate',
  // Kept in the history and no move: an older event, a status a carrier does not set, or one the table does not allow from here
  STORED: 'stored',
  // Nothing was kept: the connection is not active, the shipment is not ours, or the moment is not a moment
  IGNORED: 'ignored'
} as const
export type CarrierEventOutcome = (typeof CarrierEventOutcomes)[keyof typeof CarrierEventOutcomes]

export const CarrierResourceTypes = { CARRIER_CONNECTION: 'carrier_connection' } as const

// What a carrier's webhook proves (TDD_17 §4.9). A signature binds the body to the secret; a carrier that signs nothing (C807)
// sends the secret itself in a header, which proves less, so an event that closes money or the order is confirmed with the
// carrier before it is applied
export const CarrierWebhookTrust = {
  SIGNED: 'signed',
  SHARED_SECRET: 'shared_secret'
} as const
export type CarrierWebhookTrustType = (typeof CarrierWebhookTrust)[keyof typeof CarrierWebhookTrust]

// The replay of the events kept under a code the owner has mapped (TDD_17 §4.17): the lines are read in pages, oldest first
export const CarrierReplayLimits = { PAGE_SIZE: 200 } as const
