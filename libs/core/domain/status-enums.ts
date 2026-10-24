// Prisma stores these as String (not native enums) so values can be added without a migration.
// The TypeScript enum is the source of truth for validation. Every String column that holds a
// state has an enum here (see the "Prisma column -> enum" table in TDD_02 §5).

export enum ConversationStatus {
  OPEN = 'OPEN',
  PENDING = 'PENDING',
  RESOLVED = 'RESOLVED',
  ARCHIVED = 'ARCHIVED',
  SNOOZED = 'SNOOZED',
  SPAM = 'SPAM'
}

export enum OrderStatus {
  PENDING_CONFIRMATION = 'PENDING_CONFIRMATION',
  CONFIRMED = 'CONFIRMED',
  PREPARING = 'PREPARING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  RETURNED = 'RETURNED'
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED'
}

export enum PaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  CARD = 'CARD',
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
  OTHER = 'OTHER'
}

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  DOCUMENT = 'DOCUMENT',
  LOCATION = 'LOCATION',
  INTERNAL_NOTE = 'INTERNAL_NOTE',
  SYSTEM = 'SYSTEM',
  PRODUCT_CARD = 'PRODUCT_CARD',
  ORDER_SUMMARY = 'ORDER_SUMMARY',
  TEMPLATE = 'TEMPLATE'
}

export enum AuthorType {
  CUSTOMER = 'customer',
  AGENT = 'agent',
  SYSTEM = 'system'
}

export enum DeliveryStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed'
}

export enum MembershipStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED'
}

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED'
}

export enum ChannelType {
  WHATSAPP = 'whatsapp',
  INSTAGRAM = 'instagram',
  MESSENGER = 'messenger',
  WEB_WIDGET = 'web_widget',
  EMAIL = 'email'
}

export enum ChannelConnectionStatus {
  ACTIVE = 'active',
  ERROR = 'error',
  DISCONNECTED = 'disconnected'
}

// Replaces the v1.1 enum (TDD_16 §3). The ledger is append-only.
export enum InventoryMovementType {
  RECEIPT = 'receipt', // onHand +q (receiving, opening stock)
  ISSUE = 'issue', // onHand -q and reserved -q (order shipped, consumes its reservation)
  RESERVE = 'reserve', // reserved +q
  RELEASE = 'release', // reserved -q
  ADJUSTMENT_IN = 'adjustment_in', // onHand +q (manual, needs a reason)
  ADJUSTMENT_OUT = 'adjustment_out', // onHand -q (manual, needs a reason)
  TRANSFER_OUT = 'transfer_out', // onHand -q (transfer dispatched)
  TRANSFER_IN = 'transfer_in', // onHand +q (transfer received)
  COUNT_IN = 'count_in', // onHand +q (count variance)
  COUNT_OUT = 'count_out', // onHand -q (count variance)
  RETURN_IN = 'return_in' // onHand +q (returned order restocked)
}

export enum InventoryAdjustmentReason {
  OPENING_STOCK = 'opening_stock',
  DAMAGED = 'damaged',
  LOST = 'lost',
  FOUND = 'found',
  CORRECTION = 'correction',
  OTHER = 'other'
}

export enum InventoryReferenceType {
  ORDER = 'order',
  TRANSFER = 'transfer',
  COUNT = 'count',
  MANUAL = 'manual'
}

export enum TransferStatus {
  DRAFT = 'draft',
  IN_TRANSIT = 'in_transit',
  RECEIVED = 'received',
  CANCELLED = 'cancelled'
}

export enum TransferShortageAction {
  WRITE_OFF = 'write_off',
  RETURN_TO_SOURCE = 'return_to_source'
}

export enum CountStatus {
  DRAFT = 'draft',
  COUNTING = 'counting',
  REVIEW = 'review',
  APPLIED = 'applied',
  CANCELLED = 'cancelled'
}

export enum MediaStatus {
  PENDING = 'pending',
  CLEAN = 'clean',
  INFECTED = 'infected'
}

export enum WebhookStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled', // Auto-disabled after repeated failures, TDD_07 §2
  PAUSED = 'paused' // Paused by the store admin
}

export enum PluginInstallationStatus {
  PENDING_SETUP = 'pending_setup',
  ACTIVE = 'active',
  DISABLED = 'disabled',
  REVOKED = 'revoked'
}

// Marketplace catalog entry (TDD_10 §8). The marketplace is deferred; the owner's private
// plugins are stored APPROVED.
export enum PluginStatus {
  SUBMITTED = 'submitted',
  CHANGES_REQUESTED = 'changes_requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended'
}

export enum ApiKeyStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked'
}

