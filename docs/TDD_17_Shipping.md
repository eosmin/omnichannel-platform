# TDD 17 — Shipping (carriers, shipments, pickups, returns and exchanges)

> Part of the Omnichannel Commerce Platform TDD v1.2
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: carrier plugins, the shipment lifecycle, order confirmation, label generation (single and
> bulk), cancellation with label void, pickup requests, customer messages with templates, returns
> and exchanges with scanner reception and a customer caution flag, price control, cash-on-delivery
> remittance reconciliation, store preferences, permissions and tenant isolation.
> This file **extends** `TDD_01 §4` (data model), `TDD_02` (constants), `TDD_09 §5` (orders UI),
> `TDD_10` (plugins) and `TDD_16 §4.1` (inventory effects of an order). Where it changes a model,
> a constant or a rule defined there, this file wins.
> Out of scope here (later phases): see §12.

---

## 1. Concepts and scoping

The owner ships orders with several carriers. Some expose an API and webhooks, some only an API,
and some are independent couriers with nothing to integrate. The platform follows its own rule
(`TDD_10 §1`): **a carrier is a plugin.** The shipping core knows nothing about any specific
carrier; you connect a carrier when you need it and disconnect it when you do not.

- **`CarrierPlugin`** (SDK type `'carrier'`, §4.1): a stateless singleton, like `ChannelPlugin`. It
  never touches Prisma, Redis or the event bus; the core passes everything in and persists
  everything it returns.
- **Official carriers live in code** (the registry of `TDD_10 §3`), exactly like the official
  channels: `forza`, `c807`, and `local` (§4.2). They are not `Plugin` rows. Third-party carriers
  reach the platform through the integration-plugin API (`shipments:read`, `shipments:write`
  scopes, §3) and the same shipment engine.
- **`CarrierConnection`** is one account of one carrier in one store (for example "C807 main
  account", or "Juan, motorcycle courier"). Several connections of the same carrier are allowed.
  Credentials are AES-256-GCM ciphertext, like `ChannelConnection.credentials`.
- **Two kinds of carrier:** *external* carriers (`forza`, `c807`) return their own guide and label;
  the *local* carrier (`local`) is an independent courier with no API: the platform generates the
  guide and the label itself and attaches them to that courier (§4.2).
- **Scope:** connections, shipments, pickups, bulk jobs, message templates and returns are
  **store-scoped** (`storeId`). The sender address comes from the order's warehouse
  (`Warehouse.address`, `TDD_16`), which is organization-scoped but read-only here.
- **Prepaid and cash on delivery (COD) are both normal.** A customer may pay in advance (a gift,
  the recipient pays nothing) or pay the carrier on delivery. This is derived from the order's
  payment method, never typed again per shipment (§4.4).
- **The shipment is the source of truth for transport; the order only reflects it.** Shipment
  events move the order through `OrdersService.updateStatus` with the actor `system` (§4.9).

| Resource | Scope column | Visible to |
|---|---|---|
| `CarrierConnection`, `CarrierService`, `GuideSequence` | `storeId` | members of the store |
| `Shipment`, `ShipmentEvent`, `PickupRequest`, `BulkLabelJob` | `storeId` | members of the store |
| `OrderMessageTemplate` | `storeId` | members of the store |
| `OrderReturn`, `OrderReturnLine` | `storeId` | members of the store |
| `ReturnReceptionBatch`, `ReturnReceptionItem` | `storeId` | members of the store |
| `CodRemittance`, `CodRemittanceLine`, `RemittanceImportProfile` | `storeId` | members of the store holding the remittance permissions |

---

## 2. Data model additions (Prisma, mapped names)

Mapped names follow `TDD_01 §4` (snake_case columns, plural tables). Enum-typed columns are
`String` in Prisma, with the enum in §3 (the project convention, `TDD_02 §5`).

```prisma
model CarrierConnection {
  id                    String    @id @default(uuid())
  storeId               String    @map("store_id")
  carrierId             String    @map("carrier_id")            // CarrierId: 'forza' | 'c807' | 'local'
  displayName           String    @map("display_name")
  status                String    @default("active")            // CarrierConnectionStatus
  credentials           Bytes?                                  // ciphertext; null for 'local'
  webhookSecret         Bytes?    @map("webhook_secret")        // ciphertext; per-connection secret for inbound webhooks
  defaultServiceCode    String?   @map("default_service_code")  // a CarrierService.code of this connection
  defaultShippingPayer  String    @default("sender") @map("default_shipping_payer")   // ShippingPayer
  labelFormat           String    @default("pdf_100x150") @map("label_format")        // LabelFormat
  contact               Json?                                   // 'local' only: { phone, notes }
  pickupEnabled         Boolean   @default(false) @map("pickup_enabled")
  pickupDays            Int[]     @default([1,2,3,4,5]) @map("pickup_days")           // ISO weekdays, 1 = Monday
  pickupCutoffTime      String?   @map("pickup_cutoff_time")                          // 'HH:mm' in the store timezone
  autoPickup            Boolean   @default(false) @map("auto_pickup")
  autoPickupTime        String?   @map("auto_pickup_time")                            // 'HH:mm' in the store timezone
  pickupReminderMinutes Int       @default(30) @map("pickup_reminder_minutes")
  pollIntervalMinutes   Int?      @map("poll_interval_minutes") // null = the plugin default; only for carriers polled instead of pushing
  lastHealthyAt         DateTime? @map("last_healthy_at")
  lastError             String?   @map("last_error")
  createdAt             DateTime  @default(now()) @map("created_at")
  updatedAt             DateTime  @updatedAt @map("updated_at")

  store     Store            @relation(fields: [storeId], references: [id], onDelete: Cascade)
  services  CarrierService[]
  shipments Shipment[]
  pickups   PickupRequest[]

  @@unique([storeId, displayName])
  @@index([storeId, status])
  @@map("carrier_connections")
}

// The service types a carrier offers (next day, express, ...). The code is what the carrier's
// API expects and differs per carrier; the label is what the owner sees. Seeded from the
// plugin's serviceCatalog() when the connection is created, editable afterwards.
model CarrierService {
  id           String  @id @default(uuid())
  storeId      String  @map("store_id")
  connectionId String  @map("connection_id")
  code         String                                  // carrier-specific, sent in the API call
  label        String
  active       Boolean @default(true)

  connection CarrierConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)

  @@unique([connectionId, code])
  @@map("carrier_services")
}

// Guide numbers for the 'local' carrier. One row per connection, advanced with
// UPDATE ... SET next_value = next_value + 1 RETURNING in the same transaction as the Shipment.
model GuideSequence {
  connectionId String @id @map("connection_id")
  storeId      String @map("store_id")
  prefix       String                                  // printed in front of the number, e.g. 'JM'
  nextValue    Int    @default(1) @map("next_value")

  @@map("guide_sequences")
}

model Shipment {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")
  orderId             String    @map("order_id")
  connectionId        String    @map("connection_id")
  kind                String    @default("outbound")          // ShipmentKind
  returnId            String?   @map("return_id")             // set when kind = return
  originWarehouseId   String?   @map("origin_warehouse_id")   // the warehouse the goods leave from (§4.5). The shipment's contents are the order's allocations from that warehouse (TDD_16 §4.1); there is no shipment-lines table
  status              String    @default("creating")          // ShipmentStatus
  serviceCode         String    @map("service_code")
  shippingPayer       String    @map("shipping_payer")        // ShippingPayer
  codAmountCents      Int?      @map("cod_amount_cents")      // null = prepaid
  currency            String
  packageCount        Int       @default(1) @map("package_count")
  weightGrams         Int?      @map("weight_grams")
  guideNumber         String?   @map("guide_number")          // the carrier's guide, or ours for 'local'
  providerShipmentId  String?   @map("provider_shipment_id")  // the carrier's internal id, when it has one
  trackingUrl         String?   @map("tracking_url")
  labelMediaId        String?   @map("label_media_id")        // Media purpose SHIPPING_LABEL
  carrierCostCents    Int?      @map("carrier_cost_cents")    // when the carrier reports it
  refundStatus        String    @default("not_applicable") @map("refund_status")   // GuideRefundStatus
  idempotencyKey      String    @unique @map("idempotency_key")
  pickupId            String?   @map("pickup_id")
  lastError           String?   @map("last_error")
  cancelRequestedAt   DateTime? @map("cancel_requested_at")
  cancelledAt         DateTime? @map("cancelled_at")
  createdBy           String    @map("created_by")            // user id or 'system'
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  connection CarrierConnection @relation(fields: [connectionId], references: [id])
  pickup     PickupRequest?    @relation(fields: [pickupId], references: [id])
  events     ShipmentEvent[]

  @@index([storeId, status])
  @@index([storeId, orderId])
  @@index([connectionId, status])
  @@map("shipments")
}
// Raw SQL in the same migration (Prisma cannot express a partial unique index):
//   CREATE UNIQUE INDEX shipments_one_active_outbound ON shipments (order_id, origin_warehouse_id) NULLS NOT DISTINCT
//     WHERE kind = 'outbound' AND status NOT IN ('cancelled', 'failed');   -- NULLS NOT DISTINCT (PostgreSQL 15+): an order with no warehouse is still limited to one
//   CREATE UNIQUE INDEX shipments_guide_per_connection ON shipments (connection_id, guide_number)
//     WHERE guide_number IS NOT NULL;
// An order may have several active outbound shipments only when split fulfillment (TDD_16 §4.1)
// allocated it to several warehouses: one per warehouse. A new guide for the same order and warehouse is possible only
// after the previous one is `CANCELLED` or `FAILED`; while it is `CANCEL_PENDING` or `CANCEL_FAILED` the index refuses it (§4.8).

model ShipmentEvent {
  id              String   @id @default(uuid())
  storeId         String   @map("store_id")
  shipmentId      String   @map("shipment_id")
  providerEventId String?  @map("provider_event_id")
  status          String?                                  // ShipmentStatus; null = an unmapped provider status, stored only
  rawStatus       String?  @map("raw_status")
  description     String?
  occurredAt      DateTime @map("occurred_at")
  receivedAt      DateTime @default(now()) @map("received_at")
  source          String                                   // ShipmentEventSource: webhook | poll | manual | system
  payload         Json?                                    // redacted (§4.12)

  shipment Shipment @relation(fields: [shipmentId], references: [id], onDelete: Cascade)

  @@index([shipmentId, occurredAt])
  @@map("shipment_events")
}
// Raw SQL: CREATE UNIQUE INDEX shipment_events_provider_dedupe ON shipment_events (shipment_id, provider_event_id)
//   WHERE provider_event_id IS NOT NULL;

model PickupRequest {
  id               String    @id @default(uuid())
  storeId          String    @map("store_id")
  connectionId     String    @map("connection_id")
  pickupDate       DateTime  @map("pickup_date") @db.Date   // in the store timezone
  status           String    @default("pending")             // PickupStatus
  packageCount     Int       @default(0) @map("package_count")
  revision         Int       @default(1)                     // +1 each time the package count is modified
  providerPickupId String?   @map("provider_pickup_id")
  windowStart      String?   @map("window_start")            // 'HH:mm', when the carrier lets us choose
  windowEnd        String?   @map("window_end")
  requestedBy      String    @map("requested_by")            // user id or 'system'
  lastError        String?   @map("last_error")
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  connection CarrierConnection @relation(fields: [connectionId], references: [id])
  shipments  Shipment[]

  @@index([storeId, pickupDate])
  @@map("pickup_requests")
}
// No unique index on (connection, date): a carrier whose guides exist only inside a pickup (§4.5) can need
// several pickups on one day. "At most one open pickup per connection and day" is a rule of
// ShippingService.ensurePickup for the other carriers (§4.10), enforced under an advisory lock and covered by a test.

model BulkLabelJob {
  id            String    @id @default(uuid())
  storeId       String    @map("store_id")
  status        String    @default("queued")                // BulkLabelJobStatus
  orderIds      String[]  @map("order_ids")                 // in the order the agent selected them (the PDF keeps it)
  total         Int
  succeeded     Int       @default(0)
  failed        Int       @default(0)
  results       Json?                                       // per order: { orderId, shipmentId?, outcome, errorCode? }
  mergedMediaId String?   @map("merged_media_id")           // Media purpose BULK_LABELS
  requestedBy   String    @map("requested_by")
  createdAt     DateTime  @default(now()) @map("created_at")
  finishedAt    DateTime? @map("finished_at")

  @@index([storeId, createdAt])
  @@map("bulk_label_jobs")
}

// Messages the store sends about an order, one template per kind and locale.
model OrderMessageTemplate {
  id              String   @id @default(uuid())
  storeId         String   @map("store_id")
  kind            String                                   // OrderMessageKind
  locale          String
  body            String                                   // plain text with {{variables}} from OrderMessageVariables
  autoSend        Boolean  @default(false) @map("auto_send")
  attachSummary   Boolean  @default(false) @map("attach_summary")   // attach the order summary PDF when the channel supports documents
  channelTemplate Json?    @map("channel_template")        // { pluginId, name, language, variables: OrderMessageVariable[] } — a pre-approved WhatsApp template (§4.7)
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@unique([storeId, kind, locale])
  @@map("order_message_templates")
}

model OrderReturn {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")
  orderId             String    @map("order_id")
  type                String                                  // OrderReturnType: refund | exchange
  reason              String                                  // OrderReturnReason
  status              String    @default("requested")         // OrderReturnStatus
  shippingPayer       String    @map("shipping_payer")        // who pays the return leg and the replacement (§4.11)
  replacementOrderId  String?   @map("replacement_order_id")  // exchange: the new order
  returnShipmentId    String?   @map("return_shipment_id")
  refundAmountCents   Int?      @map("refund_amount_cents")
  notes               String?
  createdBy           String    @map("created_by")
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")
  receivedAt          DateTime? @map("received_at")

  lines OrderReturnLine[]

  @@index([storeId, orderId])
  @@index([storeId, status])
  @@map("order_returns")
}

model OrderReturnLine {
  id              String  @id @default(uuid())
  storeId         String  @map("store_id")
  returnId        String  @map("return_id")
  orderItemId     String  @map("order_item_id")
  quantity        Int
  condition       String?                                    // OrderReturnCondition, set on receipt
  restockWarehouseId String? @map("restock_warehouse_id")    // set on receipt for resellable items

  return OrderReturn @relation(fields: [returnId], references: [id], onDelete: Cascade)

  @@unique([returnId, orderItemId])
  @@map("order_return_lines")
}
```

Reception, remittances and their import profiles (same conventions):

```prisma
model RemittanceImportProfile {
  id              String @id @default(uuid())
  storeId         String @map("store_id")
  connectionId    String @map("connection_id")
  name            String
  delimiter       String @default(",")                    // ',' ';' or tab; pasted tables use tab
  hasHeader       Boolean @default(true) @map("has_header")
  decimalSeparator String @default(".") @map("decimal_separator")   // '.' or ','
  dateFormat      String @default("yyyy-MM-dd") @map("date_format")
  columns         Json                                     // { guideNumber, amount, fee?, date?, reference? } -> header name or column index

  @@unique([connectionId, name])
  @@map("remittance_import_profiles")
}

// The carrier's settlement of cash collected on delivery. A draft is built from an import or by hand
// and confirmed once; a confirmed remittance is immutable and can only be voided.
model CodRemittance {
  id              String    @id @default(uuid())
  storeId         String    @map("store_id")
  connectionId    String    @map("connection_id")
  status          String    @default("draft")             // RemittanceStatus
  reference       String?                                  // the carrier's settlement number
  receivedOn      DateTime? @map("received_on") @db.Date
  importProfileId String?   @map("import_profile_id")
  sourceMediaId   String?   @map("source_media_id")       // the uploaded file, Media purpose REMITTANCE_FILE
  expectedCents   Int       @default(0) @map("expected_cents")   // the three totals are written at confirmation
  reportedCents   Int       @default(0) @map("reported_cents")
  feeCents        Int       @default(0) @map("fee_cents")
  note            String?
  createdBy       String    @map("created_by")
  createdAt       DateTime  @default(now()) @map("created_at")
  confirmedAt     DateTime? @map("confirmed_at")
  confirmedBy     String?   @map("confirmed_by")
  voidedAt        DateTime? @map("voided_at")
  voidedBy        String?   @map("voided_by")

  lines CodRemittanceLine[]

  @@index([storeId, connectionId, status])
  @@map("cod_remittances")
}

model CodRemittanceLine {
  id              String  @id @default(uuid())
  storeId         String  @map("store_id")
  remittanceId    String  @map("remittance_id")
  shipmentId      String? @map("shipment_id")             // null when the guide matched nothing
  guideNumber     String  @map("guide_number")            // as it appeared in the file, trimmed
  reportedCents   Int     @map("reported_cents")
  reportedFeeCents Int?   @map("reported_fee_cents")
  expectedCents   Int?    @map("expected_cents")
  outcome         String                                   // RemittanceLineOutcome
  excluded        Boolean @default(false)                  // the agent left it out of the confirmation
  note            String?

  remittance CodRemittance @relation(fields: [remittanceId], references: [id], onDelete: Cascade)

  @@index([remittanceId])
  @@map("cod_remittance_lines")
}

// A scanning session. Persisted as a draft so a refresh or a lost connection loses nothing.
model ReturnReceptionBatch {
  id          String    @id @default(uuid())
  storeId     String    @map("store_id")
  status      String    @default("draft")                  // ReceptionBatchStatus
  createdBy   String    @map("created_by")
  createdAt   DateTime  @default(now()) @map("created_at")
  completedAt DateTime? @map("completed_at")

  items ReturnReceptionItem[]

  @@index([storeId, status])
  @@map("return_reception_batches")
}

model ReturnReceptionItem {
  id            String   @id @default(uuid())
  storeId       String   @map("store_id")
  batchId       String   @map("batch_id")
  shipmentId    String   @map("shipment_id")
  reason        String                                     // OrderReturnReason
  note          String?
  lines         Json                                       // [{ orderItemId, quantity, condition, restockWarehouseId }], validated by Zod
  flagCustomer  Boolean  @default(false) @map("flag_customer")
  flagReason    String?  @map("flag_reason")
  outcome       String?                                    // ReceptionItemOutcome, set when the batch is completed
  errorCode     String?  @map("error_code")
  scannedAt     DateTime @default(now()) @map("scanned_at")

  batch ReturnReceptionBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)

  @@unique([batchId, shipmentId])
  @@map("return_reception_items")
}
```

Changes to existing models:

- `Order` (`TDD_01 §4`): `status` default becomes `PENDING_CONFIRMATION`; add `confirmedAt DateTime?`,
  `confirmedBy String?`, `confirmedVia String?` (`OrderConfirmationChannel`), and
  `exchangeOfOrderId String?` (the order this one replaces) and `copiedFromOrderId String?` (the order it was copied from). The `trackingNumber` column stays as a
  denormalized copy of the guide number of the order's only active outbound shipment (the print
  documents and the customer profile read it); with several shipments it stays `null` and the
  shipments list is the source. While an order has an active shipment, `trackingNumber` is **read-only** (it is
  derived, so `OrderEditableFields[SHIPPED]` offers it only for an order with no shipment).
