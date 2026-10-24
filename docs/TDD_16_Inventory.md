# TDD 16 — Inventory (warehouses, stock, transfers, counts)

> Part of the Omnichannel Commerce Platform TDD v1.2
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: warehouses, stock levels, the movement ledger, reservations, adjustments,
> transfers between warehouses, physical counts, permissions and tenant isolation.
> This file **extends** `TDD_01 §4` (data model) and `TDD_02` (constants). Where it changes a
> model or constant defined there, this file wins.
> Out of scope here (later phases): POS and cash register, purchase orders and suppliers,
> lots/serials/expiry, costing, backorders, Shopify as an alternative provider (§12).

---

## 1. Concepts and scoping

The owner runs several stores that **sell different things**, and a warehouse can supply
**several stores**. So:

- **Products and variants stay store-scoped** (`Product.storeId`). Catalogs are never shared
  between stores.
- **A warehouse belongs to the organization**, not to a store.
- **A store sells from one or more warehouses** (`StoreWarehouse`), ordered by priority.
- **Stock is kept per product (or variant) and per warehouse** (`InventoryLevel`).

| Resource | Scope column | Visible to |
|---|---|---|
| `Warehouse` | `organizationId` | members of any store of the organization holding the permission |
| `StoreWarehouse` | `organizationId` + `storeId` | same |
| `InventoryLevel`, `InventoryMovement` | `storeId` | members of that store |
| `OrderItemAllocation` | `storeId` | members of that store |
| `StockTransfer`, `StockCount` (headers) | `organizationId` | members of any store of the organization holding the permission |
| `StockTransferLine`, `StockCountLine` | `storeId` (the product's store) | only members of that store: a user sees the lines of the stores they belong to |

**Organization context without a new mechanism.** Organization-scoped routes still send
`X-Store-Id`. `TenantGuard` resolves the store's organization and the permission is read from
the user's role in that store. `organizationId` in queries always comes from the guard
context, never from the body or the query string (`CLAUDE.md` rule 2).

---

## 2. Data model additions (Prisma, mapped names)

```prisma
model Warehouse {
  id             String   @id @default(uuid())
  organizationId String   @map("organization_id")
  name           String
  code           String                                   // Short, printed on documents. Unique per organization
  address        Json?
  active         Boolean  @default(true)
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  stores       StoreWarehouse[]
  levels       InventoryLevel[]
  movements    InventoryMovement[]
  transfersOut StockTransfer[]  @relation("TransferFrom")
  transfersIn  StockTransfer[]  @relation("TransferTo")
  counts       StockCount[]

  @@unique([organizationId, code])
  @@map("warehouses")
}

// Which warehouses a store sells from. priority 1 is reserved first (§4.1).
model StoreWarehouse {
  id             String @id @default(uuid())
  organizationId String @map("organization_id")
  storeId        String @map("store_id")
  warehouseId    String @map("warehouse_id")
  priority       Int

  store     Store     @relation(fields: [storeId], references: [id], onDelete: Cascade)
  warehouse Warehouse @relation(fields: [warehouseId], references: [id], onDelete: Cascade)

  @@unique([storeId, warehouseId])
  @@unique([storeId, priority])
  @@map("store_warehouses")
}

// Current stock of one item in one warehouse. variantId is null for a product without variants.
// Reads use this table; the ledger below is the audit trail. Both change in ONE transaction (§4.2).
model InventoryLevel {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  productId   String   @map("product_id")
  variantId   String?  @map("variant_id")
  warehouseId String   @map("warehouse_id")
  onHand      Int      @default(0) @map("on_hand")
  reserved    Int      @default(0)
  updatedAt   DateTime @updatedAt @map("updated_at")

  store     Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product   Product         @relation(fields: [productId], references: [id])
  variant   ProductVariant? @relation(fields: [variantId], references: [id])
  warehouse Warehouse       @relation(fields: [warehouseId], references: [id])

  @@index([storeId, warehouseId])
  @@index([productId, variantId])
  @@map("inventory_levels")
}

model StockTransfer {
  id              String    @id @default(uuid())
  organizationId  String    @map("organization_id")
  number          String                                   // "TR-0001", per organization, same generation as Order.orderNumber
  fromWarehouseId String    @map("from_warehouse_id")
  toWarehouseId   String    @map("to_warehouse_id")
  status          String    @default("draft")              // TransferStatus
  note            String?
  createdBy       String    @map("created_by")
  dispatchedBy    String?   @map("dispatched_by")
  dispatchedAt    DateTime? @map("dispatched_at")
  closedAt        DateTime? @map("closed_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  organization  Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  fromWarehouse Warehouse           @relation("TransferFrom", fields: [fromWarehouseId], references: [id])
  toWarehouse   Warehouse           @relation("TransferTo", fields: [toWarehouseId], references: [id])
  lines         StockTransferLine[]

  @@unique([organizationId, number])
  @@index([organizationId, status])
  @@map("stock_transfers")
}

model StockTransferLine {
  id               String  @id @default(uuid())
  transferId       String  @map("transfer_id")
  storeId          String  @map("store_id")                // The product's store
  productId        String  @map("product_id")
  variantId        String? @map("variant_id")
  quantity         Int                                     // Dispatched quantity
  receivedQuantity Int     @default(0) @map("received_quantity")
  shortageAction   String? @map("shortage_action")         // TransferShortageAction, set on close

  transfer StockTransfer @relation(fields: [transferId], references: [id], onDelete: Cascade)
  store    Store         @relation(fields: [storeId], references: [id])

  @@index([transferId])
  @@index([storeId])
  @@map("stock_transfer_lines")
}

model StockCount {
  id             String    @id @default(uuid())
  organizationId String    @map("organization_id")
  warehouseId    String    @map("warehouse_id")
  number         String                                    // "CT-0001"
  status         String    @default("draft")               // CountStatus
  storeId        String?   @map("store_id")                // Optional filter: count only one store's products
  note           String?
  createdBy      String    @map("created_by")
  startedAt      DateTime? @map("started_at")
  appliedBy      String?   @map("applied_by")
  appliedAt      DateTime? @map("applied_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  warehouse    Warehouse        @relation(fields: [warehouseId], references: [id])
  lines        StockCountLine[]

  @@unique([organizationId, number])
  @@index([organizationId, status])
  @@map("stock_counts")
}

model StockCountLine {
  id               String  @id @default(uuid())
  countId          String  @map("count_id")
  storeId          String  @map("store_id")
  productId        String  @map("product_id")
  variantId        String? @map("variant_id")
  expectedQuantity Int     @map("expected_quantity")       // onHand snapshot taken when the count starts
  countedQuantity  Int?    @map("counted_quantity")        // Null until counted

  count StockCount @relation(fields: [countId], references: [id], onDelete: Cascade)
  store Store      @relation(fields: [storeId], references: [id])

  @@index([countId])
  @@index([storeId])
  @@map("stock_count_lines")
}
```

```prisma
// Which warehouse serves how many units of an order line. A line served by one warehouse has one
// allocation; with split fulfillment (§4.1) it can have several. The quantities of a line's
// allocations always add up to OrderItem.quantity (checked by InventoryService, tracked products only).
model OrderItemAllocation {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  orderItemId String   @map("order_item_id")
  warehouseId String   @map("warehouse_id")
  quantity    Int
  createdAt   DateTime @default(now()) @map("created_at")

  store     Store     @relation(fields: [storeId], references: [id])
  orderItem OrderItem @relation(fields: [orderItemId], references: [id], onDelete: Cascade)
  warehouse Warehouse @relation(fields: [warehouseId], references: [id])

  @@unique([orderItemId, warehouseId])
  @@index([storeId])
  @@index([warehouseId])
  @@map("order_item_allocations")
}
```

**Changes to existing models**
- `InventoryMovement` (`TDD_01 §4`): add `warehouseId` (required), `reason` (`InventoryAdjustmentReason`, set for manual types), `note`, `referenceType` and `referenceId` (replace the free-text `reference`), `idempotencyKey` (unique), `onHandAfter` and `reservedAfter` (the level after the movement, so the kardex needs no recomputation). `quantity` is always positive; `type` carries the direction (§3). The ledger is append-only: no code path updates or deletes a movement.
- `OrderItem`: no warehouse column; the reservation sits in its `allocations` (`OrderItemAllocation[]`, added as the opposite relation).
- `Product.lowStockThreshold` (`TDD_01 §4`) becomes nullable and loses its default of 5: `null` means **no low-stock alert** for that product, a number means "alert when available stock reaches this quantity or less" (§4.4).
- `StoreSettings` (`TDD_01 §4`): add `defaultLowStockThreshold Int? @map("default_low_stock_threshold")` (initial value for new products, `null` = none), `allowNegativeStock Boolean @default(false) @map("allow_negative_stock")` (§4.10) and `allowSplitFulfillment Boolean @default(false) @map("allow_split_fulfillment")` (§4.1).
- **Opposite relation fields Prisma needs:** `Organization` gets `warehouses`, `stockTransfers`, `stockCounts`; `Store` gets `storeWarehouses`, `inventoryLevels`, `stockTransferLines`, `stockCountLines`, `orderItemAllocations`; `Warehouse` gets `allocations`; `OrderItem` gets `allocations`; `Product` and `ProductVariant` get `inventoryLevels`, `stockTransferLines`, `stockCountLines`. `StockTransferLine` and `StockCountLine` also declare relations to `Product` and `ProductVariant` (the models above omit them for brevity) so product ids are foreign keys.
- `Product.trackInventory = false` skips inventory entirely: no level, no reservation.

**Raw SQL (same migration file as `TDD_01 §5`, with rollback)**
```sql
ALTER TABLE inventory_levels ADD CONSTRAINT chk_inventory_reserved_non_negative CHECK (reserved >= 0);
-- on_hand and (on_hand - reserved) may be negative only when the store allows it (StoreSettings.allowNegativeStock, §4.10).
-- That setting cannot be expressed as a CHECK, so "stock never negative" is enforced by InventoryService and reported by the reconciliation job.

-- NULL variant_id must not create duplicates (NULL <> NULL in unique indexes)
CREATE UNIQUE INDEX uq_inventory_levels_product ON inventory_levels (store_id, product_id, warehouse_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX uq_inventory_levels_variant ON inventory_levels (store_id, variant_id, warehouse_id) WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX uq_inventory_movements_idempotency ON inventory_movements (idempotency_key);
```

---

## 3. Constants (additions to `TDD_02`)

```typescript
// libs/core/domain/status-enums.ts
export enum InventoryMovementType {          // replaces the v1.1 enum (in/out/reserved/released/adjustment)
  RECEIPT = 'receipt',                // onHand +q   (receiving, opening stock)
  ISSUE = 'issue',                    // onHand -q and reserved -q   (order shipped, consumes its reservation)
  RESERVE = 'reserve',                // reserved +q
  RELEASE = 'release',                // reserved -q
  ADJUSTMENT_IN = 'adjustment_in',    // onHand +q   (manual, needs a reason)
  ADJUSTMENT_OUT = 'adjustment_out',  // onHand -q   (manual, needs a reason)
  TRANSFER_OUT = 'transfer_out',      // onHand -q   (transfer dispatched)
  TRANSFER_IN = 'transfer_in',        // onHand +q   (transfer received)
  COUNT_IN = 'count_in',              // onHand +q   (count variance)
  COUNT_OUT = 'count_out',            // onHand -q   (count variance)
  RETURN_IN = 'return_in',            // onHand +q   (returned order restocked)
}

export enum InventoryAdjustmentReason {
  OPENING_STOCK = 'opening_stock', DAMAGED = 'damaged', LOST = 'lost',
  FOUND = 'found', CORRECTION = 'correction', OTHER = 'other',
}

export enum InventoryReferenceType { ORDER = 'order', TRANSFER = 'transfer', COUNT = 'count', MANUAL = 'manual' }

export enum TransferStatus { DRAFT = 'draft', IN_TRANSIT = 'in_transit', RECEIVED = 'received', CANCELLED = 'cancelled' }
export enum TransferShortageAction { WRITE_OFF = 'write_off', RETURN_TO_SOURCE = 'return_to_source' }
export enum CountStatus { DRAFT = 'draft', COUNTING = 'counting', REVIEW = 'review', APPLIED = 'applied', CANCELLED = 'cancelled' }
```

Transition tables (same style as `OrderStatusTransitions`, enforced inside the owning service):
- Transfer: `DRAFT → IN_TRANSIT | CANCELLED`, `IN_TRANSIT → RECEIVED | CANCELLED`, `RECEIVED` and `CANCELLED` are terminal.
- Count: `DRAFT → COUNTING | CANCELLED`, `COUNTING → REVIEW | CANCELLED`, `REVIEW → COUNTING | APPLIED | CANCELLED`, `APPLIED` and `CANCELLED` are terminal.

Other additions (each goes in its constants file, no inline strings):

| Set | New entries |
|---|---|
| `Permissions` | `INVENTORY_VIEW: 'inventory:view'`, `ORG_MANAGE_WAREHOUSES: 'org:manage_warehouses'`, `INVENTORY_MANAGE_TRANSFERS: 'inventory:manage_transfers'`, `INVENTORY_RECEIVE_TRANSFERS: 'inventory:receive_transfers'`, `INVENTORY_MANAGE_COUNTS: 'inventory:manage_counts'`, `INVENTORY_APPLY_COUNTS: 'inventory:apply_counts'` (`INVENTORY_ADJUST` already exists) |
| `RolePresets` | Admin: all (spread). Supervisor: view, adjust, manage and receive transfers, manage counts. Agent: view. Viewer: view |
| `Events` | `WAREHOUSE_CREATED`, `WAREHOUSE_UPDATED`, `TRANSFER_DISPATCHED`, `TRANSFER_RECEIVED`, `TRANSFER_CANCELLED`, `COUNT_APPLIED` (`INVENTORY_MOVED` and `INVENTORY_LOW` already exist) |
| `NotificationTypes` | `TRANSFER_DISPATCHED` (to members holding `INVENTORY_RECEIVE_TRANSFERS`; severity info, channels in-app and push), `COUNT_AWAITING_APPLY` (to members holding `INVENTORY_APPLY_COUNTS`; severity info, in-app). Both need an entry in `NotificationDefaults`, which must stay complete. `INVENTORY_LOW` already exists |
| `AuditActions` | `WAREHOUSE_CREATED`, `WAREHOUSE_UPDATED`, `INVENTORY_ADJUSTED`, `TRANSFER_DISPATCHED`, `TRANSFER_RECEIVED`, `TRANSFER_CLOSED_WITH_SHORTAGE`, `TRANSFER_CANCELLED`, `COUNT_APPLIED` |
| `ErrorCodes` | `INSUFFICIENT_INVENTORY` (exists), `INVENTORY_WAREHOUSE_NOT_LINKED`, `INVENTORY_WAREHOUSE_HAS_STOCK`, `INVENTORY_TRANSFER_SAME_WAREHOUSE`, `INVENTORY_TRANSFER_INVALID_STATUS_TRANSITION`, `INVENTORY_COUNT_INVALID_STATUS_TRANSITION`, `INVENTORY_ADJUSTMENT_REASON_REQUIRED` |
| `JobNames` / `Schedules` | `RECONCILE_INVENTORY` job on `heavy-processing`; schedule `RECONCILE_INVENTORY: '0 4 * * *'` |
| `MetricNames` | `INVENTORY_RECONCILIATION_MISMATCHES: 'platform_inventory_reconciliation_mismatches_total'` |
| `ApiRoutes` | the `inventory`, `warehouses`, `transfers`, `counts` groups in §6 |
| `AppPaths` | `store.inventory(storeId)`, `org.warehouses`, `org.transfers`, `org.counts` |
| `QueryKeys` | `inventory.levels`, `inventory.movements`, `warehouses.all`, `transfers.all`, `counts.all` (store or organization scoped like the others) |
| "Prisma column → enum" table (`TDD_02 §5`) | rows for `InventoryMovement.type`, `InventoryMovement.reason`, `InventoryMovement.referenceType`, `StockTransfer.status`, `StockTransferLine.shortageAction`, `StockCount.status` |
| `DestructiveActionTiers` (`TDD_09 §11.1`) | HIGH: "Cancel an in-transit transfer", "Apply a stock count" |
| `PluginScopes` (`TDD_10 §6.2`) | `INVENTORY_READ: 'inventory:read'` (grants `INVENTORY_VIEW`), `INVENTORY_WRITE: 'inventory:write'` (grants `INVENTORY_ADJUST`) |

---

## 4. Rules

### 4.1 Reservation when an order is created

For every order line of a product with `trackInventory`, take the store's warehouses ordered by `StoreWarehouse.priority` and allocate:

1. If **one** warehouse covers the whole line (available stock `onHand - reserved` is at least the quantity), the **first** such warehouse gets the whole line: one allocation. This holds in both modes, so shipments stay simple whenever they can.
2. If none does and the store has **`allowSplitFulfillment` on**, serve the line from several warehouses: walk them by priority and take `min(available, still needed)` from each until the quantity is met. Each warehouse used gets one allocation.
3. If none does and split is **off**, or the total available across the store's warehouses is still short, the order is not created (`INSUFFICIENT_INVENTORY`, with the available quantity per warehouse in `metadata`), unless the store allows negative stock (§4.10): then whatever is missing is allocated to the highest-priority warehouse and its available stock goes negative.
4. The agent may change the allocations in the create-order drawer (a different warehouse, or with split on, different quantities per warehouse). Every warehouse used must be linked to the store (`INVENTORY_WAREHOUSE_NOT_LINKED` otherwise) and the quantities must add up to the line.

Example: a line asks for 10 units, warehouse A has 6 and warehouse B has 8 (14 together). With split **off**, no single warehouse covers 10, so the order is refused. With split **on**, A (first by priority) gives 6 and B gives 4: two allocations. If B alone had 12, it would serve the whole line even with split on (rule 1).

Order lifecycle effects (`OrdersService` calls `InventoryService`; nothing else writes levels). Every effect is applied **per allocation**:

| Order change | Inventory effect |
|---|---|
| created (`CONFIRMED`) | allocate, then `RESERVE` per allocation |
| items edited while `CONFIRMED` | release the line's allocations and allocate again (rules 1 to 4) |
| `SHIPPED` | `ISSUE` per allocation (stock leaves, the reservation is consumed) |
| `CANCELLED` before `SHIPPED` | `RELEASE` per allocation |
| `RETURNED` | optional `RETURN_IN` per allocation when the agent chooses "restock", into the same warehouse unless another is chosen |
| `DELIVERED` | none |

### 4.2 Movements are transactional and idempotent

Every stock change is one database transaction: lock the level row (`SELECT … FOR UPDATE`, creating it first when missing), validate, update `onHand`/`reserved`, insert the movement with `onHandAfter`/`reservedAfter`. By default stock never goes negative: a reservation, adjustment or issue that would do so is rejected (`INSUFFICIENT_INVENTORY`). A store can turn this off (§4.10). `InventoryService` methods take an optional transaction client so an order and its reservations commit or fail together. Movements caused by an order, transfer or count carry a deterministic `idempotencyKey` (for example `order:{orderId}:{lineId}:reserve`), so a retried request or job never applies twice. Two simultaneous orders for the last unit: exactly one succeeds.

### 4.3 Manual adjustments

`POST` adjustments take `warehouseId`, the item, a positive `quantity`, a direction (`ADJUSTMENT_IN` or `ADJUSTMENT_OUT`), a mandatory `reason`, an optional note and a client-generated `idempotencyKey` (UUID, like `Message.idempotencyKey`), so a double click or a retry never adjusts twice. Needs `INVENTORY_ADJUST`; audited as `INVENTORY_ADJUSTED`. Receiving stock (purchases are out of scope, so this is the way stock enters) uses `RECEIPT` with reason `opening_stock` or a note.

### 4.4 Low stock (configurable)

The alert is configured per product through `Product.lowStockThreshold`: empty (`null`) means no alert for that product, a number means "alert when available stock is at or below this quantity". A new product starts with the store's `StoreSettings.defaultLowStockThreshold` (empty by default, so no alerts until the owner sets one); changing the store default never touches existing products. The product form and the stock screen edit the threshold; a bulk edit from the stock screen sets it for the selected products.

After each movement that lowers availability, compare the product's total available stock across the store's warehouses with its threshold (a product with `null` is skipped). Crossing it downwards emits `INVENTORY_LOW` once; the alert re-arms when stock goes back above the threshold.

### 4.5 Transfers between warehouses

1. **Draft**: lines added or edited freely. Both warehouses must be active, different (`INVENTORY_TRANSFER_SAME_WAREHOUSE`), and **each line's store must be linked to both warehouses** (`INVENTORY_WAREHOUSE_NOT_LINKED`), otherwise stock would land where the store cannot sell it.
2. **Dispatch** (`INVENTORY_MANAGE_TRANSFERS`): per line a `TRANSFER_OUT` at the source (needs available stock, never reserved stock, whatever the negative-stock setting says: a physical shipment cannot exceed what is on the shelf). Status `IN_TRANSIT`. `TRANSFER_DISPATCHED` notifies the destination's receivers. In-transit quantity is the sum of open transfer lines; it is not a level column.
3. **Receive** (`INVENTORY_RECEIVE_TRANSFERS`): per line the received quantity, partial receipts allowed (cumulative never above the dispatched quantity). Each receipt writes `TRANSFER_IN` at the destination. When every line has received its full quantity the status becomes `RECEIVED`.
4. **Close with shortage**: when something will not arrive, the receiver closes the transfer choosing per line `WRITE_OFF` (the stock is lost, audited) or `RETURN_TO_SOURCE` (a `TRANSFER_IN` back at the source). Status `RECEIVED`.
5. **Cancel**: from `DRAFT` (nothing to undo) or from `IN_TRANSIT` (the dispatched quantity returns to the source with `TRANSFER_IN`).

### 4.6 Physical counts

1. **Create** a count for one warehouse, optionally limited to one store's products (`DRAFT`).
2. **Start** (`COUNTING`): the lines are generated from the current levels and `expectedQuantity` is snapshotted.
3. **Count**: staff enter `countedQuantity` per line, from a phone if needed. A count can go back from `REVIEW` to `COUNTING`.
4. **Submit** (`REVIEW`): variance per line = `countedQuantity - expectedQuantity`; `COUNT_AWAITING_APPLY` notifies the approvers.
5. **Apply** (`INVENTORY_APPLY_COUNTS`, `APPLIED`): for every line with a variance, a `COUNT_IN` or `COUNT_OUT` of the **variance**, never of "counted minus current". Sales and transfers that happened while counting are therefore not overwritten. Lines never counted are left untouched. If a variance would take a level below zero (sales happened during the count) and the store does not allow negative stock, apply stops with `INSUFFICIENT_INVENTORY` listing those lines, and the approver sends the count back to `COUNTING` to recount them. Audited as `COUNT_APPLIED`.

### 4.7 Warehouses

A warehouse with any `onHand > 0` cannot be deactivated (`INVENTORY_WAREHOUSE_HAS_STOCK`). Unlinking a store from a warehouse is allowed only when that store has no reserved stock there. A store with tracked products and no linked warehouse cannot create orders for them.

### 4.8 Reconciliation

`RECONCILE_INVENTORY` (a daily cron that enqueues one job per store) recomputes each level from the ledger and compares it with `InventoryLevel`. A mismatch increments `INVENTORY_RECONCILIATION_MISMATCHES`, is logged with the item and both values, and is never auto-corrected: the owner decides through a count or an adjustment. A level that is negative in a store that does not allow negative stock is reported the same way (with a distinct log field).

### 4.9 Deletions

A product or variant with non-zero stock, reserved stock, or lines in an open transfer or count cannot be deleted: deactivate it (`active = false`). A store cannot be deleted while it has stock or open transfer and count lines (orders already prevent it, `TDD_01 §4`).

### 4.10 Negative stock is a store setting

`StoreSettings.allowNegativeStock` (default **off**), edited in Settings → Inventory (`SETTINGS_EDIT`) and audited (`SETTINGS_CHANGED`). It is per store because catalogs are per store; levels are per item and warehouse, so it never affects another store.

| | Off (default) | On |
|---|---|---|
| Reserve on order creation | refused when no warehouse covers the line | always accepted; `reserved` may exceed `onHand` |
| `ISSUE`, `ADJUSTMENT_OUT` | refused if `onHand` would go below zero | allowed; `onHand` may go below zero |
| Available (`onHand - reserved`) | never below zero | may be negative and is shown as "oversold" |
| `INVENTORY_LOW` | fires when crossing the product's threshold, if it has one | same (a negative value is below any threshold) |
| `TRANSFER_OUT` | needs real available stock | **same: always needs real available stock** |

With split fulfillment also on, the shortfall of rule 3 goes to the highest-priority warehouse after the others have given what they have. Turning it off does not change data. Existing negative levels are reported by the reconciliation job (§4.8), and any new movement that would lower an already-negative level is refused until receipts or adjustments bring it back to zero or above.

---

## 5. Cache and events

`CacheKeys.product.inventory` (the per-product availability, `TDD_02 §3`) now holds the sum of available stock across the store's warehouses and is invalidated by `INVENTORY_MOVED`. Levels themselves are never cached: guards and reservations read the primary database (`TDD_08 §2.5`). Every movement emits `INVENTORY_MOVED` after its transaction commits, with the payload `{ storeId, productId, variantId, warehouseId, type, quantity }` (a superset of what the cache listener of `TDD_08 §1.3` reads).

---

## 6. API routes

All under `ApiRoutes`, with `AuthGuard`, `TenantGuard` and a permission decorator; organization-scoped ones follow §1.

| Group | Routes | Permission |
|---|---|---|
| `warehouses` (org) | list, create, by id, update, `PUT /warehouses/:id/stores` (the store links and priorities, replaced atomically in one transaction so the unique priority never conflicts) | view: `INVENTORY_VIEW`; write: `ORG_MANAGE_WAREHOUSES` |
| `inventory` (store) | `GET /inventory/levels` (filters: warehouse, product, low stock), `GET /inventory/movements`, `GET /inventory/kardex` (one item, running balance from `onHandAfter`), `POST /inventory/adjustments` | `INVENTORY_VIEW`; adjustments: `INVENTORY_ADJUST` |
| `transfers` (org) | list, create, by id, update (draft), `POST …/dispatch`, `POST …/receive`, `POST …/close`, `POST …/cancel` | `INVENTORY_MANAGE_TRANSFERS`; receive and close: `INVENTORY_RECEIVE_TRANSFERS` |
| `counts` (org) | list, create, by id, `POST …/start`, `PATCH …/lines`, `POST …/submit`, `POST …/apply`, `POST …/cancel` | `INVENTORY_MANAGE_COUNTS`; apply: `INVENTORY_APPLY_COUNTS` |

Transfer and count responses include only the lines of stores the caller belongs to (§1). Cursor pagination on every list (`TDD_08 §2.4`). The existing `ApiRoutes.products.inventory(id)` returns that product's levels per warehouse (read only, `INVENTORY_VIEW`).

---

## 7. UI

- **Settings → Inventory** (store scope, `TDD_09 §13`): the default low-stock threshold (empty = none), the negative-stock toggle (§4.10), with a clear warning that orders will be accepted without stock, and the split-fulfillment toggle (§4.1).
- **Store scope** (`/s/[storeId]/inventory`): Stock (by item and warehouse, available and reserved, low-stock filter), Movements (the kardex of an item) and the adjustment dialog.
- **Organization scope** (`/org/warehouses`, `/org/transfers`, `/org/counts`): warehouse list with store links and priority; transfer list and detail with the dispatch and receive flows; count list and detail.
- The receive and count screens are mobile-first (large inputs, one line per row): warehouse staff work from phones (`TDD_09 §16`). Camera barcode scanning is not part of this phase (§12).
- No emojis, Lucide icons, every string an i18n key, destructive actions follow `TDD_09 §11` (cancelling an in-transit transfer and applying a count need a confirmation).
- The create-order drawer (`TDD_09 §5.1`) shows each line's allocations (warehouse and quantity) and available stock per warehouse, and lets the agent change them.

---

## 8. Permissions, isolation and audit

- Every new resource enters `tests/security/tenant-isolation.spec.ts` in the same change: store-scoped ones (`InventoryLevel`, `InventoryMovement`, `OrderItemAllocation`) by `storeId`; organization-scoped ones (`Warehouse`, `StoreWarehouse`, `StockTransfer`, `StockCount`) with a cross-organization case, plus a case proving that line visibility is limited to the caller's stores.
- Every mutation is audited (§3) and every state change goes through the owning service, never `prisma.<model>.update`. Add a lint rule (`TDD_14 §6`, same kind as the `conversation.status` selector) that forbids writing `inventoryLevel` or `inventoryMovement` anywhere outside `libs/core/inventory`.
- `scripts/check-isolation-coverage.ts` is extended in Step 4.2 to list models carrying `organization_id` (not only `store_id`) and to fail when one is missing from the suite.
- Movements are a ledger: they are not subject to tenant retention settings (`TDD_05 §10`) and are never deleted by the platform cleanup jobs.

---

## 9. Tests

- **Unit:** the allocation algorithm (priority order, single-warehouse preference, split on and off, manual override), the transfer and count state machines, shortage handling, the count variance rule.
- **Concurrency (integration, real database):** two parallel reservations for the last unit (one fails); a retried movement with the same `idempotencyKey` applies once; parallel dispatches from the same source never drive stock negative.
- **Integration:** warehouse and link rules (§4.7), transfer end to end including partial receipt, count end to end with sales during the count, order lifecycle effects (§4.1), low-stock firing once.
- **Split fulfillment:** a single warehouse is preferred when one covers the line; with split on, a shortfall is served by priority across warehouses; with split off the same order is refused; an edited order re-allocates; cancel, ship and return act per allocation; allocation quantities always add up to the line.
- **Low stock:** no alert for a product without a threshold, one alert per downward crossing, re-armed after recovery, and a new product takes the store default.
- **Negative stock:** every rule in §4.10 in both modes, including that `TRANSFER_OUT` is refused with the setting on, and that turning the setting off leaves data untouched.
- **Reconciliation:** a forged level mismatch is detected and reported, never fixed.
- **Coverage:** `libs/core/inventory/` is a critical path with a 90% line threshold (`TDD_13 §1`, `§9`).

---

## 10. Where the code lives

`libs/core/inventory/` holds `InventoryService` (movement engine, reservations, reconciliation), the constants and the Zod schemas; it is `scope:core`, used by `apps/api` and `apps/worker` (the reconciliation job). `apps/api/src/modules/inventory/` holds the controllers for warehouses, levels, transfers and counts, and their services. `OrdersService` depends only on `InventoryService`.

---

## 11. Boundaries kept for later

`OrdersService` and the inventory module talk only through `InventoryService` (reserve, release, issue, restock, adjust). The future POS records sales as `ISSUE` movements with `referenceType` for a sale, and a future commerce provider (for example Shopify) replaces the implementation behind the same service, so neither needs a schema change here.

---

## 12. Not in this phase

Purchase orders and suppliers; lots, serial numbers and expiry dates; costing (average or FIFO); a backorder workflow (customer notification, supplier ETA; the negative-stock setting of §4.10 only lets orders through); barcode generation and camera scanning; bulk CSV import of opening stock (use adjustments); POS and cash register; inter-store sales of stock (catalogs are not shared); Shopify as an alternative provider.

---

## 13. How these rules can change after the MVP

- **Who may do what** is configurable: the permissions above are the defaults of the Admin, Supervisor, Agent and Viewer presets, and the owner can create custom roles (Step 1.4) with any mix, for example one that applies counts. No code change is needed.
- **Settings** (`allowNegativeStock`, `allowSplitFulfillment`, the low-stock defaults) are per store and can be changed at any time; turning one off never rewrites data (§4.10).
- **Additive later changes** (new columns or tables, no data migration): a low-stock threshold per warehouse, lots and expiry, costing, purchase orders and suppliers, and the POS recording sales as `ISSUE` movements (§11, §12).
- **Rules that are correctness choices, not preferences**, and that change only with a deliberate TDD revision: the count applies the variance, a transfer dispatch needs real available stock, and the movement ledger is append-only.