export enum DsrType {
  ACCESS = 'access',
  PORTABILITY = 'portability',
  RECTIFICATION = 'rectification',
  ERASURE = 'erasure',
  RESTRICTION = 'restriction',
  OBJECTION = 'objection'
}

export enum DsrStatus {
  PENDING_VERIFICATION = 'pending_verification',
  IN_PROGRESS = 'in_progress',
  MANUAL_REVIEW = 'manual_review',
  COMPLETED = 'completed',
  REJECTED = 'rejected'
}

export enum VerificationTokenType {
  MAGIC_LINK = 'magic_link',
  DSR_VERIFICATION = 'dsr_verification'
}

export enum NotificationChannel {
  IN_APP = 'in_app',
  PUSH = 'push',
  EMAIL = 'email',
  SOUND = 'sound'
}

export enum DigestFrequency {
  IMMEDIATE = 'immediate',
  HOURLY = 'hourly',
  DAILY = 'daily',
  OFF = 'off'
}

// Shipping (TDD_17 §3)

export enum ShipmentStatus {
  CREATING = 'creating', // row written, carrier call in flight
  LABEL_CREATED = 'label_created',
  PICKED_UP = 'picked_up',
  IN_TRANSIT = 'in_transit',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  FAILED_ATTEMPT = 'failed_attempt',
  DELIVERED = 'delivered',
  RETURNING = 'returning', // the carrier is bringing the package back
  RETURNED = 'returned', // it arrived back at the sender
  CANCEL_PENDING = 'cancel_pending',
  CANCELLED = 'cancelled',
  CANCEL_FAILED = 'cancel_failed',
  REQUIRES_REVIEW = 'requires_review', // the outcome of the carrier call is unknown (TDD_17 §4.5)
  FAILED = 'failed' // the carrier refused; no guide exists
}

export enum ShipmentKind {
  OUTBOUND = 'outbound',
  RETURN = 'return'
}

export enum ShippingPayer {
  SENDER = 'sender',
  RECIPIENT = 'recipient'
}

export enum GuideRefundStatus {
  NOT_APPLICABLE = 'not_applicable',
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  NOT_SUPPORTED = 'not_supported'
}

export enum ShipmentEventSource {
  WEBHOOK = 'webhook',
  POLL = 'poll',
  MANUAL = 'manual',
  SYSTEM = 'system'
}

export enum CarrierConnectionStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  ERROR = 'error'
}

export enum PickupStatus {
  PENDING = 'pending',
  REQUIRES_REVIEW = 'requires_review',
  REQUESTED = 'requested',
  CONFIRMED = 'confirmed',
  MANUAL_REQUIRED = 'manual_required',
  CANCELLED = 'cancelled',
  FAILED = 'failed'
}

export enum BulkLabelJobStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  COMPLETED_WITH_ERRORS = 'completed_with_errors',
  FAILED = 'failed'
}

export enum OrderConfirmationChannel {
  MESSAGE_REPLY = 'message_reply',
  CALL = 'call',
  IN_PERSON = 'in_person',
  AT_CREATION = 'at_creation',
  OTHER = 'other'
}

export enum OrderReturnType {
  REFUND = 'refund',
  EXCHANGE = 'exchange'
}

export enum OrderReturnStatus {
  REQUESTED = 'requested',
  APPROVED = 'approved',
  IN_TRANSIT = 'in_transit',
  RECEIVED = 'received',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled'
}

export enum OrderReturnCondition {
  RESELLABLE = 'resellable',
  DEFECTIVE = 'defective',
  DAMAGED = 'damaged'
}

export enum PriceApprovalStatus {
  NOT_REQUIRED = 'not_required',
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected'
}

export enum CodStatus {
  NOT_APPLICABLE = 'not_applicable',
  NOT_DELIVERED = 'not_delivered',
  PENDING_REMITTANCE = 'pending_remittance',
  REMITTED = 'remitted',
  DISCREPANCY = 'discrepancy',
  VOID = 'void'
}

export enum RemittanceStatus {
  DRAFT = 'draft',
  CONFIRMED = 'confirmed',
  VOIDED = 'voided'
}

export enum RemittanceLineOutcome {
  MATCHED = 'matched',
  AMOUNT_DIFFERS = 'amount_differs',
  NOT_FOUND = 'not_found',
  NOT_DELIVERED = 'not_delivered',
  ALREADY_REMITTED = 'already_remitted',
  DUPLICATE_IN_FILE = 'duplicate_in_file'
}

export enum ReceptionBatchStatus {
  DRAFT = 'draft',
  COMPLETED = 'completed'
}

export enum ReceptionItemOutcome {
  RECEIVED = 'received',
  FAILED = 'failed'
}