- `StoreSettings` (`TDD_01 §4`): add `preferences Json @default("{}")` (validated by `storePreferencesSchema`, §4.14,
  the same pattern as the existing `safety` column), `returnShippingPayer String @default("sender")` (the default of
  `OrderReturn.shippingPayer`), `defaultCarrierConnectionId String?` (preselected when creating
  labels) and `bulkLabelRetentionDays Int @default(7)`.
- `Shipment`: add `codStatus String @default("not_applicable")` (`CodStatus`), `codExpectedCents Int?`
  (written when the shipment is delivered, §4.15), `codRemittedCents Int?` and `codRemittanceId String?`.
- `CarrierConnection`: add `defaultShippingFeeCents Int?`, `minShippingFeeCents Int?` and `maxShippingFeeCents Int?` (the shipping fee charged to the customer: the preset and the accepted range for this carrier, in the store currency, `min <= default <= max` when set, §4.13), and `remittanceDeductsFee Boolean @default(false)` (the carrier subtracts its fee from
  what it remits when the sender pays, §4.15).
- `OrderItem` (`TDD_01 §4`): add `originalUnitPriceCents Int?` (null unless the price was overridden),
  `priceOverrideReason String?`, `priceOverriddenBy String?`, and `freeShipping Boolean @default(false)` (a snapshot of
  `Product.freeShipping` at the time of the order, so a later catalog change never rewrites history).
- `Product` (`TDD_01 §4`): add `freeShipping Boolean @default(false)`: the price of this product already includes
  shipping ("free shipping"), §4.13.
- `Order` (the price, shipping and approval columns, §4.13): add `freeShipping Boolean @default(false)` (derived and stored when the order is saved: the free-shipping rule of §4.13 is
  satisfied), `discountReason String?`, `priceApprovalStatus String @default("not_required")`
  (`PriceApprovalStatus`), `priceApprovalRequestedBy String?`, `priceApprovedBy String?`,
  `priceApprovedAt DateTime?`, `priceApprovedDiscountCents Int?`, `priceApprovedShippingCents Int?`, and
  `carrierConnectionId String?` (the carrier planned for the order, chosen in the create-order drawer, §4.13; a plain
  column in the initial schema, the foreign key comes with the `CarrierConnection` table in Step 4.8); guide
  creation uses it as its default connection.
- `Customer`: add `isCaution Boolean @default(false)`, `cautionReason String?`, `cautionSetBy String?`,
  `cautionSetAt DateTime?` (§4.16). A merge keeps the flag if either side had it; an erasure clears the reason.
- `PaymentMethod` (`TDD_02 §5`) gains `CASH_ON_DELIVERY`. A COD order has a COD amount; a prepaid
  order does not (§4.4).
- `Media`: three new `MediaPurpose` values, `SHIPPING_LABEL`, `BULK_LABELS` and `REMITTANCE_FILE` (§3).
- The returned quantity of an order item is not a column: it is the sum of its non-rejected
  `OrderReturnLine.quantity`.

---

## 3. Constants (additions to `TDD_02`)

```typescript
// libs/core/domain/status-enums.ts
export enum OrderStatus {                    // adds PENDING_CONFIRMATION in front of the v1.1 values
  PENDING_CONFIRMATION = 'PENDING_CONFIRMATION',
  CONFIRMED = 'CONFIRMED',
  PREPARING = 'PREPARING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  RETURNED = 'RETURNED',
}

export enum ShipmentStatus {
  CREATING = 'creating',                     // row written, carrier call in flight
  LABEL_CREATED = 'label_created',
  PICKED_UP = 'picked_up',
  IN_TRANSIT = 'in_transit',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  FAILED_ATTEMPT = 'failed_attempt',
  DELIVERED = 'delivered',
  RETURNING = 'returning',                   // the carrier is bringing the package back
  RETURNED = 'returned',                     // it arrived back at the sender
  CANCEL_PENDING = 'cancel_pending',
  CANCELLED = 'cancelled',
  CANCEL_FAILED = 'cancel_failed',
  REQUIRES_REVIEW = 'requires_review',       // the outcome of the carrier call is unknown (§4.5)
  FAILED = 'failed',                         // the carrier refused; no guide exists
}

export enum ShipmentKind { OUTBOUND = 'outbound', RETURN = 'return' }
export enum ShippingPayer { SENDER = 'sender', RECIPIENT = 'recipient' }
export enum GuideRefundStatus { NOT_APPLICABLE = 'not_applicable', PENDING = 'pending', CONFIRMED = 'confirmed', NOT_SUPPORTED = 'not_supported' }
export enum ShipmentEventSource { WEBHOOK = 'webhook', POLL = 'poll', MANUAL = 'manual', SYSTEM = 'system' }
export enum CarrierConnectionStatus { ACTIVE = 'active', DISABLED = 'disabled', ERROR = 'error' }
export enum PickupStatus { PENDING = 'pending', REQUIRES_REVIEW = 'requires_review', REQUESTED = 'requested', CONFIRMED = 'confirmed', MANUAL_REQUIRED = 'manual_required', CANCELLED = 'cancelled', FAILED = 'failed' }
export enum BulkLabelJobStatus { QUEUED = 'queued', RUNNING = 'running', COMPLETED = 'completed', COMPLETED_WITH_ERRORS = 'completed_with_errors', FAILED = 'failed' }
export enum OrderConfirmationChannel { MESSAGE_REPLY = 'message_reply', CALL = 'call', IN_PERSON = 'in_person', AT_CREATION = 'at_creation', OTHER = 'other' }
export enum OrderReturnType { REFUND = 'refund', EXCHANGE = 'exchange' }
export enum OrderReturnStatus { REQUESTED = 'requested', APPROVED = 'approved', IN_TRANSIT = 'in_transit', RECEIVED = 'received', COMPLETED = 'completed', REJECTED = 'rejected', CANCELLED = 'cancelled' }
export enum OrderReturnCondition { RESELLABLE = 'resellable', DEFECTIVE = 'defective', DAMAGED = 'damaged' }
export enum PriceApprovalStatus { NOT_REQUIRED = 'not_required', PENDING = 'pending', APPROVED = 'approved', REJECTED = 'rejected' }
export enum CodStatus { NOT_APPLICABLE = 'not_applicable', NOT_DELIVERED = 'not_delivered', PENDING_REMITTANCE = 'pending_remittance', REMITTED = 'remitted', DISCREPANCY = 'discrepancy', VOID = 'void' }
export enum RemittanceStatus { DRAFT = 'draft', CONFIRMED = 'confirmed', VOIDED = 'voided' }
export enum RemittanceLineOutcome { MATCHED = 'matched', AMOUNT_DIFFERS = 'amount_differs', NOT_FOUND = 'not_found', NOT_DELIVERED = 'not_delivered', ALREADY_REMITTED = 'already_remitted', DUPLICATE_IN_FILE = 'duplicate_in_file' }
export enum ReceptionBatchStatus { DRAFT = 'draft', COMPLETED = 'completed' }
export enum ReceptionItemOutcome { RECEIVED = 'received', FAILED = 'failed' }

// libs/core/domain/shipping-constants.ts
export const CarrierId = { FORZA: 'forza', C807: 'c807', LOCAL: 'local' } as const
export const LabelFormat = { PDF_100X150: 'pdf_100x150', PDF_A6: 'pdf_a6', PDF_A4: 'pdf_a4' } as const   // see §4.6
export const OrderReturnReasons = {             // each value an i18n key
  DEFECTIVE: 'orders.return.reason.DEFECTIVE',
  WRONG_ITEM: 'orders.return.reason.WRONG_ITEM',
  NOT_AS_DESCRIBED: 'orders.return.reason.NOT_AS_DESCRIBED',
  DAMAGED_IN_TRANSIT: 'orders.return.reason.DAMAGED_IN_TRANSIT',
  DELIVERY_FAILED: 'orders.return.reason.DELIVERY_FAILED',
  REFUSED_BY_CUSTOMER: 'orders.return.reason.REFUSED_BY_CUSTOMER',
  CHANGED_MIND: 'orders.return.reason.CHANGED_MIND',
  OTHER: 'orders.return.reason.OTHER',
} as const
export const CarrierCapability = {
  CREATE_SHIPMENT: 'create_shipment',         // a guide can be created on its own (standalone carriers)
  PICKUP_BOUND_GUIDES: 'pickup_bound_guides', // guides exist only inside a pickup request: one call creates the pickup and returns the guides of every shipment in it (§4.5). Replaces CREATE_SHIPMENT
  CANCEL_SHIPMENT: 'cancel_shipment',
  RETURN_SHIPMENT: 'return_shipment',         // can create a guide from the customer to the warehouse
  IDEMPOTENT_CREATE: 'idempotent_create',     // accepts our reference as a unique key: a retry never makes a second guide
  FETCH_STATUS: 'fetch_status',               // polling
  WEBHOOK_STATUS: 'webhook_status',           // pushes status changes
  PICKUP_REQUEST: 'pickup_request',
  PICKUP_MODIFY: 'pickup_modify',             // the package count of an existing pickup can change
  PICKUP_CANCEL: 'pickup_cancel',
  REQUIRES_LOCATION_IDS: 'requires_location_ids',   // the API needs the carrier's own department/municipality/settlement ids
  INTERNAL_GUIDE: 'internal_guide',           // 'local' only: the platform generates the guide and label
  COD: 'cod',                                 // supports cash on delivery
} as const

// libs/core/domain/order-constants.ts
export const OrderMessageKind = {
  ORDER_SUMMARY: 'order_summary',
  ORDER_SHIPPED: 'order_shipped',
  ORDER_OUT_FOR_DELIVERY: 'order_out_for_delivery',
  ORDER_DELIVERED: 'order_delivered',
  ORDER_FAILED_ATTEMPT: 'order_failed_attempt',
  ORDER_CANCELLED: 'order_cancelled',
  RETURN_APPROVED: 'return_approved',
  EXCHANGE_SHIPPED: 'exchange_shipped',
} as const
export const OrderMessageVariables = {          // the only placeholders a template may use (§4.7)
  CUSTOMER_NAME: 'customerName', ORDER_NUMBER: 'orderNumber', ITEMS_LIST: 'itemsList', TOTAL: 'total',
  SHIPPING_ADDRESS: 'shippingAddress', CARRIER_NAME: 'carrierName', TRACKING_NUMBER: 'trackingNumber',
  TRACKING_URL: 'trackingUrl', STORE_NAME: 'storeName', COD_AMOUNT: 'codAmount',
} as const
```

Transition tables (same style as `OrderStatusTransitions`, enforced inside the owning service):

- **Order:** `PENDING_CONFIRMATION → CONFIRMED | CANCELLED`, `CONFIRMED → PREPARING | SHIPPED | CANCELLED`
  (`SHIPPED` straight from `CONFIRMED` because a guide may be created and picked up without the packing step),
  `PREPARING → SHIPPED | CANCELLED`, `SHIPPED → DELIVERED | RETURNED`, `DELIVERED → RETURNED`;
  `CANCELLED` and `RETURNED` terminal. `OrderEditableFields[PENDING_CONFIRMATION]` equals the
  `CONFIRMED` entry. `OrderStatusI18nKeys` and `OrderStatusColors` gain the new value.
- **Shipment** (forward-only, §4.9): `CREATING → LABEL_CREATED | REQUIRES_REVIEW | FAILED`;
  `REQUIRES_REVIEW → LABEL_CREATED | FAILED`; `LABEL_CREATED → PICKED_UP | IN_TRANSIT | CANCEL_PENDING`;
  `PICKED_UP → IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED | FAILED_ATTEMPT | RETURNING`;
  `IN_TRANSIT → OUT_FOR_DELIVERY | DELIVERED | FAILED_ATTEMPT | RETURNING`;
  `OUT_FOR_DELIVERY → DELIVERED | FAILED_ATTEMPT | RETURNING`;
  `FAILED_ATTEMPT → OUT_FOR_DELIVERY | DELIVERED | RETURNING`; `RETURNING → RETURNED`;
  `CANCEL_PENDING → CANCELLED | CANCEL_FAILED`; `CANCEL_FAILED → CANCEL_PENDING | CANCELLED`
  (the last by the agent, "mark as voided"). `DELIVERED`, `RETURNED`, `CANCELLED`, `FAILED` terminal.
- **Return:** `REQUESTED → APPROVED | REJECTED | CANCELLED`, `APPROVED → IN_TRANSIT | RECEIVED | CANCELLED`,
  `IN_TRANSIT → RECEIVED`, `RECEIVED → COMPLETED`; `REJECTED`, `CANCELLED`, `COMPLETED` terminal.
- **Price approval:** `NOT_REQUIRED → PENDING` (a discount above the store's limit, or a shipping fee outside the carrier's range), `PENDING → APPROVED | REJECTED | NOT_REQUIRED` (the last when the order is brought back within the limit and the range), `APPROVED → PENDING` (the discount or the fee moves beyond what was approved), `REJECTED → PENDING | NOT_REQUIRED`.
- **COD status:** `NOT_DELIVERED → PENDING_REMITTANCE | VOID`, `PENDING_REMITTANCE → REMITTED | DISCREPANCY | VOID`, `DISCREPANCY → REMITTED | PENDING_REMITTANCE`, `REMITTED → PENDING_REMITTANCE` (a voided remittance); `NOT_APPLICABLE` and `VOID` are terminal.
- **Remittance:** `DRAFT → CONFIRMED`, `CONFIRMED → VOIDED`; `VOIDED` terminal.
- **Pickup:** `PENDING → REQUESTED | MANUAL_REQUIRED | REQUIRES_REVIEW | FAILED`, `REQUIRES_REVIEW → REQUESTED | FAILED`, `REQUESTED → CONFIRMED | CANCELLED | FAILED`,
  `MANUAL_REQUIRED → CONFIRMED | CANCELLED`, `CONFIRMED → CANCELLED`; `CANCELLED` and `FAILED` terminal.

Other additions (each goes in its constants file, no inline strings):