// Display metadata co-located with the enums, as i18n keys and never as strings. The frontend
// resolves them with next-intl; emails resolve them with the server-side renderer.

export const ConversationStatusI18nKeys: Record<ConversationStatus, string> = {
  [ConversationStatus.OPEN]: 'conversations.status.OPEN',
  [ConversationStatus.PENDING]: 'conversations.status.PENDING',
  [ConversationStatus.RESOLVED]: 'conversations.status.RESOLVED',
  [ConversationStatus.ARCHIVED]: 'conversations.status.ARCHIVED',
  [ConversationStatus.SNOOZED]: 'conversations.status.SNOOZED',
  [ConversationStatus.SPAM]: 'conversations.status.SPAM'
}

export const OrderStatusI18nKeys: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_CONFIRMATION]: 'orders.status.PENDING_CONFIRMATION',
  [OrderStatus.CONFIRMED]: 'orders.status.CONFIRMED',
  [OrderStatus.PREPARING]: 'orders.status.PREPARING',
  [OrderStatus.SHIPPED]: 'orders.status.SHIPPED',
  [OrderStatus.DELIVERED]: 'orders.status.DELIVERED',
  [OrderStatus.CANCELLED]: 'orders.status.CANCELLED',
  [OrderStatus.RETURNED]: 'orders.status.RETURNED'
}

export const ConversationStatusColors: Record<ConversationStatus, string> = {
  [ConversationStatus.OPEN]: 'bg-blue-100 text-blue-800',
  [ConversationStatus.PENDING]: 'bg-yellow-100 text-yellow-800',
  [ConversationStatus.RESOLVED]: 'bg-green-100 text-green-800',
  [ConversationStatus.ARCHIVED]: 'bg-gray-100 text-gray-800',
  [ConversationStatus.SNOOZED]: 'bg-purple-100 text-purple-800',
  [ConversationStatus.SPAM]: 'bg-red-100 text-red-800'
}

export const OrderStatusColors: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_CONFIRMATION]: 'bg-yellow-100 text-yellow-800',
  [OrderStatus.CONFIRMED]: 'bg-blue-100 text-blue-800',
  [OrderStatus.PREPARING]: 'bg-purple-100 text-purple-800',
  [OrderStatus.SHIPPED]: 'bg-indigo-100 text-indigo-800',
  [OrderStatus.DELIVERED]: 'bg-green-100 text-green-800',
  [OrderStatus.CANCELLED]: 'bg-gray-100 text-gray-800',
  [OrderStatus.RETURNED]: 'bg-red-100 text-red-800'
}

export type OrderEditableField =
  'items' | 'shipping' | 'discount' | 'address' | 'paymentMethod' | 'notes' | 'trackingNumber'

// Which order statuses allow which edits: encodes the business rule once. trackingNumber is
// read-only while the order has an active shipment (TDD_17 §4.1); the service enforces that.
export const OrderEditableFields = {
  [OrderStatus.PENDING_CONFIRMATION]: [
    'items',
    'shipping',
    'discount',
    'address',
    'paymentMethod',
    'notes'
  ],
  [OrderStatus.CONFIRMED]: ['items', 'shipping', 'discount', 'address', 'paymentMethod', 'notes'],
  [OrderStatus.PREPARING]: ['shipping', 'address', 'notes'],
  [OrderStatus.SHIPPED]: ['address', 'notes', 'trackingNumber'],
  [OrderStatus.DELIVERED]: ['notes'],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: ['notes']
} as const satisfies Record<OrderStatus, readonly OrderEditableField[]>

// Valid state transitions: they prevent illegal jumps. SHIPPED is reachable straight from
// CONFIRMED because a guide may be created and picked up without the packing step (TDD_17 §3).
export const OrderStatusTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING_CONFIRMATION]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: []
}

export const ConversationStatusTransitions: Record<
  ConversationStatus,
  readonly ConversationStatus[]
> = {
  [ConversationStatus.OPEN]: [
    ConversationStatus.PENDING,
    ConversationStatus.RESOLVED,
    ConversationStatus.SNOOZED,
    ConversationStatus.SPAM
  ],
  [ConversationStatus.PENDING]: [
    ConversationStatus.OPEN,
    ConversationStatus.RESOLVED,
    ConversationStatus.SNOOZED,
    ConversationStatus.SPAM
  ],
  [ConversationStatus.RESOLVED]: [ConversationStatus.OPEN, ConversationStatus.ARCHIVED],
  [ConversationStatus.SNOOZED]: [ConversationStatus.OPEN],
  [ConversationStatus.ARCHIVED]: [ConversationStatus.OPEN],
  [ConversationStatus.SPAM]: [ConversationStatus.OPEN]
}