| Set | New entries |
|---|---|
| `Permissions` | `SHIPPING_VIEW: 'shipping:view'`, `SHIPPING_MANAGE: 'shipping:manage'` (create, cancel, print, edit status by hand), `SHIPPING_MANAGE_PICKUPS: 'shipping:manage_pickups'`, `SETTINGS_MANAGE_CARRIERS: 'settings:manage_carriers'` (connections, credentials, services, pickup rules), `ORDERS_CONFIRM: 'orders:confirm'`, `ORDERS_SEND_MESSAGES: 'orders:send_messages'`, `SETTINGS_MANAGE_ORDER_TEMPLATES: 'settings:manage_order_templates'`, `RETURNS_VIEW: 'returns:view'`, `RETURNS_MANAGE: 'returns:manage'`, `ORDERS_OVERRIDE_PRICE: 'orders:override_price'`, `ORDERS_APPROVE_PRICE: 'orders:approve_price'`, `REMITTANCES_VIEW: 'remittances:view'`, `REMITTANCES_MANAGE: 'remittances:manage'`, `CUSTOMERS_FLAG_CAUTION: 'customers:flag_caution'`, `SETTINGS_MANAGE_PREFERENCES: 'settings:manage_preferences'` |
| `RolePresets` | Admin: all (spread). Supervisor: shipping view, manage and pickups, orders confirm and send messages, returns view and manage. Agent: shipping view and manage, orders confirm and send messages, returns view. Viewer: shipping view, returns view. The price, remittance, caution and preference permissions: Admin has all (spread); Supervisor: approve price, remittances view and manage, flag caution; Agent: flag caution; Viewer: remittances view |
| `Events` | `SHIPMENT_CREATED`, `SHIPMENT_STATUS_CHANGED`, `SHIPMENT_CANCELLED`, `SHIPMENT_REQUIRES_REVIEW`, `PICKUP_REQUESTED`, `PICKUP_UPDATED`, `ORDER_CONFIRMED`, `RETURN_REQUESTED`, `RETURN_APPROVED`, `RETURN_RECEIVED`, `ORDER_MESSAGE_SENT`, `ORDER_MESSAGE_FAILED`, `ORDER_PRICE_OVERRIDDEN`, `ORDER_PRICE_APPROVAL_REQUESTED`, `ORDER_PRICE_APPROVED`, `ORDER_PRICE_REJECTED`, `REMITTANCE_CONFIRMED`, `REMITTANCE_VOIDED`, `CUSTOMER_CAUTION_CHANGED` |
| `RealtimeEvents` | `BULK_LABELS_PROGRESS: { jobId, done, total, failed }`, `BULK_LABELS_DONE: { jobId, status, mergedMediaId }`, `SHIPMENT_UPDATED: { orderId, shipmentId, status }` |
| `NotificationTypes` | `PICKUP_CUTOFF_APPROACHING` (to `SHIPPING_MANAGE_PICKUPS`; warning; in-app and push), `PICKUP_MANUAL_REQUIRED` (same recipients; in-app), `SHIPMENT_CANCEL_FAILED` (to `SHIPPING_MANAGE`; warning; in-app and push), `SHIPMENT_REQUIRES_REVIEW` (same), `SHIPMENT_FAILED_ATTEMPT` (to `SHIPPING_MANAGE`; info), `ORDER_MESSAGE_NOT_SENT` (to `ORDERS_SEND_MESSAGES`; warning), `BULK_LABELS_READY` (to the requester; info; in-app), `RETURN_AWAITING_RECEIPT` (to `RETURNS_MANAGE`; info). Each needs an entry in `NotificationDefaults`, which must stay complete. Also `ORDER_PRICE_APPROVAL_REQUESTED` (to `ORDERS_APPROVE_PRICE`; warning; in-app and push), `ORDER_PRICE_OVERRIDDEN` (same recipients; info; in-app; sent only when `orders.notifyOnPriceOverride` is on) and `REMITTANCE_OVERDUE` (to `REMITTANCES_MANAGE`; warning; in-app) |
| `AuditActions` | `CARRIER_CONNECTED`, `CARRIER_UPDATED`, `CARRIER_DISCONNECTED`, `SHIPMENT_CREATED`, `SHIPMENT_CANCELLED`, `SHIPMENT_STATUS_SET_MANUALLY`, `PICKUP_REQUESTED`, `PICKUP_MODIFIED`, `PICKUP_CANCELLED`, `ORDER_CONFIRMED`, `ORDER_MESSAGE_SENT`, `ORDER_TEMPLATE_UPDATED`, `RETURN_CREATED`, `RETURN_APPROVED`, `RETURN_RECEIVED`, `RETURN_COMPLETED`, `BULK_LABELS_REQUESTED`, `ORDER_PRICE_OVERRIDDEN`, `ORDER_DISCOUNT_APPLIED`, `ORDER_PRICE_APPROVAL_REQUESTED`, `ORDER_PRICE_APPROVED`, `ORDER_PRICE_REJECTED`, `REMITTANCE_IMPORTED`, `REMITTANCE_CONFIRMED`, `REMITTANCE_VOIDED`, `RETURN_RECEIVED_BY_SCAN`, `CUSTOMER_CAUTION_SET`, `CUSTOMER_CAUTION_CLEARED`, `STORE_PREFERENCES_UPDATED` |
| `ErrorCodes` | `SHIPPING_ORDER_NOT_CONFIRMED`, `SHIPPING_ACTIVE_SHIPMENT_EXISTS`, `SHIPPING_CARRIER_NOT_ACTIVE`, `SHIPPING_CARRIER_CAPABILITY_MISSING`, `SHIPPING_LOCATION_REQUIRED`, `SHIPPING_CARRIER_REJECTED`, `SHIPPING_CARRIER_UNAVAILABLE`, `SHIPPING_OUTCOME_UNKNOWN`, `SHIPPING_INVALID_STATUS_TRANSITION`, `SHIPPING_CANNOT_CANCEL_AFTER_PICKUP`, `PICKUP_CUTOFF_PASSED`, `ORDER_ALREADY_CONFIRMED`, `ORDER_MESSAGE_VARIABLE_UNKNOWN`, `ORDER_STATUS_DRIVEN_BY_SHIPMENT`, `RETURN_INVALID_STATUS_TRANSITION`, `RETURN_QUANTITY_EXCEEDS_DELIVERED`, `RETURN_ORDER_NOT_DELIVERED`, `ORDER_PRICE_OVERRIDE_FORBIDDEN`, `ORDER_PRICE_REASON_REQUIRED`, `ORDER_PRICE_APPROVAL_PENDING`, `ORDER_PRICE_SELF_APPROVAL`, `REMITTANCE_IMPORT_INVALID`, `REMITTANCE_ALREADY_CONFIRMED`, `REMITTANCE_INVALID_STATUS_TRANSITION`, `RECEPTION_SHIPMENT_NOT_FOUND`, `RECEPTION_ALREADY_RECEIVED`, `SHIPPING_FEE_OUT_OF_RANGE`, `SHIPPING_ORIGIN_MISSING` |
| `QueueNames` / `JobNames` | no new queue. On `heavy-processing`: `CREATE_SHIPMENTS` (one batch), `BULK_LABELS_MERGE`, `CANCEL_SHIPMENT`, `POLL_SHIPMENT_STATUS`. On `notifications`: `EVALUATE_PICKUPS`, `SEND_ORDER_MESSAGE`. On `webhooks`: `PROCESS_CARRIER_EVENT` (the inbound carrier webhook, validated, then queued). Also on `notifications`: `CHECK_REMITTANCES` |
| `Schedules` | `EVALUATE_PICKUPS: '* * * * *'` (every minute; the job decides which connections are due, §4.10), `POLL_SHIPMENT_STATUS: '*/10 * * * *'` (the job applies each connection's own interval), `CLEAN_BULK_LABELS: '30 3 * * *'`, `CHECK_REMITTANCES: '0 15 * * *'` (daily) |
| `MetricNames` | `SHIPMENTS_CREATED_TOTAL`, `SHIPMENT_CARRIER_ERRORS_TOTAL` (labels: `carrier`, `code`), `SHIPMENT_UNKNOWN_STATUS_TOTAL`, `PICKUPS_REQUESTED_TOTAL`, `ORDER_MESSAGES_FAILED_TOTAL`; names follow the `platform_*_total` pattern of `TDD_04 §2` |
| `ApiRoutes` | the `carriers`, `shipments`, `pickups`, `orderTemplates`, `returns` groups in §6 and the public `webhooks.carrier`, `remittances`, `returns.reception`, `customers.caution`, `settings.preferences` (§6) |
| `AppPaths` | `store.shipments(storeId)`, `store.returns(storeId)`, `store.settings.carriers(storeId)`, `store.settings.orderTemplates(storeId)`, `store.pickups(storeId)`, `store.remittances(storeId)`, `store.returnsReception(storeId)`, `store.settings.preferences(storeId)` |
| `QueryKeys` | `shipments.all`, `shipments.byOrder`, `carriers.all`, `pickups.all`, `returns.all`, `orderTemplates.all`, `remittances.all`, `returnReception.batch`, `preferences.store` |
| `MediaPurpose` (`TDD_07 §6`) | `SHIPPING_LABEL: 'shipping_label'`, `BULK_LABELS: 'bulk_labels'`, `REMITTANCE_FILE: 'remittance_file'` |
| `EmailTemplates` (`TDD_07 §5`) | add `ORDER_MESSAGE` (the generic order email of §4.7); remove `ORDER_CONFIRMATION`, `SHIPMENT_NOTIFICATION`, `ORDER_DELIVERED`, `ORDER_CANCELLED` (and their `JobNames`-side usages) |
| `PaymentMethod` (`TDD_02 §5`) | `CASH_ON_DELIVERY = 'CASH_ON_DELIVERY'` |
| "Prisma column → enum" table (`TDD_02 §5`) | rows for every `String` column typed with an enum above |
| `DestructiveActionTiers` (`TDD_09 §11.1`) | HIGH: "Cancel an order with an existing shipment" (already listed; now also voids the guide), "Disconnect a carrier with open shipments", "Mark a guide as voided by hand". MODERATE: "Request a pickup after the cutoff". HIGH also: "Void a confirmed remittance" |
| `PluginScopes` (`TDD_10 §6.2`) | `SHIPMENTS_READ: 'shipments:read'` (grants `SHIPPING_VIEW`), `SHIPMENTS_WRITE: 'shipments:write'` (grants `SHIPPING_MANAGE`) |

---

## 4. Rules

### 4.1 The carrier plugin contract

```typescript
// libs/plugins/sdk/src/carrier-plugin.interface.ts
export interface CarrierPlugin {
  readonly id: CarrierIdType                       // 'forza'
  readonly name: string
  readonly version: string
  readonly author: string
  readonly type: 'carrier'
  readonly capabilities: readonly CarrierCapabilityType[]

  serviceCatalog(): readonly CarrierServiceDescriptor[]   // { code, label, defaultForNextDay? } the carrier's own codes

  // Connection lifecycle: credentials are supplied by the core, encrypted at rest by the core
  connect(input: CarrierConnectInput): Promise<CarrierConnectResult>
  disconnect(ctx: CarrierContext): Promise<void>
  healthCheck(ctx: CarrierContext): Promise<CarrierHealth>

  // Shipments. Every call receives the connection context and the core's idempotency key.
  readonly shipmentCreation: 'standalone' | 'pickup_bound' | 'internal'   // how guides come into being, §4.5; 'internal' = the core makes the guide (§4.2)
  readonly maxBatchSize?: number                              // pickup_bound: the most shipments one call accepts
  createShipment?(ctx: CarrierContext, params: CreateShipmentParams): Promise<CreateShipmentResult>   // standalone: CREATE_SHIPMENT
  createShipmentsWithPickup?(ctx: CarrierContext, params: CreatePickupBatchParams): Promise<PickupBatchResult>   // pickup_bound: PICKUP_BOUND_GUIDES; one call, an array of shipments
  fetchPickup?(ctx: CarrierContext, ref: PickupRef): Promise<PickupDetails>                           // pickup_bound: recovers the guides of a pickup after an unknown outcome
  cancelShipment?(ctx: CarrierContext, params: CancelShipmentParams): Promise<CancelShipmentResult>   // CANCEL_SHIPMENT
  fetchLabel?(ctx: CarrierContext, params: FetchLabelParams): Promise<CarrierLabel>                   // when createShipment does not return one
  fetchStatus?(ctx: CarrierContext, refs: ShipmentRef[]): Promise<CarrierEvent[]>                     // FETCH_STATUS, batched
  lookupLocations?(ctx: CarrierContext, query: LocationQuery): Promise<CarrierLocation[]>             // REQUIRES_LOCATION_IDS

  // Pickups
  requestPickup?(ctx: CarrierContext, params: PickupParams): Promise<PickupResult>                    // PICKUP_REQUEST
  modifyPickup?(ctx: CarrierContext, params: ModifyPickupParams): Promise<PickupResult>               // PICKUP_MODIFY
  cancelPickup?(ctx: CarrierContext, params: CancelPickupParams): Promise<void>                       // PICKUP_CANCEL

  // Inbound status (WEBHOOK_STATUS). Pure: normalizes, never fetches.
  validateWebhookSignature?(rawBody: string, headers: Record<string, string>, secret: string): boolean
  handleWebhook?(payload: unknown): Promise<CarrierEvent[]>
}
```

- **Two creation modes, declared by the plugin.** A *standalone* carrier creates one guide per call
  (`createShipment`). A *pickup-bound* carrier (the owner reports C807 Express works this way) creates guides
  only inside a pickup: one call carries the pickup (date, window, package count) and an **array** of
  shipments and answers with the pickup and the **guide of every shipment**
  (`createShipmentsWithPickup`). A third, *internal* mode belongs to the `local` carrier, whose guide
  and label the core generates itself (§4.2): it implements neither method. A plugin declares exactly one mode and
  implements the matching method (or none for `internal`); the registry fails fast otherwise. The core hides the
  difference from the user (§4.5).
- **`CreateShipmentParams`** carries everything the core already knows and nothing the plugin must
  look up: the reference (order number), `idempotencyKey`, the sender (warehouse name, address,
  phone), the recipient (name, phone, address and, when the plugin declares
  `REQUIRES_LOCATION_IDS`, the carrier's location ids), the packages (count, weight, dimensions
  when set), `serviceCode`, `shippingPayer`, `cod: { amountCents, currency } | null` and the
  `labelFormat` wanted. It never carries credentials; those are in the `CarrierContext`.
- **`CarrierEvent`** is `{ providerEventId?, status: ShipmentStatus | null, rawStatus, description?, occurredAt, guideNumber | providerShipmentId }`.
  The plugin maps its own status codes to `ShipmentStatus`; a status it cannot map comes back
  with `status: null` and is stored but changes nothing (§4.9).
- **Carriers have their own registry.** `PluginRegistry` of `TDD_10 §3` is typed to `ChannelPlugin` and `ChannelType`, so a
  sibling `CarrierRegistry` (same module, same fail-fast `validateContract` idea, keyed by `CarrierId`) holds the carrier
  plugins and `PluginsModule` registers both.
- **A plugin that declares a capability must implement the matching method**, and the registry
  fails fast at boot otherwise (`TDD_10 §3`). The same rule keeps the UI honest: a button exists
  only when the connection's plugin has the capability behind it (§7).
- **Errors are typed:** `CarrierRejectedError` (the carrier refused: bad address, unknown
  service; safe to show the message), `CarrierUnavailableError` (network, 5xx, timeout before a
  response: the outcome is *unknown*), `CarrierAuthError` (credentials rejected: the connection
  goes to `ERROR`). The core never inspects provider-specific error text.
- **Contract tests** (`tests/contracts/carrier-plugin.contract.ts`, like `TDD_10 §9`) run each
  plugin against recorded provider fixtures and check: capability-to-method consistency,
  `handleWebhook` purity, status mapping tables, the idempotent-create behaviour a plugin claims,
  and that no credential appears in any returned value or log line.
- **Third-party carriers** are integration plugins (`TDD_10 §6`, `Plugin.type = 'integration'`), not `CarrierPlugin`s. Their
  route in is `POST /api/v1/plugin-api/shipments` (create a shipment record for a guide they
  made elsewhere, with the label PDF) and `POST /api/v1/plugin-api/shipments/:id/events` (status
  updates); both go through the same `ShippingService`, so the lifecycle, messages and pickups
  work unchanged. A plugin key bound to store A cannot touch a shipment of store B.

### 4.2 The `local` carrier (independent couriers, our own guide)

Some couriers are individuals or small businesses: they provide no guide, no API and no webhooks.
The owner only needs to attach *our* guide to them. This is a `CarrierConnection` with
`carrierId = 'local'`: a name, a phone, optional notes, a guide prefix.

- Capabilities: `INTERNAL_GUIDE`, `COD`, and nothing else. No pickup API, no cancel API, no status
  push or poll.
- **The guide number** is `{prefix}-{sequence}` (for example `JM-000123`), unique per connection
  (`GuideSequence`, `shipments_guide_per_connection`). It is taken in the same transaction that
  inserts the `Shipment`, so a rollback leaves a gap, never a duplicate; gaps are acceptable.
- **The label** is rendered by the platform with `@react-pdf/renderer` (the renderer of
  `TDD_09 §5.4`) at the connection's `labelFormat`: guide number as a Code 128 barcode and as
  text, order number, sender (warehouse), recipient name, phone and full address, package count,
  the **amount to collect in large type for COD orders** or "PAID" for prepaid ones, the service
  label and the customer notes. The result is stored as `Media` (`SHIPPING_LABEL`) and treated
  exactly like a carrier label from then on, so printing, bulk merge and reprint are one code path.
- **Status is set by hand** (`PICKED_UP`, `OUT_FOR_DELIVERY`, `DELIVERED`, `FAILED_ATTEMPT`,
  `RETURNED`), one button per valid transition, through the same shipment state machine
  (`ShipmentEventSource.MANUAL`, audited). Everything downstream (order status, customer messages)
  reacts to a manual event the same way as to a webhook.
- **Cancelling** is immediate and free: the shipment goes through `CANCEL_PENDING` to `CANCELLED` in the same
  transaction, with `GuideRefundStatus.NOT_APPLICABLE`.
- **Pickups** are `MANUAL_REQUIRED` by definition: the owner gets the list of waiting shipments
  and arranges the pickup with the courier outside the platform (§4.10).

### 4.3 Order lifecycle with confirmation

`PENDING_CONFIRMATION → CONFIRMED → PREPARING → SHIPPED → DELIVERED`, plus `CANCELLED` and `RETURNED`.

- **Creating an order** (`TDD_09 §5.1`) now leaves it in `PENDING_CONFIRMATION`. Stock is reserved
  at creation, as in `TDD_16 §4.1` (the agent promised the goods), so the table there reads
  "created (`PENDING_CONFIRMATION`)" and "items edited while `PENDING_CONFIRMATION` or
  `CONFIRMED`".
- **The summary** (§4.7, kind `ORDER_SUMMARY`) is sent to the customer by the agent, or at creation when the
  "Send the order summary" checkbox is checked, whose initial state is the preference
  `orders.sendSummaryOnCreate` (§4.14). The checkbox of `TDD_09 §5.1` ("send the confirmation message") becomes that one.
- **Confirming** is an agent action (`ORDERS_CONFIRM`): "Mark as confirmed" asks how the customer
  confirmed (`OrderConfirmationChannel`) and stores `confirmedAt`, `confirmedBy`, `confirmedVia`.
  The platform does **not** read the customer's reply to decide; detecting a confirmation
  automatically is an AI feature and is out of scope. A bulk "Mark as confirmed" exists for the
  orders list.
- **Confirm at creation:** the create-order drawer has a **"Mark as confirmed" checkbox**, initialised
  from `orders.confirmOnCreate` (unchecked by default, §4.14) and shown only to members with `ORDERS_CONFIRM`. Checked, the order is created
  directly in `CONFIRMED` with `confirmedVia = AT_CREATION`; the server rejects the flag from a
  caller without the permission. `createOrderSchema` gains `confirmOnCreate: z.boolean().default(false)`.
  Stock is reserved the same way in both cases. An order whose price approval is pending (§4.13) is
  never confirmed, with or without the checkbox.
- **Copy an order:** "Copy order" on the order detail and on the customer's order list opens the
  create-order drawer **prefilled** from an earlier order (customer, items and variants, quantities,
  address, payment method, shipping fee, notes), so a customer who liked the product and wants
  another only changes what differs. `GET /orders/:id/copy` returns a `createOrderSchema`-shaped
  draft and writes nothing; the agent edits it and submits it through the normal create path, so
  every rule applies again. Prices are **never** copied: the server reads the current catalog
  prices, and the draft carries warnings for lines whose product is inactive, out of stock or
  whose price changed. The new order records `copiedFromOrderId` and starts in
  `PENDING_CONFIRMATION` unless the checkbox above is checked.
- **Only a confirmed order can get a guide.** `ShippingService.createShipments` refuses any order
  whose status is not `CONFIRMED` or `PREPARING` (`SHIPPING_ORDER_NOT_CONFIRMED`); the UI hides
  the action and the bulk selection reports skipped orders with the reason.
- **Editing after the summary was sent:** items, shipping, discount, address and payment method
  remain editable in `PENDING_CONFIRMATION` and `CONFIRMED` (`OrderEditableFields`). Once a guide
  exists, editing the **address, items or payment method** of the order shows a warning that the
  guide no longer matches, and offers "cancel the guide and create a new one" (§4.8); it never
  edits a guide silently.
- **`PREPARING`** is the warehouse step ("packing"): set by hand, optional. A guide can be created
  from `CONFIRMED` directly.
- **`SHIPPED` and `DELIVERED` are driven by the shipment** (§4.9) with the actor
  `{ type: 'system', id: 'carrier:{connectionId}' }`; an agent can still set them by hand where **no active
  shipment exists** (an order delivered personally). With an active shipment a manual change to either is refused
  (`ORDER_STATUS_DRIVEN_BY_SHIPMENT`), so the order never contradicts its shipment.
- **One way to confirm.** `OrdersService.updateStatus(..., CONFIRMED)` is the confirm action itself: whichever route
  calls it (the confirm endpoint, the "Change status" menu, the plugin API) it requires `ORDERS_CONFIRM` and the
  price-approval check of §4.13. The generic permission `ORDERS_CHANGE_STATUS` does not allow confirming, and the
  "Change status" menu shows `CONFIRMED` (as "Confirm") only to members holding `ORDERS_CONFIRM`.
- **Orders created through the plugin API** follow the same rules: they start in `PENDING_CONFIRMATION`, and the price
  rules apply according to the permissions their scopes grant (`orders:write` grants neither `ORDERS_CONFIRM` nor
  `ORDERS_OVERRIDE_PRICE`, so such an order is confirmed by a person and its discount is limited like an agent's).

### 4.4 Cash on delivery and prepaid

- A shipment's `codAmountCents` is **derived**, not entered: if `Order.paymentMethod` is
  `CASH_ON_DELIVERY` and `paymentStatus` is not `COMPLETED`, the order's `totalCents` is collected; otherwise
  `null` (prepaid: nothing is collected from the recipient). When the order has **one** active outbound shipment it
  carries the whole total. When split fulfillment gives it **several**, the total is divided so the amounts add up to it
  exactly and the customer pays once per package: each shipment carries the value of its own lines less its
  proportional share of the discount, the shipping fee goes on the first shipment created, and the last one absorbs any
  rounding. A shipment cancelled and re-created keeps its share. A carrier without the `COD`
  capability cannot ship a COD order (`SHIPPING_CARRIER_CAPABILITY_MISSING`).
- `Shipment.shippingPayer` is chosen once per connection (`defaultShippingPayer`) and can be
  overridden per shipment in the create dialog; bulk creation uses the connection default, except for a free-shipping
  order (§4.13), which always uses `SENDER`.
  **Who pays shipping is independent of whether the order is COD**: a gift can be prepaid with the
  *sender* paying, a COD order can have the *recipient* pay the carrier's fee.
- When a COD shipment reaches `DELIVERED`, the order's `paymentStatus` becomes `COMPLETED`
  (`ORDER_PAYMENT_STATUS_CHANGED`, actor `system`). The money is held by the carrier until it
  remits; §4.15 reconciles what it remits against what was delivered.

### 4.5 Creating shipments (single, bulk and pickup-bound)

`ShippingService.createShipments(storeId, requests[])` is the only entry point (a single guide is a batch of
one; bulk generation and the `shipments:write` plugin scope call it too). Steps 1 to 7 describe one
shipment of a **standalone** carrier; the pickup-bound variant follows them:

1. **Validate:** order status (§4.3); the connection is `ACTIVE` and its plugin declares
   `CREATE_SHIPMENT` (standalone) or `PICKUP_BOUND_GUIDES` (or is the `local` carrier); the order has a shipping address; when the plugin declares
   `REQUIRES_LOCATION_IDS` the address carries the carrier's location ids
   (`SHIPPING_LOCATION_REQUIRED` otherwise, and the dialog shows the department, municipality and
   settlement selectors fed by `lookupLocations`, cached in Redis per connection); COD capability
   (§4.4); the price approval is not `PENDING` or `REJECTED` and the connection's fee range accepts the order's fee (§4.13); no active outbound shipment exists for the same `(orderId, originWarehouseId)`
   (`SHIPPING_ACTIVE_SHIPMENT_EXISTS`, backed by the partial unique index). The **origin** is the warehouse of the order's allocation
   for that shipment; an order with no allocations (no tracked items) uses the store's first warehouse by priority; with none, or
   with a warehouse that has no address, the request is refused (`SHIPPING_ORIGIN_MISSING`).
2. **Write first, call second.** In one transaction insert the `Shipment` with status `CREATING`,
   a deterministic `idempotencyKey` (`shipment:{orderId}:{originWarehouseId}:{attempt}`), the
   service, payer and COD amount. A crash after this point leaves a visible row, never an
   invisible guide.
3. **Call the plugin** with the idempotency key. A guide may cost money (a carrier charges per
   guide), so nothing here retries blindly.
4. **On success:** store `guideNumber`, `providerShipmentId`, `trackingUrl`, the cost when
   reported, the label as `Media` (`SHIPPING_LABEL`, scanned like any file, `TDD_07 §6`), set
   `LABEL_CREATED`, copy the guide to `Order.trackingNumber` when it is the order's only
   shipment, emit `SHIPMENT_CREATED`.
5. **`CarrierRejectedError`:** `FAILED` with the carrier's message in `lastError`; the order is
   untouched; the agent corrects the address or service and creates again (a new attempt number).
6. **`CarrierUnavailableError` or a timeout** (the outcome is **unknown**): if the plugin declares
   `IDEMPOTENT_CREATE`, the job may retry with the same key (up to 3 times, exponential
   backoff). Otherwise the shipment goes to `REQUIRES_REVIEW`, a `SHIPMENT_REQUIRES_REVIEW`
   notification is sent, and nothing is retried automatically. The agent resolves it with two
   actions: **"Check with the carrier"** (`fetchStatus` by reference, offered only when the plugin has `FETCH_STATUS`;
   otherwise the agent verifies with the carrier outside the platform; it finds a guide that was
   created, then moves to `LABEL_CREATED`) or **"Mark as failed and retry"** (a new attempt).
   Creating a second guide for a possibly-created one is the failure to avoid.
7. **Same-order concurrency:** the transaction of step 2 takes `pg_advisory_xact_lock` on the order
   id, so two agents clicking at once end with one shipment and one `SHIPPING_ACTIVE_SHIPMENT_EXISTS`.

**Pickup-bound carriers (guides only inside a pickup).** The same validation (step 1) runs per order, then the
requests of one connection are grouped into batches of at most `maxBatchSize`:

- **The pickup is chosen with the guides.** The create dialog (and the bulk action) shows the **pickup date
  and window**, defaulting to the connection's next valid pickup day (a day in `pickupDays` whose cutoff has
  not passed, otherwise the next one) and editable. A date after the cutoff is refused
  (`PICKUP_CUTOFF_PASSED`) unless the agent confirms the MODERATE-tier dialog.
- **Write first, call once.** In one transaction every shipment of the batch is inserted as `CREATING`
  (each with its own idempotency key) together with a `PickupRequest` in `PENDING` carrying the batch's
  `packageCount`; then **one** `createShipmentsWithPickup` call is made.
- **The result is per shipment.** A shipment with a guide gets its label and `LABEL_CREATED` and is attached to the
  pickup at once (`pickupId`); one the carrier refused becomes `FAILED` with its message while the others
  succeed; the pickup becomes `REQUESTED` with its `providerPickupId`, its `packageCount` set to the number
  of guides actually made; if the carrier refused every shipment, the pickup is `FAILED`. Partial success is normal.
- **Unknown outcome:** if the call times out, **every** shipment of the batch and the pickup go to
  `REQUIRES_REVIEW` (`PickupStatus.REQUIRES_REVIEW` for the pickup) and nothing is retried unless the plugin declares `IDEMPOTENT_CREATE`. "Check with the
  carrier" calls `fetchPickup` to find the guides that were created and completes the matching shipments.
- **Adding orders to a pickup that already exists.** With `PICKUP_MODIFY` the new shipments join the open pickup
  of that date (the same call shape adds them and returns their guides). Without it, a new pickup is created
  for them, which a pickup-bound carrier allows on the same day.
- **Cancelling** a guide removes the shipment from its pickup (`cancelShipment` when the plugin has it,
  otherwise `modifyPickup`, otherwise the agent handles it with the carrier as in §4.8); an emptied pickup is cancelled.
- **A single guide** is a one-package batch: it creates a one-package pickup, or joins the open one when it can.

The `ORDER_SHIPPED` domain event (`TDD_02 §3`) keeps meaning "the carrier has the package": it is
emitted when the shipment reaches `PICKED_UP`, or by the manual status of a `local` shipment, not when
the label is created (§4.9).

### 4.6 Labels, printing and bulk generation

- **One label per shipment, stored once.** Reprinting never calls the carrier again:
  `GET /shipments/:id/label` serves the stored file through a short-lived signed URL
  (`TDD_07 §6`).
- **Formats:** the connection's `labelFormat` is `PDF_100X150` (the usual 4×6 inch thermal roll,
  the default), `PDF_A6` or `PDF_A4`. The MVP handles **PDF only**: a plugin must return a PDF
  (or an image the core wraps into a PDF page at the requested size). Native ZPL for a thermal
  printer is out of scope (§12); a PDF prints on a thermal printer through the printer driver.
  The format is a setting, so another size is a configuration change, not code.
- **Bulk generation** (orders list → select → "Generate labels"):
  1. `POST /shipments/bulk` with `orderIds` (max 100) creates a `BulkLabelJob` and enqueues
     `BULK_LABELS_MERGE`. Orders that are not `CONFIRMED` or `PREPARING`, already have an active
     shipment, or have neither a planned carrier nor a store default carrier are **skipped and reported with the reason**, not
     failed silently.
  2. The job creates the missing shipments with `ShippingService.createShipments` (§4.5). For a
     **standalone** carrier, at most `N` in parallel per connection (a constant per plugin, default 3) so the
     carrier's rate limit is respected. For a **pickup-bound** carrier, one call per batch of at most
     `maxBatchSize` orders returns all their guides, and the bulk dialog asks for the pickup date and window.
     An order that already has a shipment reuses its stored label.
  3. Progress is published as `BULK_LABELS_PROGRESS` over the realtime gateway; the orders list
     shows a progress bar and per-order outcomes as they land.
  4. When every shipment is settled the job merges the stored label PDFs, **in the order the agent
     selected the orders**, into one PDF with `pdf-lib`, stores it as `Media` (`BULK_LABELS`,
     deleted after `StoreSettings.bulkLabelRetentionDays` by `CLEAN_BULK_LABELS`) and sends
     `BULK_LABELS_READY`. A mixed-size selection is merged as is, and the UI warns that the page
     sizes differ.
  5. Partial failure is normal: the job ends `COMPLETED_WITH_ERRORS`, the PDF contains the
     successes, and the failed orders stay selectable for a retry.
- **"Print labels" on orders that already have a shipment** merges the stored files without any
  carrier call (`POST /shipments/labels/merge`, up to 100 shipments).
- **Cancelled or voided labels are never merged** (the merge skips them and reports it).

### 4.7 Customer messages with templates

- **Kinds and defaults** (`OrderMessageKind`): the shipment-progress messages and `ORDER_CANCELLED`
  are **automatic** by default, a per-template setting (`autoSend`) editable in Settings → Order
  messages. The **order summary** is not a template setting: whether it is sent when an order is
  created is the preference `orders.sendSummaryOnCreate` (§4.14, **on** by default), which pre-checks
  the "Send the order summary" checkbox of the create-order drawer; `autoSend` is refused by the
  Zod schema for `ORDER_SUMMARY`, so there is one source. An agent can also send or resend the summary by hand at any time.
- **Variables are an allowlist** (`OrderMessageVariables`). A template is plain text with
  `{{variable}}` placeholders; saving a template with an unknown variable is refused
  (`ORDER_MESSAGE_VARIABLE_UNKNOWN`). Rendering is string substitution, never code evaluation.
  `itemsList` renders one line per item (`2 × Name (variant) — $10.00`), `total` and `codAmount`
  are formatted in the order currency and the customer's locale, `shippingAddress` is the
  formatted address. The template body is the store locale's; when the customer's locale has no
  template the store default locale is used.
- **The order summary can carry an attachment:** with `attachSummary` on and a channel that
  declares `DOCUMENT`, the summary PDF (the `ORDER_SUMMARY` document of `TDD_09 §5.4`, now an
  `OrderPrintDocuments` value) is sent along. The text message always goes, so a channel without
  documents loses only the attachment.
- **Sending goes through the conversation's channel** (`Order.conversationId`; without one, the
  customer's most recent open conversation, otherwise email) as an outbound `Message`, so it
  shows in the thread. Whether it goes as **free text or as an approved template** is decided by
  what the channel plugin **declares**, never by the plugin's name: the `messagingWindow` policy
  and the `TEMPLATES` capability of `ChannelPlugin` (`TDD_10 §2`), applied by the core before
  sending (`TDD_10 §4`). Three cases follow from the declaration:
  - **No window** (`messagingWindow: null`: email, the web widget, or a future unofficial
    WhatsApp bridge such as one built on `whatsapp-web.js`): the rendered free text is always
    sent, a linked template is ignored and the template link is not even offered in the editor for
    that channel. Adding such a plugin needs no change here.
  - **Inside the window** (WhatsApp Cloud API: within 24 hours of the customer's last message): the
    rendered free text is sent.
  - **Outside the window:** a free-text message is not allowed by the channel. If the template has
    a `channelTemplate` (a template the owner already created and got **approved by the
    channel**, for example by Meta; the platform lists them through `listTemplates`, `TDD_10 §5.1`), the core sends that
    approved template, filling its numbered placeholders from `channelTemplate.variables` in
    order. The template's text itself is Meta's, fixed at approval; only the variables vary.
  - **Outside the window and no approved template linked:** the message is **not sent on that
    channel**. When the customer has an email, the rendered text goes by email; otherwise
    `ORDER_MESSAGE_NOT_SENT` notifies the agents and the order timeline shows "not sent, reason",
    with a manual "send" button that opens the template picker. A message is never dropped silently.
- **Manual status changes** (`TDD_09 §5.3`: marking an order delivered or cancelled, or shipped by hand) keep their
  "Notify customer" checkbox, but its initial state is not hardcoded: it is the `autoSend` of the matching template
  (`ORDER_SHIPPED`, `ORDER_DELIVERED`, `ORDER_CANCELLED`), and a checked box sends that template through the rules above.
- **Email fallback.** The email that carries the fallback is one generic `ORDER_MESSAGE` email template wrapping the
  rendered text; it replaces the four order emails of `TDD_07 §5.3` (`ORDER_CONFIRMATION`, `SHIPMENT_NOTIFICATION`,
  `ORDER_DELIVERED`, `ORDER_CANCELLED`) and the unconditional enqueue in the order listener of `TDD_01 §6`.
- **Automatic messages are idempotent:** one per `(shipmentId, status, kind)` (an
  `idempotencyKey` on the message; a manual status change uses `(orderId, kind, status)`), so a repeated webhook sends nothing twice; a status the
  customer already received is never re-sent when events arrive out of order.
- **Settings → Order messages** edits the templates with a variable picker, a live preview using a
  sample order, the `autoSend` and `attachSummary` switches, and the link to a channel-approved
  template (for WhatsApp: name, language, and which variable fills each placeholder).

### 4.8 Cancellation, voiding the guide and the refund of the guide

Cancelling an order whose status allows it (`ORDERS_CANCEL`, the confirmation of `TDD_09 §5.3`,
HIGH-tier when a shipment exists):

| Shipment state when the order is cancelled | What happens |
|---|---|
| none | cancel the order; `RELEASE` the allocations (`TDD_16 §4.1`) |
| `CREATING`, `REQUIRES_REVIEW` | refused until it is resolved (`SHIPPING_OUTCOME_UNKNOWN`): a guide may exist |
| `LABEL_CREATED` | cancel the order at once and release stock; the shipment goes `CANCEL_PENDING` and the job `CANCEL_SHIPMENT` voids the guide (below) |
| `CANCEL_PENDING`, `CANCEL_FAILED` | the guide is already being voided: cancelling the order does not start a second void |
| `PICKED_UP` or later | the order **cannot be cancelled** (`SHIPPING_CANNOT_CANCEL_AFTER_PICKUP`); the dialog offers "Create a return" (§4.11) |
| `FAILED`, `CANCELLED` | ignored; no active shipment |

- **Voiding.** If the plugin has `CANCEL_SHIPMENT`, the job calls it. Success → `CANCELLED` with
  `refundStatus` `PENDING` or `CONFIRMED` as the carrier reports (the refund of an unused guide is the
  carrier's process; the platform only records what the carrier says). No capability →
  `CANCELLED` is **not** set automatically: the shipment stays `CANCEL_PENDING`,
  `refundStatus = NOT_SUPPORTED`, and `SHIPMENT_CANCEL_FAILED` tells the agent to cancel it with the
  carrier; the agent then presses "Mark as voided" (HIGH-tier confirmation, audited), which
  sets `CANCELLED`.
- **Failures:** `CarrierUnavailableError` retries 5 times with exponential backoff, then
  `CANCEL_FAILED` and a notification; the order stays `CANCELLED` and the stock released. The
  agent can retry or mark it voided. A voided label is excluded from printing and bulk merges.
- **The shipment leaves its pickup:** when the shipment belonged to a pickup, the package count
  of that pickup is reduced through `modifyPickup` (§4.10) when the carrier allows it, otherwise
  the pickup gets a note and the agent is told.
- **Editing the order after a guide exists** (address, items, payment method) uses the same
  cancel-and-recreate path (§4.3), so the old guide is voided and a new one is made; the order
  does not need to be cancelled for that.
- **Customer message:** `ORDER_CANCELLED` per template (§4.7).

### 4.9 Status flow from the carrier

- **Inbound webhooks** hit one public route, `POST /api/v1/webhooks/carriers/:connectionId`
  (`ApiRoutes.webhooks.carrier`, a public endpoint like the channel webhooks, `CLAUDE.md` rule 5).
  The controller reads the raw body, loads the connection (without a tenant context, §4.12),
  validates the signature with the connection's `webhookSecret`, enqueues `PROCESS_CARRIER_EVENT`
  and answers `200` fast. A bad signature is `401`, never queued.
- **Dedupe:** an event is applied once per `(shipmentId, providerEventId)` (the partial unique
  index); a provider that sends no event id is deduped on `(shipmentId, status, occurredAt)`.
- **Order of arrival does not matter.** An event is applied only if the transition table allows
  it from the shipment's current status; an older event that would move backwards is stored in
  `ShipmentEvent` (history) but does not change the status. `FAILED_ATTEMPT → OUT_FOR_DELIVERY`
  (a retry) is a valid forward step in the table.
- **Polling:** for connections whose plugin has `FETCH_STATUS` but no webhook (or whose webhook
  was not configured), `POLL_SHIPMENT_STATUS` calls `fetchStatus` in batches for shipments in an
  active state, each connection at its `pollIntervalMinutes` (the plugin's default when null,
  never below 5). Shipments older than 14 days are polled once a day. Polling stops when a
  shipment reaches a terminal state. A connection with webhooks is polled too, at a low
  frequency, as a safety net.
- **What a status does** (listener on `SHIPMENT_STATUS_CHANGED`, never inside the webhook
  controller):

| Shipment becomes | Order effect (actor `system`) | Customer message kind |
|---|---|---|
| `PICKED_UP` (or the first `IN_TRANSIT`) | `SHIPPED` (`ISSUE` per allocation, `TDD_16 §4.1`; `shippedAt`; `ORDER_SHIPPED`) | `ORDER_SHIPPED` |
| `OUT_FOR_DELIVERY` | none | `ORDER_OUT_FOR_DELIVERY` |
| `FAILED_ATTEMPT` | none; notification `SHIPMENT_FAILED_ATTEMPT` | `ORDER_FAILED_ATTEMPT` |
| `DELIVERED` | `DELIVERED` (`deliveredAt`); a COD order's payment becomes `COMPLETED` (§4.4) | `ORDER_DELIVERED` |
| `RETURNING` / `RETURNED` | none; notification to decide a return (reason `DELIVERY_FAILED`, §4.11) | none |
| `CANCELLED` | none (the order was already cancelled, §4.8) | none |

- **An unmapped provider status** is stored (`status: null`, `rawStatus`), increments
  `SHIPMENT_UNKNOWN_STATUS_TOTAL` and changes nothing; the owner sees it in the history.
- **An event for a cancelled order** (a package that left although the guide was voided) raises
  `SHIPMENT_REQUIRES_REVIEW` instead of moving the order.
- **Manual events** (`local` carrier, or an agent correcting a status) use the same table and
  produce the same effects.

### 4.10 Pickups (recolecta)

Per connection: `pickupEnabled`, `pickupDays`, `pickupCutoffTime`, `autoPickup` with
`autoPickupTime`, `pickupReminderMinutes`; all times are in the store timezone.

- **Eligible shipments:** `LABEL_CREATED` with no `pickupId`, on connections with `pickupEnabled`
  (standalone carriers; a pickup-bound carrier's shipments already belong to a pickup).
- **Two kinds of pickup.** With a **standalone** carrier the pickup is requested separately, after the
  guides exist, and there is **at most one open pickup per connection per day**: a manual request and the
  scheduler both go through `ShippingService.ensurePickup`, which takes `pg_advisory_xact_lock(connection)` so
  they cannot create two (a service rule covered by a test, not a database index). With a **pickup-bound**
  carrier the pickup is created together with the guides (§4.5), several per day are allowed, and the
  rules below about joining an existing pickup apply to later additions.
- **Package count.** The pickup states how many packages to collect: the sum of the
  `packageCount` of its shipments, recalculated whenever a shipment joins or leaves.
- **Joining an existing pickup.** If a pickup for today exists and the plugin declares
  `PICKUP_MODIFY`, new eligible shipments are added and the pickup is modified (`revision + 1`, the new
  count sent). Without `PICKUP_MODIFY` the existing pickup is left alone and the new shipments
  wait for the next pickup day (the agent sees that, with the reason). A modification is
  refused after the cutoff (`PICKUP_CUTOFF_PASSED`) unless the agent confirms the MODERATE-tier
  dialog.
- **Without a pickup API** (`local`, or a carrier without `PICKUP_REQUEST`) the pickup is
  `MANUAL_REQUIRED`: a record with the waiting shipments, a `PICKUP_MANUAL_REQUIRED` notification
  and a printable list (guide, recipient, packages). The agent presses "Mark as confirmed" when
  the courier agreed.
- **`autoPickup` for a pickup-bound carrier** cannot request an empty pickup in advance: at `autoPickupTime` it
  **generates the guides and the pickup together** for every `CONFIRMED` or `PREPARING` order planned for
  that connection that has no guide yet. That spends money without a click, so it stays off by default and
  its switch says so; it follows the same validation and the same price-approval rule as a manual run.
- **The scheduler:** `EVALUATE_PICKUPS` runs every minute (one job, not one cron per connection:
  schedules cannot be created per tenant row). For each connection with `autoPickup` it checks:
  today is a pickup day, `now >= autoPickupTime`, `now < pickupCutoffTime`, and eligible shipments
  exist; then it calls `ensurePickup`. The reminder: `pickupReminderMinutes` before the cutoff, if
  eligible shipments remain without a pickup (or a pickup that cannot take them), it raises
  `PICKUP_CUTOFF_APPROACHING` once. After the cutoff the eligible shipments roll to the next
  pickup day.
- **A cancelled shipment** leaves its pickup and the count drops (§4.8); an emptied pickup is
  cancelled (`cancelPickup` when available).
- **A failed request** (`CarrierUnavailableError`) retries with backoff, then `FAILED` and a
  notification; the shipments stay eligible, and the agent can request again.

### 4.11 Returns and exchanges

`OrderReturn` records a product coming back, because it failed, was wrong, or the carrier could not
deliver it. Two types: **exchange** (the customer gets a replacement) and **refund**.

- **When:** the order is `DELIVERED` (`RETURN_ORDER_NOT_DELIVERED` otherwise), or `SHIPPED` with a
  shipment in `RETURNING`/`RETURNED`. Lines reference `OrderItem`s; the quantity of an item
  cannot exceed what was delivered minus what is already in non-rejected returns
  (`RETURN_QUANTITY_EXCEEDS_DELIVERED`).
- **Flow:** `REQUESTED` (an agent records the customer's request, `RETURNS_MANAGE`) → `APPROVED`
  (after the agent checks reason, evidence and photos, which are `Media` of purpose `ORDER`) →
  `IN_TRANSIT` (the goods are on their way) → `RECEIVED` (a person inspects them and marks each
  line's `condition`) → `COMPLETED`. `REJECTED` ends it at the first step.
- **The return leg.** If the connection's plugin declares `RETURN_SHIPMENT`, the agent can create
  a return guide (customer → warehouse, `kind = RETURN`, `returnId`); otherwise the courier,
  the customer or the owner brings the goods back outside the platform and the agent moves the
  return to `IN_TRANSIT` and `RECEIVED` by hand. The return leg obeys the same shipment rules
  (labels, pickups, cancellation).
- **Who pays the return and the replacement shipping:** `OrderReturn.shippingPayer`, defaulting to
  `StoreSettings.returnShippingPayer`, chosen in the create dialog only when the agent needs to
  override it. The outbound guide of an exchange uses the payer of the same return.
- **Exchange:** approving it creates a **replacement order** (`exchangeOfOrderId`), already
  `CONFIRMED` (the customer's confirmation is the approval), with the items the agent picks.
  Its total is the price difference: the returned items' value is applied as a **system credit** (`discountCents`
  written by `ReturnsService`, annotated with the return id, exempt from the store's discount limit and from
  approval, audited), so the total is `max(0, replacement value - credit)`, `0` by default. If the replacement costs
  more, the difference is charged as usual (COD or prepaid, and a total of `0` means no COD amount); if it costs
  less, the excess is a refund the owner settles by hand. The replacement reserves stock like any order (`TDD_16 §4.1`)
  and ships through the normal path (a guide, a pickup, the same messages; `EXCHANGE_SHIPPED`).
  There is no coupling between the two legs: the agent chooses when to ship the replacement,
  before or after the defective item is back.
- **Inventory on receipt**, per line, in one transaction through `InventoryService`, every movement carrying the idempotency key
  `return:{returnId}:{orderItemId}:{movement}` so a retry applies once (`TDD_16 §4.2`):
  - `RESELLABLE`: `RETURN_IN` into `restockWarehouseId` (the original allocation's warehouse by default).
  - `DEFECTIVE` or `DAMAGED`: `RETURN_IN` immediately followed by `ADJUSTMENT_OUT` with reason
    `DAMAGED`, so the append-only ledger (`TDD_16 §4.2`) shows the item came back and was discarded,
    and net stock does not change.
- **Order status:** the order becomes `RETURNED` when received returns cover **every unit** of
  every item; a partial return leaves it `DELIVERED` and shows the returned quantity per item.
  `RETURNED` through the return flow replaces the free "restock" checkbox of `TDD_16 §4.1`,
  which remains only for an agent who sets `RETURNED` by hand without creating an `OrderReturn`. A package the
  carrier brought back should go through a return with reason `DELIVERY_FAILED`, most simply by scanning it (§4.16).
- **Refunds of money are manual.** The platform does not process payments in the MVP: on
  `COMPLETED` of a `REFUND` return the agent records the refunded amount (`refundAmountCents`)
  and the order's `paymentStatus` becomes `REFUNDED` when it equals the paid total.
- **Messages:** `RETURN_APPROVED` and `EXCHANGE_SHIPPED` (§4.7).

### 4.12 Security, isolation and data

- **Tenant isolation:** every table here has `store_id`; the new tables get RLS policies in
  Step 7.1 like every other store-scoped table. The public carrier webhook cannot know the store
  before it finds the connection, so resolving `:connectionId` to its store uses a small
  `SECURITY DEFINER` function that returns the store id and secret handle only (Step 7.1), and the queued job then runs with `TenantContext.run`.
- **Credentials and secrets** are encrypted with the same key and routine as channel credentials
  (`libs/core/crypto`, `TDD_05 §1`); they are never returned by any API after setup (the
  connection response carries `hasCredentials: boolean`), never logged, and rotate with
  `scripts/rotate-credentials-key.ts`.
- **Outbound requests** to carrier hosts go through the SSRF-safe HTTP client; a label or document
  URL returned by a carrier is fetched only after `assertPublicHttpsUrl` (`TDD_07 §2`), with a size
  limit and a content-type check (PDF or image), then stored through the media pipeline.
- **Personal data:** recipient names, phones and addresses are redacted from logs, from
  `ShipmentEvent.payload` (the stored provider payload keeps only the status fields) and from
  metrics labels. Retention follows the order's (`TDD_05 §10`): a shipment of an anonymized
  customer keeps its guide and status but loses its address snapshot.
- **Idempotency and money:** creating a guide can cost money, so §4.5 never retries an unknown
  outcome without the idempotency capability, and every cost the carrier reports is stored as
  reported, never recomputed.

### 4.13 Price control

Today the unit price of a line is read from the catalog at creation and never from the client
(`TDD_02 §13`), but the order-level **discount** is a free field. This section closes that gap and
makes every price change deliberate, limited and visible.

- **Locked by default.** A line's `unitPriceCents` is the catalog price at the moment of creation;
  `originalUnitPriceCents` is `null` until someone overrides it. Totals are computed on the server
  from the stored lines; the client never sends a total.
- **Level 1, `ORDERS_OVERRIDE_PRICE`:** may set any unit price (up or down) and any discount. A
  **reason is required** (`ORDER_PRICE_REASON_REQUIRED`); the original price, the new price, the
  reason and the author are stored on the line and audited (`ORDER_PRICE_OVERRIDDEN`); the
  approvers are notified when `orders.notifyOnPriceOverride` is on. It never needs approval.
- **Level 2, without that permission:** line prices are locked (`ORDER_PRICE_OVERRIDE_FORBIDDEN`).
  The agent may apply an order-level `discountCents` **with a reason** up to the **store's** limit,
  `orders.discountLimitPercent` of the store preferences (§4.14, **0 by default**, so no discounts until the owner
  allows some), measured against the order's subtotal (`discountCents / subtotalCents`). The same limit applies to every member
  without `ORDERS_OVERRIDE_PRICE`, whatever their role. It is checked on the server, in `OrdersService`, not
  in the UI; the discount is audited (`ORDER_DISCOUNT_APPLIED`).
- **Shipping fee.** The fee charged to the customer (`Order.shippingCents`) is controlled per carrier. The
  order names its planned carrier (`Order.carrierConnectionId`, preselected from
  `StoreSettings.defaultCarrierConnectionId`), and the fee field is **prefilled with that connection's
  `defaultShippingFeeCents`**. The connection's `minShippingFeeCents` and `maxShippingFeeCents` define the
  accepted range (either may be empty, meaning no bound on that side). A fee outside the range is treated
  exactly like a discount above the limit (Level 3 below); a member with `ORDERS_OVERRIDE_PRICE` may set it
  with a reason and it is audited. An order that charges a fee must name a carrier: any courier outside
  the platform is registered as a `local` connection (§4.2), which has the same three settings; **without a planned
  carrier the fee must be 0** unless the member holds `ORDERS_OVERRIDE_PRICE`.
- **Free shipping included in the product.** A product can be flagged `freeShipping` (its price already pays for
  the shipping). The order is **free-shipping** (`Order.freeShipping`, computed on the server) when the store
  preference `orders.freeShippingRule` is satisfied: `all_items` (default: every line is flagged) or `any_item`
  (at least one is). For a free-shipping order the fee is **0, which is accepted without approval whatever the
  carrier's minimum**, and the fee field is locked at 0; any other fee is treated as outside the range (approval for members without
  `ORDERS_OVERRIDE_PRICE`, who may set it with a reason). Mixed carts follow the rule: with `all_items` a cart that mixes flagged and unflagged products pays the
  carrier's default fee. The carrier still bills the sender (the create-guide dialog preselects `SENDER` as the
  payer and warns if the agent picks `RECIPIENT`, because the customer was promised free shipping).
- **Level 3, above the store's limit or outside the carrier's range:** the agent may still submit it. The order gets
  `priceApprovalStatus = PENDING` and `priceApprovalRequestedBy`; it **cannot be confirmed**
  (`ORDER_PRICE_APPROVAL_PENDING`; `confirmOnCreate` is ignored with a visible notice) and, if it was
  already confirmed when an edit made it pending, **no guide can be created** until it is approved, so it cannot
  receive a guide; the members holding `ORDERS_APPROVE_PRICE` get `ORDER_PRICE_APPROVAL_REQUESTED`.
- **Approval:** a member with `ORDERS_APPROVE_PRICE` approves or rejects from the order detail or a
  notification. **Nobody approves their own request** (`ORDER_PRICE_SELF_APPROVAL`). Approving stores
  `priceApprovedDiscountCents`, `priceApprovedShippingCents`, `priceApprovedBy`, `priceApprovedAt`
  (`ORDER_PRICE_APPROVED`). Rejecting (`ORDER_PRICE_REJECTED`) leaves the order unconfirmable until the
  discount and the fee are brought back within the limit and the range (status back to `NOT_REQUIRED`) or
  it is approved later. Any edit that moves the discount or the fee outside both the allowance and the
  approved values returns the order to `PENDING`.
- **Changing the planned carrier** (on the order while it is `PENDING_CONFIRMATION`, `CONFIRMED` or `PREPARING`, or in
  the create-guide dialog) does **not** require editing the fee first, because the fee is what the customer was
  told and changing it changes the order total. The dialog re-checks the current fee against the new carrier's
  range and, when it does not fit, offers: pick another carrier whose range accepts it; adjust the fee (a new total
  the customer must agree to); or request approval to keep the fee. A fee of 0 on a free-shipping order always fits.
- **At guide time:** `ShippingService.createShipments` refuses a connection whose range does not accept the order's
  fee (`SHIPPING_FEE_OUT_OF_RANGE`) unless the order is free-shipping with fee 0, the fee equals `priceApprovedShippingCents` or the caller holds
  `ORDERS_OVERRIDE_PRICE`, and refuses any order whose approval is `PENDING` or `REJECTED`
  (`ORDER_PRICE_APPROVAL_PENDING`).
- **Copying an order** (§4.3) never copies overrides or discounts: the draft carries catalog prices, the
  planned carrier and that carrier's default shipping fee, and the reason is required again.
- **Visibility:** the orders list shows a "price modified" badge and an approval-state chip and can
  filter by both; the order detail shows original and final price per line with the reason and author.

### 4.14 Store preferences (every default is configurable)

**The rule:** a control in the UI that starts checked or filled never carries that value in the
component. Its initial state is read from the store's preferences, and the factory default lives in
exactly one place, the Zod schema below. An ESLint rule (`TDD_14 §6`) forbids `defaultChecked` and
literal booleans as the initial state of a checkbox or switch in `apps/web`, so a new control has
to add its key here.

```typescript
// libs/core/config/store-preferences.ts: the only place factory defaults exist
export const storePreferencesSchema = z.object({
  orders: z.object({
    confirmOnCreate: z.boolean().default(false),        // the create-order "Mark as confirmed" checkbox
    sendSummaryOnCreate: z.boolean().default(true),     // the create-order "Send the order summary" checkbox
    notifyOnPriceOverride: z.boolean().default(true),   // §4.13
    freeShippingRule: z.enum(['all_items', 'any_item']).default('all_items'),   // §4.13: when an order counts as free shipping
    discountLimitPercent: z.number().int().min(0).max(100).default(0),   // §4.13: the discount allowed without approval to a member lacking ORDERS_OVERRIDE_PRICE
  }).default({}),
  returns: z.object({
    preselectCautionOnRefusal: z.boolean().default(false),   // the reception "flag customer" toggle, §4.16
  }).default({}),
  remittances: z.object({
    overdueAfterDays: z.number().int().min(1).max(90).default(7),   // §4.15
  }).default({}),
}).default({})
export type StorePreferences = z.infer<typeof storePreferencesSchema>
```

- Stored in `StoreSettings.preferences` as JSON; a read parses it through the schema (missing keys
  take the default, unknown keys are dropped), so adding a preference never needs a data migration.
- Per store, edited in Settings → Preferences by members with `SETTINGS_MANAGE_PREFERENCES`, audited
  (`STORE_PREFERENCES_UPDATED`). There is no per-user override in this phase.
- Settings that already exist elsewhere stay where they are (per carrier connection: payer, label
  format, pickup rules; per template: `autoSend` of the progress messages; per store: the inventory
  toggles). Settings → Preferences is for the controls that have none of those homes.

### 4.15 Cash-on-delivery remittances

A carrier collects the COD amount from the recipient and remits it to the owner later. The platform
tracks what each delivered COD guide should bring and reconciles it against the carrier's settlements.

- **`Shipment.codStatus`:** `NOT_APPLICABLE` for a prepaid shipment; `NOT_DELIVERED` while a COD shipment
  is on its way; `PENDING_REMITTANCE` when it reaches `DELIVERED`; `REMITTED` when a confirmed
  remittance matched it; `DISCREPANCY` when the remitted amount differed; `VOID` when the shipment
  is cancelled or returned (nothing was collected).
- **Expected amount**, written to `codExpectedCents` at `DELIVERED`: `codAmountCents`, minus the
  shipment's `carrierCostCents` **only when** the connection has `remittanceDeductsFee` on **and**
  `shippingPayer = SENDER` **and** the cost is known (reported when the guide was created, or by the
  fee column of the file). When the recipient pays the carrier, nothing is deducted; when the carrier
  does not report a fee, the expected amount is gross. Whether a carrier deducts its fee from what it
  remits is a fact to confirm with each carrier (§14); the connection flag is how the answer is recorded.
- **Import is deterministic, with no AI.** Input: a CSV or TSV file (at most 5 MB and 5,000 rows) or a
  table pasted as text. A `RemittanceImportProfile` saved per connection stores the delimiter,
  header row, decimal separator, date format and the column mapping (guide, amount, optional fee,
  date and reference); the first import opens a **mapper** with a preview of the first rows, later
  imports reuse the profile in one click. Parsing is strict: a cell that is not a valid number or
  date becomes a visible row error, never a silent zero, and no locale is guessed. Spreadsheet
  formulas are not evaluated and cell text is never rendered as HTML. The uploaded file is kept as
  `Media` (`REMITTANCE_FILE`, scanned) as the evidence of the remittance.
- **Matching** is by `(connection, guideNumber)`, ignoring case and surrounding whitespace. Each line gets
  an outcome: `MATCHED` (reported equals expected), `AMOUNT_DIFFERS` (the difference is shown),
  `NOT_FOUND` (no shipment: the line is kept and affects nothing), `NOT_DELIVERED` (the shipment exists but is not
  delivered or not COD: a warning), `ALREADY_REMITTED` (in another confirmed remittance: excluded) and
  `DUPLICATE_IN_FILE` (second occurrence ignored). Lines can be excluded and annotated, and a
  shipment can be added by hand when the carrier's file omits it.
- **The draft** shows the totals expected, reported and the fee, and the difference, before anything
  is written. **Confirming** (`REMITTANCES_MANAGE`) runs in one transaction under an advisory lock on the connection: matched
  lines set `REMITTED` and `codRemittedCents`, differing lines set `DISCREPANCY`; the three totals are
  stored on the remittance and it becomes immutable. A shipment in `DISCREPANCY` can be matched again by a
  later remittance. A confirmed remittance can be **voided** (HIGH-tier confirmation, audited), which
  returns its shipments to `PENDING_REMITTANCE`.
- **Pending screen:** every `PENDING_REMITTANCE` and `DISCREPANCY` shipment per connection, with its age and the total owed.
- **Overdue:** the daily `CHECK_REMITTANCES` job raises `REMITTANCE_OVERDUE` for a connection that has
  shipments pending longer than `remittances.overdueAfterDays`, at most once a week per connection.

### 4.16 Return reception (scanner) and the customer caution flag

The reception screen processes the packages that come back to the warehouse, one scan each, with a
keyboard-style barcode reader on a computer (the reader types the code and presses Enter; camera
scanning is out of scope).

- **A persistent batch.** `ReturnReceptionBatch` and its items are saved as the agent scans, so a
  refresh or a lost connection loses nothing. The scan field is always focused.
- **Lookup:** the scanned code is matched, ignoring case and whitespace, against the guide numbers of the store's
  shipments (outbound or return kind). More than one match asks which one; none shows a "not found" row with a manual search and has no side effect.
  Scanning the same shipment twice in a batch is refused, and one already received is refused
  (`RECEPTION_ALREADY_RECEIVED`).
- **Eligible shipments:** an outbound shipment in `RETURNING`, `RETURNED`, `FAILED_ATTEMPT`, `OUT_FOR_DELIVERY` or
  `IN_TRANSIT` (the carrier's status often lags the physical return), or a return-kind shipment. A shipment that
  is already `DELIVERED` asks for an explicit confirmation before it is accepted.
- **Per item, with defaults:** the reason (default `DELIVERY_FAILED`, with `REFUSED_BY_CUSTOMER` among
  the options), the condition `RESELLABLE`, the warehouse of the original allocation, all units of the order,
  expandable to per-line quantity and condition for a partial return; a free note ("the customer did
  not want it"); and a **"flag customer" toggle** (preselected by `returns.preselectCautionOnRefusal`) with its reason, which defaults to the note.
- **Completing the batch** processes each item **in its own transaction** through
  `ReturnsService.receiveFromScan`: it creates the `OrderReturn` (type `REFUND`, straight to `RECEIVED` and
  `COMPLETED`), sets the shipment to `RETURNED` with a manual event, applies the inventory rules of §4.11
  per condition, sets the order to `RETURNED` when received returns cover every unit, voids the shipment's COD status
  (§4.15) only if it was never delivered (a delivered shipment keeps its COD status: the cash was collected and any
  refund is settled by hand), applies the caution flag if asked, and audits `RETURN_RECEIVED_BY_SCAN`. An item that fails
  (for example a quantity above what was delivered) is marked `FAILED` with its error code and does not
  roll back the others; failed items stay in the batch for a retry.
- **The caution flag** (`Customer.isCaution`, `cautionReason`): set or cleared by members with
  `CUSTOMERS_FLAG_CAUTION` from the reception screen, the return detail or the customer profile, audited.
  It **informs and never blocks**: a banner with the reason in the create-order drawer when the
  customer is flagged, in the customer panel, a chip in the conversation header and in the orders list.
  A merge keeps the flag if either customer had it; an erasure clears the reason.

---

## 5. Cache and events

Nothing in this file is cached except the location catalog of a carrier (`lookupLocations`, Redis, 24 hours,
keyed by connection and parent location, invalidated when the connection is edited) and the
carrier's service catalog already stored in `CarrierService`. Shipments, pickups and returns are read from the primary
database. Events are emitted after their transaction commits and forwarded to the realtime
gateway where §3 lists a `RealtimeEvents` entry.

---

## 6. API routes

All under `ApiRoutes`, with `AuthGuard`, `TenantGuard` and a permission decorator, unless public.

| Group | Routes | Permission |
|---|---|---|
| `carriers` | list; create connection (a plugin and its credentials); by id; update (service codes, defaults, pickup rules, label format); `POST …/test` (health check); disconnect; `GET …/locations` (location lookup); `GET /carriers/registry` (which official carriers exist and their capabilities) | view: `SHIPPING_VIEW`; write: `SETTINGS_MANAGE_CARRIERS` |
| `shipments` | list (filters: status, connection, order, date); by id; `POST /orders/:id/shipments` (create); `POST /shipments/bulk`; `GET /shipments/bulk/:jobId`; `GET /shipments/:id/label`; `POST /shipments/labels/merge`; `POST /shipments/:id/cancel`; `POST /shipments/:id/status` (manual event); `POST /shipments/:id/check` (ask the carrier); `POST /shipments/:id/mark-voided` | view: `SHIPPING_VIEW`; others: `SHIPPING_MANAGE` |
| `pickups` | list; `POST /pickups` (request now, with the chosen shipments); `POST …/shipments` (add); `DELETE …/shipments/:shipmentId`; `POST …/confirm` (manual); `POST …/cancel`; `GET …/manifest` (printable list) | `SHIPPING_VIEW`; others: `SHIPPING_MANAGE_PICKUPS` |
| `orders` additions | `POST /orders/:id/confirm`; `POST /orders/confirm-bulk`; `GET /orders/:id/copy` (a prefilled draft, nothing is written; `ORDERS_CREATE`); `POST /orders/:id/messages` (send a kind, `?preview=true` renders without sending) | `ORDERS_CONFIRM`; messages: `ORDERS_SEND_MESSAGES` |
| `orderTemplates` | list; by kind and locale; upsert; delete | view: `ORDERS_VIEW`; write: `SETTINGS_MANAGE_ORDER_TEMPLATES` |
| `returns` | list; by id; create; `POST …/approve`, `…/reject`, `…/cancel`, `…/in-transit`, `…/receive` (with the line conditions), `…/complete`; `POST …/return-shipment` | view: `RETURNS_VIEW`; others: `RETURNS_MANAGE` |
| `returns.reception` | `POST /returns/reception/batches`; `GET …/:id`; `POST …/:id/scan` (a code); `PATCH …/:id/items/:itemId` (reason, condition, lines, note, flag); `DELETE …/:id/items/:itemId`; `POST …/:id/complete` (answers per item) | `RETURNS_MANAGE` |
| `remittances` | list; by id; `POST /remittances/imports` (file or pasted text, with a profile or an inline mapping, creates a draft); `PATCH …/:id` (reference, date, note); `PATCH …/:id/lines/:lineId` (exclude, note); `POST …/:id/lines` (add a shipment by hand); `POST …/:id/confirm`; `POST …/:id/void`; `GET /remittances/pending` (the pending screen); import profiles: list, create, update, delete | view: `REMITTANCES_VIEW`; others: `REMITTANCES_MANAGE` |
| `customers.caution` | `PUT /customers/:id/caution` (reason), `DELETE /customers/:id/caution` | `CUSTOMERS_FLAG_CAUTION` |
| `orders` price approval | `POST /orders/:id/price-approval/approve`, `…/reject` | `ORDERS_APPROVE_PRICE` |
| `settings.preferences` | `GET /settings/preferences` (parsed through `storePreferencesSchema`), `PUT /settings/preferences` | read: `SETTINGS_VIEW`; write: `SETTINGS_MANAGE_PREFERENCES` |
| `webhooks.carrier` (public) | `POST /webhooks/carriers/:connectionId` | none; the signature authenticates it |
| `plugin-api` additions | `POST /plugin-api/shipments`, `POST /plugin-api/shipments/:id/events`, `GET /plugin-api/shipments` | `PluginApiKeyGuard`, scopes `shipments:write` / `shipments:read` |

Cursor pagination on every list (`TDD_08 §2.4`). Bulk endpoints accept at most 100 ids and answer
`202` with the job id.

---

## 7. UI

- **Orders page** (`/s/[storeId]/orders`, the full-page list, built in Step 4.4 with search, filters, cursor pagination and row selection; the shipping parts below arrive in Step 4.14): multi-select with an action bar: **Mark as confirmed**,
  **Send summary**, **Generate labels**, **Print labels**, **Request pickup**. Badges for "price modified" and the approval state, a caution chip on flagged customers. A control that does not
  apply to some selected orders runs on the rest and reports the skipped ones with the reason.
  Columns for status, carrier, guide number, shipment status and pickup state; filters for the same.
- **Order detail:** the status stepper includes the confirmation step with who confirmed and how;
  a **Shipping** panel (guide, carrier, service, payer, COD amount or "Paid", label download,
  event history, cancel, "check with the carrier", the manual status buttons for a `local`
  courier); a **Messages** panel (what was sent, in which channel, free text or approved template,
  and the failures with a "send manually" action); a **Returns** panel. Every action appears only
  when the permission and the plugin capability behind it exist.
- **Create-order drawer** (`TDD_09 §5.1`): the "Mark as confirmed" and "Send the order summary" checkboxes, **both initialised from the store preferences** (§4.14; factory defaults: unchecked and checked), the first shown only with `ORDERS_CONFIRM`; a banner with the reason when the customer is flagged (§4.16); **Copy order** on the order detail and the customer's order list opens the drawer prefilled with warnings for unavailable items or changed prices (§4.3).
- **Create-guide dialog:** for a pickup-bound carrier it also asks the **pickup date and window** (defaulting to the next valid day); connection (default preselected), service (the connection's default
  preselected, labels from `CarrierService`), shipping payer (the connection's default, or `SENDER` for a free-shipping order), the COD
  amount **read-only** with its reason, packages, weight, and the location selectors when the plugin
  needs them.
- **Settings → Carriers:** connect a carrier (credentials form from the plugin), test, service
  list (code and label editable, one default), default payer, **default shipping fee with the minimum and maximum accepted**, label format, pickup rules (days,
  cutoff, auto-request time, reminder), poll interval, the webhook URL and secret to give the
  carrier. **Settings → Order messages:** templates (§4.7). **Settings → Returns:** the default
  return shipping payer.
- **Separate screens, one per job**, each with its own entry in the store navigation (the owner works
  on a computer, so they are desktop-first; no mobile-first requirement here):
  - **Shipments** (`/s/[storeId]/shipments`): every shipment with filters (status, carrier, order,
    date, COD status), the guide, the label download and the event history.
  - **Pickups** (`/s/[storeId]/pickups`): today's pickups per connection with package count and the waiting
    shipments, "Request now", "Add shipment", the printable manifest.
  - **Returns** (`/s/[storeId]/returns`): list and detail with the lines, reason and photos, the return leg
    and the replacement order link. **Return reception** (`/s/[storeId]/returns/receive`): the scan screen.
  - **Remittances** (`/s/[storeId]/remittances`): the pending list with age and total owed per carrier,
    the import flow and the history.
- **Return reception screen:** a single scan field (always focused) on top; below, the batch as a table
  with one row per package (guide, order, customer, products) whose cells edit in place: reason, condition,
  warehouse, a note, and the "flag customer" toggle with its reason; unknown codes appear as a row to
  search by hand; one primary action, "Receive batch (n)", whose result lists each item as received or
  failed with the reason, failed ones staying in the batch.
- **Remittance import:** pick the carrier and a saved profile (or build one in the **mapper**, which
  previews the first rows and lets the agent assign the guide, amount, fee, date and reference columns),
  upload a CSV or paste a table; the draft then shows each line with its outcome, the expected, reported and
  fee totals and the difference, line exclusion and notes, then "Confirm remittance".
- **Price control in the create-order and edit flows:** a line price shows an "Edit price" action only
  to members with `ORDERS_OVERRIDE_PRICE`, with a required reason; the discount field shows the store's
  limit and, above it, states that the order will need approval; the shipping fee is prefilled from the planned carrier
  with its accepted range shown (or locked at 0 with the note "free shipping included in the price of X"), and a value outside it states that the order will need approval; the order detail shows original and
  final prices, the reason and the approval state with Approve and Reject for approvers.
- **Settings → Preferences:** one page with every preference of §4.14, a toggle each, the factory
  default marked, and a "restore defaults" action.
- No emojis, Lucide icons, every string an i18n key, destructive actions follow `TDD_09 §11`.

---

## 8. Permissions, isolation and audit

- Every new resource enters `tests/security/tenant-isolation.spec.ts` in the same change as the
  resource: `CarrierConnection`, `CarrierService`, `Shipment`, `ShipmentEvent`, `PickupRequest`,
  `BulkLabelJob`, `OrderMessageTemplate`, `OrderReturn`, `OrderReturnLine`, `ReturnReceptionBatch`, `ReturnReceptionItem`, `CodRemittance`, `CodRemittanceLine`, `RemittanceImportProfile` by `storeId`, and the
  public carrier webhook with a connection id from another store.
- Every mutation is audited (§3), every state change goes through the owning service
  (`ShippingService`, `ReturnsService`, `OrdersService`), never `prisma.<model>.update`. A lint
  rule (`TDD_14 §6`, same kind as the `conversation.status` selector) forbids writing
  `shipment.status`, `shipment.codStatus`, `pickupRequest.status`, `orderReturn.status`, `codRemittance.status` and
  `order.priceApprovalStatus` outside their service.
- A plugin key sees and writes only the shipments of its bound store and within its granted
  scopes (`TDD_10 §6.4`).
- Credentials, webhook secrets and label URLs never appear in responses, logs or audit
  `metadata` (§4.12).

---

## 9. Tests

- **Unit:** the shipment, order, pickup and return state machines (forward-only, regressions
  refused; `CONFIRMED → SHIPPED` allowed); the COD derivation (§4.4) for every payment method and status, including the split of one COD total across several shipments (the parts add up to the total, the fee on the first, rounding on the last); template rendering
  (allowlist, unknown variable refused, missing optional variable, locale fallback); the pickup
  window logic (days, cutoff, timezone, DST-free `America/El_Salvador` and one DST zone); the
  guide sequence; the status-mapping tables of each plugin.
- **Contract tests:** each carrier plugin against recorded fixtures (§4.1), plus a *fake carrier* plugin used by
  every integration test, with switches for the failure modes (reject, timeout before and after the
  carrier acted, idempotent, no cancel, no webhook).
- **Integration (real database and Redis):**
  - the fake carrier also runs as **pickup-bound**: one batch call returns the guides of several orders and creates the pickup, one refused order fails alone, a timeout puts the whole batch in `REQUIRES_REVIEW` and "check with the carrier" completes it, later orders join the open pickup with `PICKUP_MODIFY` or open a second one without it, cancelling a guide lowers or cancels the pickup, and bulk generation sends one call per batch of at most `maxBatchSize`;
  - create a shipment end to end; the unique index refuses a second active shipment for the same order and warehouse; two parallel creates end with one guide;
  - a timeout without `IDEMPOTENT_CREATE` ends in `REQUIRES_REVIEW` and never retries; with it the retry makes no second guide;
  - webhook: bad signature rejected, duplicate event applied once, an out-of-order event stored but not applied, an unmapped status stored without effect;
  - polling for a carrier without webhooks, and its stop at a terminal state;
  - order effects of every shipment status (§4.9) including the inventory `ISSUE` once, the COD payment completing, and no customer message sent twice;
  - cancel: order with no guide, with a `LABEL_CREATED` guide (void succeeds, void unsupported, void fails after retries), after pickup (refused), stock released once;
  - bulk: mixed selection with skipped orders, one carrier failure leaving a partial PDF in the selected order, parallelism cap, reuse of an existing label, no carrier call on "print";
  - pickups: scheduler creates one pickup, a later shipment joins it with `PICKUP_MODIFY`, waits without it, the reminder fires once, manual and cron racing end with one pickup, a cancelled shipment lowers the count;
  - messages: inside the window free text, outside it an approved template, outside it with no template email or the not-sent notification; the attachment only where the channel supports documents;
  - returns: quantity limits, exchange creates the confirmed replacement with the right total and stock, inventory for resellable and defective items, partial versus full return and the order status, refund recording.
- **Price control:** a member without `ORDERS_OVERRIDE_PRICE` cannot change a line price; a discount
  within the store's `orders.discountLimitPercent` passes with a reason (and nothing passes while it is 0), above it the order goes `PENDING`, cannot be
  confirmed (including with `confirmOnCreate`) and gets no guide; the shipping fee is prefilled from the carrier, a fee below the minimum or above the
  maximum goes `PENDING` the same way, a fee with no carrier is refused unless 0, an edit that makes a confirmed order `PENDING` blocks its guide,
  a guide on a connection whose range rejects the fee is refused unless approved or overridden; nobody approves their own request;
  editing the discount upward after approval returns it to `PENDING`; the server rejects a client that
  sends a price; a copied order carries catalog prices.
- **Free shipping:** with `all_items`, an order whose every line is flagged accepts fee 0 even when the carrier's minimum is above 0 and needs no approval, and a mixed cart gets the carrier's default fee; with `any_item` one flagged line is enough; any other fee on a free-shipping order needs the override permission; the flag is snapshotted on the order lines; changing the carrier re-checks the fee and offers the three options of §4.13.
- **Preferences:** the schema fills defaults for missing keys and drops unknown ones; the checkboxes of the
  create-order drawer start from the stored values; the lint rule refuses a hardcoded initial state.
- **Remittances:** the mapper and strict parsing (comma and dot decimals, invalid cells reported, no formula evaluation), every
  outcome of §4.15 including duplicates and already-remitted guides, expected amount with and without fee
  deduction and with the recipient paying, confirm under concurrency (two confirms of overlapping drafts end with
  one), void restoring the statuses, a discrepancy settled by a later remittance, the overdue job's weekly limit.
- **Reception:** a scan of an unknown, duplicate and already-received code; a delivered shipment needing
  confirmation; partial return by line; a failing item not rolling back the others and being retryable; the
  inventory effect per condition; the caution flag set and shown in the drawer, customer panel and list; merge and erasure behaviour of the flag.
- **Tenant isolation:** the cases of §8 in the isolation suite, run as `platform_app` with RLS forced after Step 7.1.
- **Order copy and confirm at creation:** the checkbox creates a `CONFIRMED` order only for a caller with `ORDERS_CONFIRM` (refused otherwise), the copy draft writes nothing, never carries old prices, warns on inactive or out-of-stock items, and the resulting order links `copiedFromOrderId`.
- **Messaging window by declaration:** with a test channel plugin that declares no window, the free text is sent at any time and a linked template is ignored; with a window policy it follows §4.7. No code path tests a plugin id.
- **Frontend (Vitest and Playwright):** the bulk action bar with skipped orders, the create-guide dialog with read-only COD, the pickup settings form, the template editor with the variable picker; one e2e that confirms an order, generates labels in bulk against the fake carrier and downloads the merged PDF.
- **Coverage:** `libs/core/shipping/` and the price rules of `OrdersService` (`apps/api/src/modules/orders`) are critical paths with a 90% line threshold (`TDD_13 §1`, `§9`).

---

## 10. Where the code lives

- `libs/plugins/sdk/src/carrier-*.ts`: `CarrierPlugin`, the params and result types and the typed errors; the registry in `libs/plugins/runtime` loads carrier plugins beside channel plugins.
- `libs/carriers/local`, `libs/carriers/forza`, `libs/carriers/c807`: one library per official carrier (each `scope:channels`-style, depends only on the SDK). `local` has no HTTP; it is the guide numbering and the label template.
- `libs/core/shipping/`: `ShippingService` (create, cancel, events, pickups, bulk), `ReturnsService` (with `receiveFromScan`), `ReturnReceptionService`, `RemittancesService`, `OrderMessagesService`, the constants and Zod schemas; `scope:core`, used by `apps/api` and `apps/worker`. `OrdersService` and `InventoryService` talk to it through its public interface only.
- `apps/api/src/modules/shipping/`, `…/returns/`, `…/order-messages/`: controllers, including the public carrier webhook controller.
- `apps/worker`: the processors of §3 (`CREATE_SHIPMENTS`, `BULK_LABELS_MERGE`, `CANCEL_SHIPMENT`, `POLL_SHIPMENT_STATUS`, `EVALUATE_PICKUPS`, `SEND_ORDER_MESSAGE`, `PROCESS_CARRIER_EVENT`, `CLEAN_BULK_LABELS`).
- `apps/web`: the screens of §7.

---

## 11. Boundaries kept for later

- **AI-assisted remittance import** (Phase 2, and only as a suggestion): extracting the table from a
  PDF or a photo of a statement. It would produce the same draft lines that the deterministic mapper of §4.15
  produces and stop at the same preview, so a person confirms before anything is written (`CLAUDE.md`
  rule 10: AI suggests, a human approves). The importer needs no change to accept it.
- **Automatic remittance reports** from a carrier's API: a `COD_REMITTANCE_REPORT` capability on the
  plugin that returns lines in the shape the import already uses.
- **A tracking aggregator** (for example 17TRACK) is another way to produce `CarrierEvent`s: a future
  `TrackingProvider` interface registers a guide with the aggregator and feeds
  `PROCESS_CARRIER_EVENT`, with no change to the shipment engine, the order effects or the
  messages. It is not needed while the carriers push or can be polled directly.
- **A carrier aggregator or marketplace** (for example DeliverLink) would be one more `CarrierPlugin` with
  its own capabilities and credentials; no core change.
- **Rate quotes** (`getRates`) per carrier can be added as an optional method and a "compare" step
  in the create dialog; the current dialog already has the service field the quote would fill.
- **Native ZPL** labels add a `labelFormat` value and a ZPL path in the plugin result; the bulk
  merge would then produce one ZPL stream instead of a PDF.
- **Customer self-service tracking** would read the stored `ShipmentEvent`s; nothing here blocks it.

---

## 12. Not in this phase

Tracking aggregators and carrier aggregators (§11); rate shopping across carriers; native ZPL
or direct thermal-printer drivers; insurance and declared value; multi-leg or international shipping and customs documents;
automatic detection of the customer's confirmation (AI); a customer-facing tracking page; XLSX or PDF remittance statements and AI extraction from them (§11); partial remittances (a part paid now and the rest later: they show as a discrepancy); 
automatic refunds to a payment processor; carrier invoicing reconciliation (the cost per guide is
stored as reported, nothing more); scheduled pickups with time windows chosen by the
platform (a window is sent only when the carrier asks for one); and the marketplace for carrier plugins.

---

## 13. How these rules can change after the MVP

- **Who may do what** is configurable like everything else: the permissions of §3 are the
  defaults of the presets, and custom roles (Step 1.4) mix them freely, for example one role that confirms
  orders but cannot create guides.
- **Per connection, no code change:** service codes and labels, the default payer, the default shipping fee and its
  accepted range, the label format, pickup days, cutoff, auto-request time and reminder, the polling interval,
  whether the carrier deducts its fee from remittances.
- **Per store:** every message template (text, variables used, automatic or manual, the approved
  channel-approved template it maps to), the default return payer, bulk-label retention, the discount limit, the
  free-shipping rule and every other preference of §4.14.
- **A new carrier** is a new `CarrierPlugin` implementing the capabilities it really has; the UI
  adapts to the capabilities, and the `local` carrier covers the rest.
- **Additive later changes** (new columns or tables, no data migration): a tracking provider, rate
  quotes, ZPL, automatic remittance reports, AI extraction of statements, customer tracking page (§11, §12).
- **Rules that are correctness choices, not preferences**, and that change only with a deliberate TDD
  revision: a guide is created at most once per order and warehouse, an unknown carrier outcome is
  never retried blindly without idempotency, only confirmed orders get a guide, shipment status
  only moves forward, and the movement ledger stays append-only when a return is discarded.

---

## 14. Carrier adapters: what is known

The core above does not depend on any carrier's documentation. The adapters do; their status when this
TDD was written (2026-10-24):

| Carrier | Known | Needed before building the adapter |
|---|---|---|
| `local` | Everything: no external API. | Nothing. |
| `forza` (Forza Delivery Express) | Public Postman walkthrough "Forza Ecommerce Engine" (published 2020): REST over HTTPS `POST`, a request body of `CodApp` plus a base64 `PayLoad` (`Method` and `Params`) and a signature in the `LauValue` header; endpoints for the geography catalog (departments, municipalities, settlements, which is why `REQUIRES_LOCATION_IDS`), shipping rates (`GetShippingRates`), shipping labels (from a quote, from a shipment, list), and tracking by guide number or label id. The documentation says real-time tracking through **webhooks** can be provided on request. The public collection does **not** document cancelling a guide, pickups, return shipments, service codes, COD fields or the signature algorithm. | The full sandbox documentation and credentials from the Forza sales advisor: the signature algorithm, the guide-creation payload (service codes, payer, COD, packages), the label format and size, cancel and pickup endpoints (or their absence), the webhook registration and signature, rate limits, and whether guide creation accepts a unique reference. |
| `c807` (C807 Express) | The owner reports that it offers webhooks and that its API covers guides, cancellation and pickups, and that **a guide is created inside a pickup request**: one call carries the pickup and an array of orders and returns the guides of all of them. The adapter is therefore *pickup-bound* (§4.1, §4.5). | The documentation and credentials from the C807 advisor, with the same list as above. |

Capabilities are declared from what the documentation confirms, never assumed: a capability that
cannot be confirmed is left out, and the platform falls back to the manual path (for example
`PICKUP_MANUAL_REQUIRED`). The demo credentials printed in Forza's public collection are examples
and must never be used or copied into this repository.
