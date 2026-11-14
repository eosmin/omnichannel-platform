# TDD 18 — Finance (ledger, accounts, taxes, purchases, fiscal documents)

> Part of the Omnichannel Commerce Platform TDD v1.2
> **MVP v1.2:** this file describes the finance module the owner asked for on 2026-11-10 and settled on 2026-11-14.
> Before implementing from it, read `MVP_TRIM_CHECKLIST.md` §11; where the two disagree, the checklist wins.
> Covers: the double-entry ledger, the chart of accounts, fiscal periods and closes, VAT, expenses, incomes and
> transfers, bank reconciliation by CSV, suppliers and purchase orders, the automatic entries of every business
> event, the fiscal document (DTE) port, reports, permissions, isolation and audit.
> This file **extends** `TDD_01 §4` (data model), `TDD_02` (constants), `TDD_16` (stock and costs) and
> `TDD_17 §4.15` (COD remittances). Where it changes a model or constant defined there, this file wins.
> Out of scope here (later phases): several currencies, accounts per store, FIFO and lots, direct bank
> connections, payroll, fixed assets and depreciation, budgets, a point of sale (§14).

**Status of this document:** design, written by Step 4B.1 for the owner's approval. **Nothing in it is legal or tax
advice.** Every rule that depends on Salvadoran law is marked **[ACCOUNTANT]**: it is the platform's best working
assumption, it is configurable, and the owner's accountant confirms or corrects it before the step that uses it
is built (§13 lists them all). No legal figure, form layout or schema of the tax authority is invented here.

---

## 1. Concepts and decisions

Owner's decisions (2026-11-10 and 2026-11-14), all settled:

| # | Decision |
|---|---|
| 1 | **Country:** El Salvador first, Colombia later. The module is **multi-country by configuration** (§3.1): chart template, tax regime and fiscal document provider are data and adapters, never branches in core. |
| 2 | **Currency:** USD only. The model leaves the way to several currencies without migrating data (§2.8). |
| 3 | **Organizations:** one (the owner's). The model is organization-scoped like `TDD_16`. |
| 4 | **Accounts:** shared by the whole organization in the MVP; **per store in Phase 2** with no data migration (§2.2). |
| 5 | **Accounting:** complete and formal. Double entry, chart of accounts, journal and general ledger, trial balance, income statement, balance sheet, VAT. |
| 6 | **Tax:** VAT 13 % **[ACCOUNTANT]**, one rate for every product, with an exempt flag and a configurable rate. Prices include VAT by default (final consumer), configurable per store (B2B itemizes). |
| 7 | **Costing:** weighted average now, FIFO later (`TDD_16`: the movement already stores `unitCostCents`). |
| 8 | **Permissions:** granular and separate (§9), administrators only at first. |
| 9 | **Closes:** monthly, with a lock (§5). |
| 10 | **Audit:** external audit **yes**: user and time on every entry, immutable, a hash chain, CSV export of the journal and the ledger (§2.5, §11). |
| 11 | **Fiscal documents (DTE):** **in the MVP** (mandatory in El Salvador **[ACCOUNTANT]**), as its own step after the ledger and the taxes, behind an exchangeable provider (§8). The certificate, the credentials and the exact format are owner and accountant debts. |
| 12 | **Everything configurable where possible:** accounts, mappings, tax rates, the moment a sale is recognized, the accounts of each payment method, the rounding, the periods. |

**Rule 12 decisions of this design** (the owner delegated the technical ones), each with the best rejected alternative:

- **The ledger is the source of truth for money; operational tables stay the source of truth for operations.** Orders,
  shipments, remittances and stock keep their own state. The ledger records what they did, one immutable entry per
  event, and never changes them. *Rejected:* computing balances from operational tables only (no audit trail, no
  formal books, no corrections).
- **Entries are posted after the business transaction commits, by a listener, with an idempotency key, and a daily
  sweep re-derives any source that has no entry (§6.1).** *Rejected:* posting inside `OrdersService`,
  `RemittancesService` or `InventoryService` transactions (couples orders to accounting, one missing account mapping
  would block a shipment, and it holds the numbering lock inside long transactions).
- **No closing entries at year end.** Reports are computed by date; a period close is a lock, not a set of
  entries. *Rejected:* income-summary closing entries (more entries, more ways to be wrong, and the accountant can
  still add one by hand as a manual entry).
- **Revenue and cost of goods are recognized when the order is delivered** (configurable, §6.2), not when it is
  created or shipped, because a collect-on-delivery parcel can be refused, and the returns of `TDD_17 §4.11` then
  reverse nothing. Goods in the hands of the carrier sit in an inventory-in-transit account.
- **The hash chain and the gapless entry number** make tampering detectable by an auditor with only the CSV.
  *Rejected:* trusting database permissions alone.

### 1.1 Scope: what the module is not

It is not a tax filing tool: it produces the data and the books (VAT report, sales and purchase books, trial
balance) for the accountant, who files. It does not connect to banks (CSV import only), does not run payroll, does
not depreciate assets and does not handle several currencies in the MVP.

---

## 2. Data model (Prisma, mapped names)

Every table is `snake_case` mapped like `TDD_01 §4`. All money is **whole USD cents** (`Int`, like every order
total) except stored balances, which are `BigInt` because a sum of cents passes the 32-bit ceiling of one line.

### 2.1 Scoping

| Resource | Scope column | Visible to |
|---|---|---|
| `FinanceSettings`, `LedgerAccount`, `AccountRoleMapping`, `PaymentMethodAccount`, `TaxRate`, `FiscalPeriod` | `organizationId` | members of any store of the organization holding the permission |
| `JournalEntry`, `JournalLine`, `AccountPeriodBalance`, `FinanceTransaction` | `organizationId` (lines also carry `storeId` as a **dimension**, nullable) | same |
| `Supplier`, `PurchaseOrder`, `PurchaseReceipt`, `SupplierPayment` | `organizationId` | same |
| `PurchaseOrderLine`, `PurchaseReceiptLine` | `organizationId` + `storeId` (the product's store) | only members of that store see the lines of that store, as `StockTransferLine` in `TDD_16` |
| `BankStatementImport`, `BankStatementLine`, `ReconciliationMatch`, `BankImportProfile` | `organizationId` | same |
| `FiscalIssuer`, `FiscalDocument` | `organizationId` (`FiscalDocument` also `storeId`) | same |

**Organization context without a new mechanism:** as `TDD_16 §1`. Organization-scoped routes still send `X-Store-Id`;
`TenantGuard` resolves the store's organization and the permission is read from the user's role in that store;
`organizationId` in a query always comes from the guard, never from the body or query string (`CLAUDE.md` rule 2).

### 2.2 The way to accounts per store (Phase 2)

`LedgerAccount.storeId` exists now, **nullable and held `NULL` by a CHECK** in the MVP. Phase 2 drops the CHECK and
the unique index becomes `(organization_id, coalesce(store_id, ''), code)`: no data moves. Every `JournalLine`
already carries `storeId` (the store of the order, the warehouse's owner or the expense's store), so a per-store
income statement is a filter on the ledger of the MVP with no new data. Reports by store are in the MVP (§10).

### 2.3 Chart of accounts and settings

```prisma
model FinanceSettings {
  organizationId        String   @id @map("organization_id")
  countryCode           String   @map("country_code")                 // ISO 3166-1 alpha-2, 'SV' now; picks the templates (§3.1)
  baseCurrency          String   @default("USD") @map("base_currency")  // CHECK = 'USD' in the MVP (§2.8)
  accountingStartDate   DateTime @map("accounting_start_date") @db.Date // events before it are never posted (§6.5)
  lockedThrough         DateTime? @map("locked_through") @db.Date       // last day of the last closed period; null = none
  nextEntryNumber       BigInt   @default(1) @map("next_entry_number")  // gapless counter, locked per post (§2.5)
  lastEntryHash         String?  @map("last_entry_hash")                // the chain head (§2.5)
  recognizeSaleOn       String   @default("delivered") @map("recognize_sale_on")  // SaleRecognition (§6.2)
  roundingAccountId     String?  @map("rounding_account_id")
  updatedAt             DateTime @updatedAt @map("updated_at")
}

model LedgerAccount {
  id             String  @id @default(uuid())
  organizationId String  @map("organization_id")
  storeId        String? @map("store_id")                 // NULL in the MVP (§2.2)
  code           String                                    // the accountant's numbering, unique per organization
  name           String                                    // plain data the accountant edits (the template seeds it, §3.1)
  type           String                                    // AccountType
  normalSide     String  @map("normal_side")               // NormalSide: derived from the type, stored for the CHECK
  parentId       String? @map("parent_id")
  isPostable     Boolean @default(true) @map("is_postable") // false for a header that only groups
  cashKind       String? @map("cash_kind")                  // CashKind: cash | bank | wallet; null for every other account
  isSystem       Boolean @default(false) @map("is_system")  // created by the template: cannot be deleted, can be renamed
  active         Boolean @default(true)
  currency       String  @default("USD")
  createdAt      DateTime @default(now()) @map("created_at")
  @@unique([organizationId, code])
  @@index([organizationId, type])
}

model AccountRoleMapping {          // which account each automatic entry posts to (§4)
  organizationId String @map("organization_id")
  role           String                 // AccountRole
  accountId      String @map("account_id")
  @@id([organizationId, role])
}

model PaymentMethodAccount {        // which account receives a payment method (§6.2); storeId null = the default
  id             String  @id @default(uuid())
  organizationId String  @map("organization_id")
  storeId        String? @map("store_id")
  paymentMethod  String  @map("payment_method")   // PaymentMethod (`CASH_ON_DELIVERY` is not listed: it goes to the carrier receivable)
  accountId      String  @map("account_id")
  @@unique([organizationId, storeId, paymentMethod])
}
```

An account with entries is **never deleted**, only deactivated; a system account cannot be deleted at all; a
header (`isPostable = false`) refuses lines; changing the `type` of an account that has entries is refused
(`FINANCE_ACCOUNT_TYPE_LOCKED`). Renaming and re-parenting are allowed and audited.

### 2.4 Fiscal periods

```prisma
model FiscalPeriod {
  id             String   @id @default(uuid())
  organizationId String   @map("organization_id")
  year           Int
  month          Int                                   // 1 to 12
  startsOn       DateTime @map("starts_on") @db.Date
  endsOn         DateTime @map("ends_on") @db.Date
  status         String   @default("open")              // PeriodStatus
  closedAt       DateTime? @map("closed_at")
  closedBy       String?  @map("closed_by")
  reopenedAt     DateTime? @map("reopened_at")
  reopenedBy     String?  @map("reopened_by")
  reopenReason   String?  @map("reopen_reason")
  closingHash    String?  @map("closing_hash")      // the head of the entry chain when it closed (§5.1)
  @@unique([organizationId, year, month])
}
```

Periods are created on demand (the open period and the next one), calendar months **[ACCOUNTANT]** (a fiscal year
that is not the calendar year is a template setting, not a code change).

### 2.5 The journal (immutable)

```prisma
model JournalEntry {
  id              String   @id @default(uuid())
  organizationId  String   @map("organization_id")
  number          BigInt                                   // gapless, per organization, from FinanceSettings.nextEntryNumber
  entryDate       DateTime @map("entry_date") @db.Date     // the accounting date; decides the period
  periodId        String   @map("period_id")
  type            String                                   // JournalEntryType (§4.2)
  sourceType      String?  @map("source_type")              // FinanceSourceType: order, shipment, remittance, ... ; null for manual
  sourceId        String?  @map("source_id")
  sourceDate      DateTime? @map("source_date")             // when the source event really happened (a late post keeps it)
  idempotencyKey  String   @map("idempotency_key")          // e.g. 'order:<id>:sale'; unique per organization
  reversesEntryId String?  @map("reverses_entry_id")        // set on the reversing entry only; the original is never touched
  memo            String?
  currency        String   @default("USD")
  totalCents      Int      @map("total_cents")              // sum of debits (= sum of credits)
  createdBy       String?  @map("created_by")               // user; null for the system (the listener), then `origin` says why
  origin          String                                    // EntryOrigin: user | system
  createdAt       DateTime @default(now()) @map("created_at")
  prevHash        String?  @map("prev_hash")                // hash of the previous entry of the organization
  hash            String                                    // sha256 over the canonical entry and its lines and prevHash (§11)
  lines           JournalLine[]
  @@unique([organizationId, number])
  @@unique([organizationId, idempotencyKey])
  @@index([organizationId, periodId])
  @@index([organizationId, sourceType, sourceId])
}

model JournalLine {
  id             String  @id @default(uuid())
  entryId        String  @map("entry_id")
  organizationId String  @map("organization_id")
  storeId        String? @map("store_id")                   // dimension (§2.2)
  accountId      String  @map("account_id")
  debitCents     Int     @default(0) @map("debit_cents")
  creditCents    Int     @default(0) @map("credit_cents")
  partyType      String? @map("party_type")                 // PartyType: supplier | carrier_connection | customer
  partyId        String? @map("party_id")                   // dimension for subledgers (payables, carrier receivables)
  taxRateId      String? @map("tax_rate_id")                // set on the lines that carry VAT
  memo           String?
  lineNo         Int     @map("line_no")
  @@index([organizationId, accountId])
  @@index([entryId])
}
```

Database rules (raw SQL in the migration, with its rollback, `CLAUDE.md` rule 4):

- **Append-only:** triggers raise on `UPDATE` and `DELETE` of `journal_entries` and `journal_lines` (the same
  mechanism as the movement ledger of `TDD_16`), and the application role has no such privilege (roles of Step 0.4).
- **Balanced:** a `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks, at commit, that the debits of an entry
  equal its credits and are positive; a `CHECK` makes each line exactly one of debit or credit (> 0).
- **Postable and open:** a trigger checks that each line's account is active and postable and that the entry's period
  is open (`FINANCE_PERIOD_CLOSED`); the service checks first so the error is the typed one, the trigger is the net.
- **Number and hash:** the entry number is taken under `SELECT ... FOR UPDATE` on `FinanceSettings` in the same
  transaction as the entry, so numbers have no gaps and the chain has one head. Postings of one organization are
  therefore serialized; that is by design at this volume and the lock is held only for the insert.
- **Balances:** `AccountPeriodBalance (organizationId, accountId, storeId, periodId, debitCents BigInt, creditCents BigInt)`
  is maintained in the same transaction with an upsert, and recomputed by the daily reconciliation (§11) against
  the lines. The trial balance and the balance sheet read it; the ledger of an account reads the lines.

**Corrections** are a reversing entry (`reversesEntryId`, every line swapped) plus, when needed, a new entry. An
entry that was reversed shows as such in the journal view (derived: some entry reverses it). A reversal is dated
in the open period when the original's is closed.

### 2.6 Transactions made by hand

```prisma
model FinanceTransaction {          // the operational header of what a person registers (§4.3)
  id             String   @id @default(uuid())
  organizationId String   @map("organization_id")
  storeId        String?  @map("store_id")            // the store it belongs to for reports, optional
  kind           String                                // FinanceTransactionKind: expense | income | transfer
  occurredOn     DateTime @map("occurred_on") @db.Date
  amountCents    Int      @map("amount_cents")         // total paid or received, tax included
  fromAccountId  String?  @map("from_account_id")      // the money source (expense, transfer)
  toAccountId    String?  @map("to_account_id")        // the money destination (income, transfer)
  categoryAccountId String? @map("category_account_id") // the expense or income account it is classified under
  supplierId     String?  @map("supplier_id")
  taxRateId      String?  @map("tax_rate_id")
  taxCents       Int      @default(0) @map("tax_cents")
  taxCreditable  Boolean  @default(false) @map("tax_creditable") // the VAT of an expense is input VAT only with a valid document [ACCOUNTANT]
  documentNumber String?  @map("document_number")      // the supplier's document number
  documentMediaId String? @map("document_media_id")    // the receipt, a Media of purpose `finance_document`
  memo           String?
  entryId        String   @unique @map("entry_id")     // the entry it produced; a void points to the reversal
  voidedByEntryId String? @map("voided_by_entry_id")
  createdBy      String   @map("created_by")
  createdAt      DateTime @default(now()) @map("created_at")
}
```

A transaction is never edited: **changing one voids it (reversal) and creates another** in one request, so the
journal tells the whole story.

### 2.7 Suppliers, purchase orders and bank reconciliation

```prisma
model Supplier {
  id String @id @default(uuid())  organizationId String @map("organization_id")
  name String  taxId String? @map("tax_id")  contactName String? @map("contact_name")  email String?  phone String?
  paymentTermsDays Int @default(0) @map("payment_terms_days")
  defaultPayableAccountId String? @map("default_payable_account_id")   // null = the role account
  active Boolean @default(true)  createdAt DateTime @default(now()) @map("created_at")
}

model PurchaseOrder {
  id String @id @default(uuid())  organizationId String @map("organization_id")
  number String                                       // per organization sequence, from a counter like the order number
  supplierId String @map("supplier_id")  warehouseId String @map("warehouse_id")
  status String                                       // PurchaseOrderStatus
  orderedOn DateTime? @map("ordered_on") @db.Date  expectedOn DateTime? @map("expected_on") @db.Date
  notes String?  createdBy String @map("created_by")  createdAt DateTime @default(now()) @map("created_at")
}
model PurchaseOrderLine {
  id String @id @default(uuid())  organizationId String  storeId String  purchaseOrderId String
  productId String  variantId String?
  quantity Int  receivedQuantity Int @default(0)
  unitCostCents Int @map("unit_cost_cents")           // before tax
  taxRateId String? @map("tax_rate_id")
}
model PurchaseReceipt {                               // one receiving event; also the supplier's bill
  id String @id @default(uuid())  organizationId String  purchaseOrderId String
  receivedOn DateTime @db.Date  supplierDocumentNumber String? @map("supplier_document_number")
  subtotalCents Int  taxCents Int  totalCents Int      // what is owed to the supplier
  entryId String @unique @map("entry_id")  createdBy String  createdAt DateTime @default(now())
}
model SupplierPayment {
  id String @id @default(uuid())  organizationId String  supplierId String
  purchaseReceiptId String?  paidFromAccountId String  amountCents Int  paidOn DateTime @db.Date
  reference String?  entryId String @unique  createdBy String  createdAt DateTime @default(now())
}
```

(`PurchaseReceiptLine`, with the stock movement id each line produced, follows `StockTransferLine`.)
`BankImportProfile`, `BankStatementImport`, `BankStatementLine` and `ReconciliationMatch` follow the shape of the
remittance import of `TDD_17 §4.15` (profile per account: delimiter, header row, decimal separator, date format,
column mapping; strict parsing; the file kept as `Media` of purpose `finance_document`). A match links a statement
line to a **journal line of the cash account**; the lines themselves are never touched.

### 2.8 The way to several currencies

Every entry carries `currency` and a `CHECK` pins it to `'USD'` in the MVP. Adding a currency later is additive:
columns `originalAmountCents`, `originalCurrency` and `exchangeRate` on the line, a rate table, and a revaluation
entry type; the amounts in the existing columns stay the base currency, so no data migrates.

---

## 3. Constants (additions to `TDD_02`)

All new, none inline (`CLAUDE.md` rule 1). File homes: enums in `libs/core/domain/finance-constants.ts`
(new), permissions in `libs/core/domain/auth/permissions.ts`, the rest in the files of `TDD_02 §1`.

```typescript
export enum AccountType { ASSET = 'asset', LIABILITY = 'liability', EQUITY = 'equity', INCOME = 'income',
                          COST_OF_SALES = 'cost_of_sales', EXPENSE = 'expense' }
export enum NormalSide { DEBIT = 'debit', CREDIT = 'credit' }   // asset, cost_of_sales, expense: debit; the rest: credit
export enum CashKind { CASH = 'cash', BANK = 'bank', WALLET = 'wallet' }
export enum PeriodStatus { OPEN = 'open', CLOSED = 'closed' }
export enum EntryOrigin { USER = 'user', SYSTEM = 'system' }
export enum PartyType { SUPPLIER = 'supplier', CARRIER_CONNECTION = 'carrier_connection', CUSTOMER = 'customer' }
export enum SaleRecognition { DELIVERED = 'delivered', SHIPPED = 'shipped' }
export enum FinanceTransactionKind { EXPENSE = 'expense', INCOME = 'income', TRANSFER = 'transfer' }
export enum PurchaseOrderStatus { DRAFT = 'draft', ORDERED = 'ordered', PARTIALLY_RECEIVED = 'partially_received',
                                  RECEIVED = 'received', CLOSED = 'closed', CANCELLED = 'cancelled' }
export enum FiscalDocumentStatus { DRAFT = 'draft', QUEUED = 'queued', SUBMITTED = 'submitted', ACCEPTED = 'accepted',
                                   REJECTED = 'rejected', VOIDED = 'voided' }
export enum FinanceSourceType { ORDER = 'order', SHIPMENT = 'shipment', REMITTANCE = 'remittance', RETURN = 'return',
                                INVENTORY_MOVEMENT = 'inventory_movement', PURCHASE_RECEIPT = 'purchase_receipt',
                                SUPPLIER_PAYMENT = 'supplier_payment', FINANCE_TRANSACTION = 'finance_transaction',
                                MANUAL = 'manual' }
```

Transition tables (enforced inside the owning service, like `OrderStatusTransitions`):

- Period: `OPEN → CLOSED`, `CLOSED → OPEN` only for the **latest** closed period and only through the reopen action.
- Purchase order: `DRAFT → ORDERED | CANCELLED`; `ORDERED → PARTIALLY_RECEIVED | RECEIVED | CANCELLED`;
  `PARTIALLY_RECEIVED → RECEIVED | CLOSED` (closing with a short quantity); `RECEIVED → CLOSED`; `CLOSED` and
  `CANCELLED` terminal. A purchase with a receipt cannot be cancelled, only closed.
- Fiscal document: `DRAFT → QUEUED → SUBMITTED → ACCEPTED | REJECTED`; `REJECTED → QUEUED` (retry after a fix);
  `ACCEPTED → VOIDED` (the invalidation event of the provider); `VOIDED` terminal.

**`AccountRole`** (the keys of `AccountRoleMapping`; the template maps each to a starter account, §3.1):
`CASH_DEFAULT`, `BANK_DEFAULT`, `INVENTORY`, `INVENTORY_IN_TRANSIT`, `RECEIVABLE_CARRIERS`, `CUSTOMER_ADVANCES`,
`PAYABLE_SUPPLIERS`, `PAYABLE_CARRIERS`, `VAT_OUTPUT`, `VAT_INPUT`, `SALES_REVENUE`, `SHIPPING_REVENUE`,
`SALES_DISCOUNTS` (contra income), `SALES_RETURNS` (contra income), `COST_OF_GOODS_SOLD`, `INVENTORY_LOSS`,
`INVENTORY_GAIN`, `CARRIER_FREIGHT_EXPENSE`, `CARRIER_COMMISSION_EXPENSE`, `COD_DIFFERENCES`, `OPENING_EQUITY`,
`ROUNDING`, `UNCATEGORIZED_EXPENSE`. A role without a mapping makes the posting that needs it **fail visibly**
(§6.1), never fall into a default.

Other additions (each in its constants file):

| Set | New entries |
|---|---|
| `JournalEntryType` | `MANUAL`, `OPENING_BALANCE`, `EXPENSE`, `INCOME`, `TRANSFER`, `SALE`, `SALE_SHIPMENT` (goods leave the warehouse), `SALE_RETURN`, `COD_REMITTANCE`, `COD_WRITE_OFF`, `PURCHASE_RECEIPT`, `SUPPLIER_PAYMENT`, `INVENTORY_ADJUSTMENT`, `REVERSAL` |
| `Permissions` | §9 |
| `Events` | `FINANCE_ENTRY_POSTED`, `FINANCE_ENTRY_REVERSED`, `FINANCE_PERIOD_CLOSED`, `FINANCE_PERIOD_REOPENED`, `FINANCE_POSTING_FAILED`, `PURCHASE_ORDER_RECEIVED`, `FISCAL_DOCUMENT_ACCEPTED`, `FISCAL_DOCUMENT_REJECTED` |
| `NotificationTypes` | `FINANCE_POSTING_FAILED` (to members holding `FINANCE_MANAGE_ACCOUNTS`; severity warning; in-app and push), `FISCAL_DOCUMENT_REJECTED` (to members holding `FISCAL_MANAGE`; severity warning) |
| `AuditActions` | `FINANCE_SETTINGS_CHANGED`, `FINANCE_ACCOUNT_CREATED`, `FINANCE_ACCOUNT_UPDATED`, `FINANCE_ACCOUNT_DEACTIVATED`, `FINANCE_ROLE_MAPPED`, `FINANCE_TAX_RATE_CHANGED`, `FINANCE_ENTRY_POSTED_MANUAL`, `FINANCE_ENTRY_REVERSED`, `FINANCE_TRANSACTION_VOIDED`, `FINANCE_PERIOD_CLOSED`, `FINANCE_PERIOD_REOPENED`, `FINANCE_EXPORTED`, `SUPPLIER_CREATED`, `SUPPLIER_UPDATED`, `PURCHASE_ORDER_CREATED`, `PURCHASE_ORDER_RECEIVED`, `PURCHASE_ORDER_CANCELLED`, `SUPPLIER_PAID`, `FISCAL_ISSUER_CHANGED`, `FISCAL_DOCUMENT_VOIDED` |
| `ErrorCodes` | `FINANCE_PERIOD_CLOSED`, `FINANCE_ENTRY_UNBALANCED`, `FINANCE_ACCOUNT_NOT_POSTABLE`, `FINANCE_ACCOUNT_INACTIVE`, `FINANCE_ACCOUNT_TYPE_LOCKED`, `FINANCE_ACCOUNT_HAS_ENTRIES`, `FINANCE_ROLE_NOT_MAPPED`, `FINANCE_BEFORE_START_DATE`, `FINANCE_ENTRY_ALREADY_REVERSED`, `FINANCE_REOPEN_NOT_LATEST`, `FINANCE_CLOSE_PENDING_POSTINGS`, `FINANCE_CLOSE_PREVIOUS_OPEN`, `FINANCE_CURRENCY_UNSUPPORTED`, `FINANCE_SETUP_REQUIRED`, `PURCHASE_ORDER_INVALID_STATUS_TRANSITION`, `PURCHASE_RECEIPT_EXCEEDS_ORDER`, `SUPPLIER_HAS_HISTORY`, `FISCAL_PROVIDER_NOT_CONFIGURED`, `FISCAL_DOCUMENT_IMMUTABLE`, `FISCAL_PROVIDER_REJECTED` |
| `JobNames` / `Schedules` | `POST_FINANCE_EVENT` (queue `default`; the listener's work), `RECONCILE_FINANCE` on `heavy-processing` (`'30 4 * * *'`: recompute balances, sweep sources with no entry, §11), `VERIFY_LEDGER_CHAIN` (`'0 5 * * 0'`), `SUBMIT_FISCAL_DOCUMENT` (retries with backoff, §8), `GENERATE_EXPORT` gets the kinds `FINANCE_JOURNAL`, `FINANCE_LEDGER`, `FINANCE_TRIAL_BALANCE`, `FINANCE_VAT` (no new job, as the media ZIP) |
| `MetricNames` | `FINANCE_UNPOSTED_SOURCES: 'platform_finance_unposted_sources'` (gauge), `FINANCE_POSTING_FAILURES: 'platform_finance_posting_failures_total'`, `FINANCE_BALANCE_MISMATCHES: 'platform_finance_balance_mismatches_total'`, `FINANCE_CHAIN_BREAKS: 'platform_finance_chain_breaks_total'` |
| `ApiRoutes` | the `finance`, `suppliers`, `purchase-orders`, `fiscal` groups in §12 |
| `AppPaths` | `org.finance`, `org.finance.accounts`, `org.finance.journal`, `org.finance.periods`, `org.finance.reports`, `org.suppliers`, `org.purchaseOrders`, `org.fiscal` |
| `QueryKeys` | `finance.accounts`, `finance.balances`, `finance.entries`, `finance.periods`, `finance.reports`, `suppliers.all`, `purchaseOrders.all`, `fiscal.documents` |
| `ClientUploadPurposes` | `finance_document` (receipts and statements; jpeg, png, webp, PDF, CSV for statements; scanned; the parent is a finance transaction, a purchase receipt or a statement import of the organization) |
| "Prisma column → enum" table (`TDD_02 §5`) | rows for every `String` column above that holds one of these enums |
| `DestructiveActionTiers` (`TDD_09 §11.1`) | HIGH: "Close a period", "Reopen a period", "Post a manual entry", "Reverse an entry", "Void a fiscal document" |
| `PluginScopes` | none: finance is not exposed to plugins in the MVP (§14) |

### 3.1 Templates: country by configuration

A **finance template** is data in `libs/core/finance/templates/<country>.ts`: the starter chart of accounts (names in
the languages of the country), the `AccountRole` → account code map, the tax regimes (`TaxRate` seeds with their
accounts), the document types the country's fiscal provider declares, and the default period calendar. Choosing a
country at setup seeds the organization **once**; from then on everything is the organization's own data, editable.
`SV` ships with the module; `CO` is a second file later, with no change to the ledger. The seeded names are the
owner's data (like a product's name), not interface copy, so rule 6 does not apply to them; every label the interface
draws around them (types, roles, statuses) is an i18n key.

**Starter chart for El Salvador [ACCOUNTANT]:** a conventional trading business chart, numbering 1 assets, 2
liabilities, 3 equity, 4 income, 5 cost of sales, 6 expenses. The owner's accountant adjusts names and codes before
the first real entry; the design only needs the roles of §3 to be mapped. Cash (cash box, petty cash), banks
(one account per bank account), digital wallets, accounts receivable from carriers (COD in transit), inventory,
inventory in transit, VAT credit, advances to suppliers; accounts payable to suppliers and to carriers, VAT debit,
customer advances, taxes payable; capital, retained earnings, opening balances; product sales, shipping income,
discounts and returns on sales (contra), other income; cost of goods sold; expenses by nature (freight, carrier
commissions, bank fees, marketing, rent, services, payroll, taxes and fees, inventory losses, COD differences,
rounding, uncategorized).

---

## 4. The entries

### 4.1 Rules every entry follows

1. Debits equal credits, in whole cents; an entry has at least two lines.
2. The date decides the period; an entry dated in a closed period is refused (`FINANCE_PERIOD_CLOSED`). An
   **automatic** posting whose source event happened in a closed period (a late carrier file) is dated the first
   day of the open period and keeps `sourceDate` (§5.2).
3. An entry is never changed: reversed and re-posted (§2.5).
4. The idempotency key makes a repeat harmless: `order:<id>:sale`, `shipment:<id>:sent`, `remittance:<id>:confirm`,
   `remittance:<id>:void`, `return:<id>:restock`, `movement:<id>:adjust`, `receipt:<id>:receive`,
   `payment:<id>:pay`, `transaction:<id>:record`. A key that exists and has a **different** content is a bug and
   raises `FINANCE_ENTRY_UNBALANCED`-class alert, never a silent overwrite.
5. Lines of a subledger carry a party (`supplier`, `carrier_connection`) so "who owes whom" is a query, not a table.

### 4.2 Automatic entries by event

Notation: **Dr** debit, **Cr** credit, accounts by **role** (§3). `net` is the amount without VAT. Amounts come from
the operational rows, never from the client. Where the order is delivered, `recognizeSaleOn = delivered` (default).

| # | Event (source) | Entry |
|---|---|---|
| E1 | **Payment recorded as paid before delivery** (`Order.paymentStatus` becomes `PAID`; method cash, transfer, card or other) | Dr the account of that payment method (`PaymentMethodAccount`) · Cr `CUSTOMER_ADVANCES` (the order's total). |
| E2 | **Goods leave the warehouse** (order `SHIPPED`, the `ISSUE` movements with their `unitCostCents`) | Dr `INVENTORY_IN_TRANSIT` · Cr `INVENTORY`, valued at the cost the movements carry (cost x quantity per allocation). Skipped when `recognizeSaleOn = shipped` (E3 then also posts the cost, see below). |
| E3 | **Sale recognized** (order `DELIVERED`) | Dr by how it is collected: **cash on delivery** → `RECEIVABLE_CARRIERS` (party: the carrier connection) for the total the carrier must collect; **already paid** → `CUSTOMER_ADVANCES` (clears E1); **unpaid and not COD** (credit sale to a customer, if ever offered) → a receivable account, not built in the MVP (§14). Cr `SALES_REVENUE` (net of the lines, before discount), Cr `SHIPPING_REVENUE` (net of the shipping fee), Cr `VAT_OUTPUT` (the tax), Dr `SALES_DISCOUNTS` (the discount, net). Then **cost**: Dr `COST_OF_GOODS_SOLD` · Cr `INVENTORY_IN_TRANSIT` (the value of E2; with `shipped` recognition, Cr `INVENTORY` directly). |
| E4 | **Carrier charges for a delivered collect-on-delivery or sender-paid guide** (the same event as E3; amounts from `Shipment.carrierCostCents`, else `carrierRateCents`, and `commissionBps`, `TDD_17 §4.15`) | Dr `CARRIER_FREIGHT_EXPENSE` (the guide's cost, only when the sender pays) · Dr `CARRIER_COMMISSION_EXPENSE` (the commission, whoever pays the guide) · Cr `PAYABLE_CARRIERS` (party: the carrier connection). VAT on these charges follows the carrier's own document **[ACCOUNTANT]**; until then they are posted gross with no input VAT. |
| E5 | **COD remittance confirmed** (`RemittancesService`, one entry per remittance, lines per shipment) | Dr the **account the owner chose** on the confirm screen (default `BANK_DEFAULT`) for the amount the carrier **reported** · Dr `PAYABLE_CARRIERS` for the fee it **kept** (the fee of the file, else the estimate of E4) · Cr `RECEIVABLE_CARRIERS` for the **gross amount** of every matched line. A line with a difference (`DISCREPANCY`): the receivable is cleared only for what was reported plus what was kept, **the rest stays open in `RECEIVABLE_CARRIERS`** and the shipment stays matchable by a later remittance. When the file's fee differs from E4's estimate, the difference goes to `CARRIER_COMMISSION_EXPENSE` (the file replaces the estimate, `TDD_17 §4.15`). |
| E6 | **Remittance voided** (`remittance.voided`) | The reversal of E5 (a reversing entry, §2.5). |
| E7 | **A discrepancy written off by hand** (a person chooses "write off the difference" on a `DISCREPANCY` shipment; permission `FINANCE_MOVE_MONEY`) | Dr `COD_DIFFERENCES` · Cr `RECEIVABLE_CARRIERS`. |
| E8 | **Return restocked** (`return.received` with restock; `RETURN_IN` movement at its cost) and the order was already recognized | The reversal of the revenue side (Dr `SALES_RETURNS`, Dr `VAT_OUTPUT`, Cr the refund destination: a cash or bank account when money goes back, else `CUSTOMER_ADVANCES` or `RECEIVABLE_CARRIERS` if the carrier never remitted it), and Dr `INVENTORY` · Cr `COST_OF_GOODS_SOLD` for the restocked cost. A return before delivery (refused COD parcel): Dr `INVENTORY` · Cr `INVENTORY_IN_TRANSIT`, no revenue to reverse. A refund or an exchange gets its own fiscal credit note (§8). |
| E9 | **Stock adjustment, count variance, transfer shortage written off** (`ADJUSTMENT_OUT`, `COUNT_OUT`, transfer write-off) | Dr `INVENTORY_LOSS` · Cr `INVENTORY` at the average cost of the movement. The **in** side (`ADJUSTMENT_IN`, `COUNT_IN`): Dr `INVENTORY` · Cr `INVENTORY_GAIN`. `OPENING_STOCK` adjustments: Dr `INVENTORY` · Cr `OPENING_EQUITY`. A transfer between warehouses posts nothing (same asset, same organization). |
| E10 | **Purchase received** (`PurchaseReceipt`, the stock goes up through `InventoryService.receive` with `unitCostCents`) | Dr `INVENTORY` (net cost of the goods) · Dr `VAT_INPUT` (the input tax, if creditable [ACCOUNTANT]) · Cr `PAYABLE_SUPPLIERS` (party: the supplier). |
| E11 | **Supplier paid** (`SupplierPayment`) | Dr `PAYABLE_SUPPLIERS` · Cr the account the owner chose (cash, bank or wallet). Partial payments allowed; a payment above the open balance is refused. |
| E12 | **Expense, income, transfer** registered by a person (§2.6) | Expense: Dr the category account · Dr `VAT_INPUT` (if creditable) · Cr the source account. Income: Dr the destination account · Cr the category account · Cr `VAT_OUTPUT` (if the income carries tax). Transfer: Dr the destination · Cr the source (both cash-kind accounts, distinct). |
| E13 | **Manual entry** (an accountant's adjustment, opening balances) | Free lines, at least two, balanced, with a required memo; permission `FINANCE_POST_MANUAL`; HIGH-tier confirmation. |

**Order edits and cancellations.** An order cancelled **before** the entry exists posts nothing. A change after
recognition (rare: a status change cannot reverse a `DELIVERED` order except through a return, `TDD_17 §4.11`) is
always a return or a manual reversal; nothing mutates a posted entry.

**Weighted average.** The cost of every inventory entry is the cost the **movement** carries, which `InventoryService`
already computes from the average at the moment (`TDD_16`). The ledger never recomputes a cost: it trusts the
movement and the daily reconciliation compares `INVENTORY` against `InventoryLevel.valueCents` (§11). FIFO later
changes how `InventoryService` fills `unitCostCents` and nothing here.

### 4.3 Registering by hand

Expenses, incomes and transfers are created through `FinanceTransaction` (§2.6), which posts E12 in the same
transaction. The **category** is an account of type expense (or income): the chart is the list of categories, so
there is no second list to keep in agreement. A receipt can be attached (`finance_document`). Registering needs
`FINANCE_MANAGE_TRANSACTIONS`; a transfer or any movement of cash between accounts needs `FINANCE_MOVE_MONEY`.

### 4.4 Bank reconciliation by CSV

A statement CSV of a bank or wallet account is imported through a saved profile. Each statement line is matched,
deterministically (amount equal, date within a configurable window, reference contains), to a **cash-kind journal
line of that account** that is not matched yet; the matches are suggestions the person confirms, one by one or all
the exact ones at once. An unmatched statement line offers "register it": a prefilled expense, income or transfer.
A reconciled line is stored in `ReconciliationMatch`, so the immutable lines carry no mutable flag. The report
"account balance vs statement balance" shows the difference. There is **no AI** and no bank connection.

---

## 5. Periods and closes

### 5.1 Close

`POST /finance/periods/:id/close` (`FINANCE_CLOSE_PERIODS`, HIGH-tier confirmation, audited). Preconditions, each its
own error:

1. The previous period is closed (`FINANCE_CLOSE_PREVIOUS_OPEN`): closes are in order.
2. **No posting is pending or failed** for any source dated in the period (`FINANCE_CLOSE_PENDING_POSTINGS`): the
   sweep of §6.1 runs first, so the close cannot happen over an order that has no entry.
3. The trial balance of the period is balanced (always true by construction; the check is the safety net, and a
   failure is a `FINANCE_BALANCE_MISMATCHES` incident).
4. The period has ended (a period cannot be closed before its last day).

A **warning, not a block:** a cash-kind account with unreconciled lines, a fiscal document still `QUEUED` or
`REJECTED` in the period. Closing sets `status = CLOSED`, `FinanceSettings.lockedThrough`, and stores the balance
of every account of the period (`AccountPeriodBalance` already holds it; the close freezes a copy of the hash chain
head in the period row for the auditor, `FiscalPeriod.closingHash`, added in the same migration).

### 5.2 What the lock does

- No entry is accepted dated in a closed period, from any route, the listener or a manual entry (service check plus
  trigger).
- A **late automatic posting** (a remittance of last month confirmed this month, a return received after the close)
  is dated in the open period and keeps its `sourceDate`; the report of the closed month does not change, and the
  difference is visible as "late postings" in the period view. This is the usual practice and is configurable only
  as "post to the open period" (the alternative, refusing, would leave the source unposted forever).
- Inputs the ledger does not own (an order's date, a remittance's date) are **not** blocked by the lock: operations
  never stop because a month closed.

### 5.3 Reopen

Only the **latest** closed period, with the reason typed, HIGH-tier confirmation and `FINANCE_CLOSE_PERIODS`;
audited with who and why; an earlier closed period is never reopened (`FINANCE_REOPEN_NOT_LATEST`). The reopen
clears `lockedThrough` back one period and the next close recomputes the frozen hash.

---

## 6. How events reach the ledger

### 6.1 The listener, the key and the sweep

Source modules publish their existing events (`Events.ORDER_STATUS_CHANGED`, `REMITTANCE_CONFIRMED`,
`REMITTANCE_VOIDED`, `RETURN_RECEIVED`, `INVENTORY_MOVED` for the kinds that matter, `PURCHASE_ORDER_RECEIVED`...).
A listener in `apps/api` enqueues `POST_FINANCE_EVENT` (queue `default`) with the source and the event kind.
The job loads the **current** rows, builds the entry with the pure rules of `libs/core/finance`, and posts it
under its idempotency key. It is safe to run twice and to run late.

- **Failure is visible, never silent:** a missing role mapping, a missing price or an account that is inactive
  makes the job record `FinancePostingFailure (organizationId, sourceType, sourceId, reason, attempts)`,
  raise `FINANCE_POSTING_FAILED` (event, metric, notification to who can fix it), and the close refuses until it
  is resolved. Fixing the mapping and pressing "post again" (or the sweep) posts it.
- **The sweep** (`RECONCILE_FINANCE`, daily and before every close) walks the sources that **should** have an entry
  and have none: delivered orders, confirmed and voided remittances, received returns, stock movements of the
  adjustment kinds, purchase receipts, supplier payments. It enqueues the missing ones. An event lost to a crash
  between the commit of the source and the publish therefore costs at most one day, and the gauge
  `FINANCE_UNPOSTED_SOURCES` says so.
- A source dated **before `accountingStartDate`** is never posted and is not "unposted" (§6.5).

### 6.2 What a payment method means

`PaymentMethodAccount` says where each method's money lands (cash in the cash box, transfer in a bank account, card
in a bank or wallet account, other in a configurable account; a store may override the default). `CASH_ON_DELIVERY`
is not a destination: the money is the carrier's until a remittance brings it (E3 → E5). **Sale recognition** is
`FinanceSettings.recognizeSaleOn`: `delivered` (default **[ACCOUNTANT]**: it should match the moment the fiscal
document is issued) or `shipped`.

### 6.3 Idempotency across reversals

A reversal has its own key (`remittance:<id>:void`). Confirming, voiding and confirming again produces three entries
with three keys that carry a counter (`...:confirm:2`), so the history is the journal's.

### 6.4 Rounding

Every amount is whole cents. Line tax is computed per line, half up (§7); the order tax is the sum of its line
taxes (so the entry and the document agree); a cent that cannot be placed goes to `ROUNDING`. A remittance line
whose cents differ by the carrier's own rounding is an existing open question of the remittances (`TDD_17`, plan 4.15
(c2)); the ledger records what the confirm recorded.

### 6.5 History before the module

`accountingStartDate` is set at setup (default: the first day of the month of the setup). Events before it are
not backfilled: the accountant enters **opening balances** as a manual entry of type `OPENING_BALANCE` dated the day
before, and the platform stock value and the open carrier receivables are shown beside it so the accountant can use
them. *Rejected:* replaying history (the cost and the tax of old orders were never recorded, so the entries would
be invented).

---

## 7. VAT

- **`TaxRate (organizationId, code, name, rateBps, kind, outputAccountId, inputAccountId, active, isDefault)`**: `rateBps`
  is basis points (13 % is `1300`), no float ever holds a percent. `kind` is `vat` in the MVP; the field is there
  for a country with other taxes. The default rate is 1300 **[ACCOUNTANT]**.
- **Product treatment:** `Product.taxTreatment` (`taxed`, `exempt`, `not_subject`; default `taxed`) and an optional
  `taxRateId` for a product with another rate. Additive migration on `products` with its rollback, store-scoped like
  the product.
- **Prices include VAT by default** (`StorePreferences finance.pricesIncludeTax`, `true`; false for a B2B store).
  Included: `tax = round_half_up(lineTotal x rate / (10000 + rate))`, `net = lineTotal - tax`. Not included: the price
  is the net and `tax = round_half_up(net x rate / 10000)`; the **customer total changes** in that mode, so the order
  total of `TDD_17 §4.13` includes the tax. The shipping fee is taxed at the default rate unless the carrier's
  charge is declared exempt **[ACCOUNTANT]**.
- **Snapshot on the order** (additive migration on `orders` and `order_items`): `taxCents`, `pricesIncludeTax` on
  the order; `taxRateBps`, `taxCents` on each item. The tax of an order is **fixed at creation** like the
  line prices: a later change of the rate never rewrites a posted sale. Orders created before the columns exist
  have `null` and are taxed at posting time with the current rule, flagged `estimated` in the entry memo.
- **Retentions and perceptions [ACCOUNTANT]:** El Salvador has withholding rules for some buyer categories and
  advance tax payments on income. They are **not modelled** until the accountant says which apply: the ledger
  already has the accounts to receive them (a withholding is a debit to an asset account on the sale), and the
  roles are added by that decision, not guessed here.
- **The VAT report** (`FINANCE_VIEW`): by period and by rate, output (sales, returns), input (purchases, expenses
  with a creditable document), the balance to pay or carry forward, as a screen and a CSV. The **legal books**
  (sales to final consumers, sales to taxpayers, purchases) are the same data in the format the accountant gives;
  the layout is **[ACCOUNTANT]** and is built from the confirmed format in the reports step.

---

## 8. Fiscal documents (DTE): an exchangeable provider

The authority requires an electronic document for each sale **[ACCOUNTANT]**. The platform cannot invent its
format, signature or transmission rules, so core owns **the lifecycle and the link to the ledger** and a
**provider** owns everything legal and country-specific.

### 8.1 The port (`libs/fiscal/sdk`, new, same family as `libs/carriers/sdk`)

```typescript
export interface FiscalDocumentProvider {
  readonly id: string;                          // owned by the provider package, never named in core
  readonly countryCode: string;
  readonly manifest: FiscalProviderManifest;     // document types, required issuer fields, required customer fields
  validateIssuer(issuer: FiscalIssuerInput): Promise<IssuerCheck>;      // credentials and certificate readable
  build(input: FiscalBuildInput): Promise<BuiltDocument>;               // pure: order/return + issuer -> document JSON
  submit(built: BuiltDocument, ctx: ProviderContext): Promise<SubmitResult>;   // sign, send, return the authority's answer
  void(doc: StoredFiscalDocument, reason: string, ctx: ProviderContext): Promise<VoidResult>; // the invalidation event
  contingency?: ContingencyPolicy;               // what the provider does when the authority is down
}
```

Core never sees a signature algorithm, a control number format or an endpoint. The provider package declares
the **document types** it issues (for example a consumer invoice, a tax credit invoice, a credit note, in the
authority's own names), which fields it needs from the issuer and from the customer, and the mapping from a
sale to a type (a rule the provider evaluates from the customer's fiscal data). Adding Colombia is another package
(`libs/fiscal/co`) and a template, with no change to core. *Proposal for the owner (not applied here, because it
changes `CLAUDE.md`):* extend rule 13 with a `validate:fiscal-agnostic` ratchet like the channel and carrier ones,
so no core file ever names a provider or a country's document.

**The simulator.** Like the `local` carrier, `libs/fiscal/simulator` is a provider that builds a plausible document,
"signs" it with a fake key and answers accepted or rejected by rules the tests choose (including contingency,
timeouts and an invalidation). The whole step (lifecycle, queue, immutability, credit notes, screens, contract
suite) is built and tested against it **before** the owner has any credential; the real provider package only has to
pass the same provider contract suite. The simulator is registered in development and test only, never in production.

### 8.2 Data

```prisma
model FiscalIssuer {                // the legal entity that issues (the organization), one row
  organizationId String @id @map("organization_id")
  providerId     String @map("provider_id")
  legalName String @map("legal_name")  taxId String @map("tax_id")  registrationId String? @map("registration_id")
  address Json  activityCode String? @map("activity_code")  establishmentCode String? @map("establishment_code")
  environment    String                              // FiscalEnvironment: sandbox | production
  credentialsEncrypted String @map("credentials_encrypted")   // API user, password, signing certificate and its password: AES-GCM like the carrier credentials (`TDD_17 §4.1`), never returned, never logged
  updatedAt DateTime @updatedAt
}
model FiscalDocument {
  id String @id @default(uuid())  organizationId String  storeId String
  orderId String?  returnId String?  journalEntryId String? @map("journal_entry_id")   // the sale or the return entry it belongs to
  documentType String @map("document_type")           // a type the provider's manifest declares
  status String                                        // FiscalDocumentStatus
  externalNumber String? @map("external_number")        // the number the authority/provider assigned
  providerData Json?                                    // provider-specific fields (generation code, control number, seal, ...): opaque to core
  builtPayloadMediaId String?  responseMediaId String?  // the document and the answer kept as Media (the legal evidence)
  customerSnapshot Json                                  // name, tax id, address at issue time
  totalCents Int  taxCents Int
  rejectionReason String?  attempts Int @default(0)
  issuedAt DateTime?  createdAt DateTime @default(now())
  @@index([organizationId, orderId])
}
```

### 8.3 Flow

On the sale event (E3) core creates a `FiscalDocument` in `QUEUED` and enqueues `SUBMIT_FISCAL_DOCUMENT`; the
provider builds, signs and submits it. `ACCEPTED` stores the external number and the evidence and the order shows
it; `REJECTED` keeps the authority's reason, raises `FISCAL_DOCUMENT_REJECTED` and waits for a person to fix the
customer data or the configuration and retry. **An accepted document is immutable** (`FISCAL_DOCUMENT_IMMUTABLE`);
it is cancelled only by the provider's invalidation (`VOIDED`, HIGH-tier, audited), and a return issues a **credit
note** document linked to the original. The document and the entry are linked by `journalEntryId` and never by
copying amounts, and a daily check compares the document's total and tax against the entry's (§11). A provider
that is down uses its declared contingency; the platform keeps the document `QUEUED` and retries with backoff
(`TDD_07`). **What the legal documents need that the platform does not know yet** is §13.

---

## 9. Permissions, isolation and audit

### 9.1 Permissions

| Permission | Grants |
|---|---|
| `FINANCE_VIEW` | balances, the reports, the VAT report, the periods (no entry detail) |
| `FINANCE_VIEW_JOURNAL` | the journal, the ledger of an account, one entry with its lines and source |
| `FINANCE_MANAGE_TRANSACTIONS` | register, void and attach receipts to expenses and incomes |
| `FINANCE_MOVE_MONEY` | transfers between accounts, supplier payments, write-offs of a COD difference, the remittance destination account |
| `FINANCE_MANAGE_PURCHASES` | suppliers, purchase orders and receiving them |
| `FINANCE_RECONCILE` | import a statement and confirm matches |
| `FINANCE_MANAGE_ACCOUNTS` | chart of accounts, role mappings, payment method accounts, tax rates, finance settings, post failed entries again |
| `FINANCE_POST_MANUAL` | manual entries and reversals |
| `FINANCE_CLOSE_PERIODS` | close and reopen |
| `FINANCE_EXPORT` | the CSV exports of the journal and the ledger |
| `FINANCE_VIEW_CARRIER_FEES` | read the commission and the rates of a carrier connection (closes debt (c3)(i) of Step 4.15: `shipping:view` stops showing them) |
| `FISCAL_VIEW` | read fiscal documents |
| `FISCAL_MANAGE` | issuer settings and credentials, retry, void |

The Admin preset holds all of them (`RolePresets[ADMIN]` is `Object.values(Permissions)`, so a name added to
`libs/core/domain/auth/permissions.ts` reaches it with no other edit); **no other preset holds any** in the MVP, so
only administrators touch money. `PRODUCTS_VIEW_COST` (products, `TDD_16`) stays as it is.

**Assignable to custom roles (verified in the code, 2026-11-14).** The roles of Step 1.4 and the editor of Step 3.6
(`team-role-dialog.tsx`) already take their list from the catalog: `permissionGroups()` in
`apps/web/lib/settings/permission-groups.ts` builds the matrix from `Object.values(Permissions)`, grouped by the
part of the name before the colon, so `finance:*` and `fiscal:*` appear as two new groups with **no change to the
editor**; the api accepts a role's permission only if it is in the catalog (`isPermission` in
`tenant-context.ts`), so a custom role can hold any mix of them. What each finance step adds to make that real:
(1) the names in the catalog, the i18n labels of the group and of each action (the matrix reads them by key),
(2) the prefixes `finance:` and `fiscal:` in `PermissionsOfUnbuiltAreas` until the step that gives a permission its
reader lands (`permission-usage.spec.ts` refuses a permission that is neither read nor listed), removing each name
from the list in the step that reads it, (3) a test that a custom role holding only `FINANCE_VIEW` can read the
balances and cannot read the journal, post, move money or close (one case per permission in the API suites), and
(4) the permission is read **per store membership** like `TDD_16 §1`: a custom role gives it in the stores where
the person holds that role. A member who holds a finance permission in one store of the organization may use it on
the organization's ledger, because the ledger is organization-scoped (the owner is the only organization; for a
second one the rule is the same). Custom roles can mix them (`TDD_16 §13`), for example a bookkeeper with
`FINANCE_VIEW`, `FINANCE_VIEW_JOURNAL`, `FINANCE_MANAGE_TRANSACTIONS` and `FINANCE_RECONCILE` but not
`FINANCE_MOVE_MONEY`. Segregation of duties: the person who registers a supplier payment can be a different role
from the one who closes the month.

### 9.2 Isolation and writes

- Every new resource joins `tests/security/tenant-isolation.spec.ts` in the same change that introduces it:
  organization-scoped ones with a cross-organization case, the line tables with the case that a user sees only the
  lines of the stores they belong to, and the cases that **no route reads or writes** an entry of another
  organization by id.
- `scripts/check-isolation-coverage.ts` already lists organization-scoped models (Step 4.2): the new models are added.
- **Only `libs/core/finance` writes `journalEntry`, `journalLine`, `accountPeriodBalance` and the counter**, enforced
  by a lint rule of the same kind as the inventory one (`TDD_14 §6`), and by the database (append-only triggers and
  the role of Step 0.4).
- The ledger is **not subject to tenant retention** (`TDD_05 §10`) and no cleanup job deletes it, like the
  movement ledger.
- **Customer data in fiscal documents** (name, tax id, address) is customer data: encrypted at rest as the platform
  does for such fields, never logged, redacted in errors (the redaction list of `TDD_04` gains the fiscal fields),
  and exported only through the audited exports.
- Credentials and certificate: stored encrypted, shown never, rotated by replacing; their change is audited with
  the field names only.

### 9.3 Audit

Every mutation writes an audit row (§3); the entry itself is the audit of the money (user, time, source, hash).
The external auditor's package (§11) is the journal and ledger CSVs plus the verification of the chain.

---

## 10. Reports

Computed from `AccountPeriodBalance` and the lines, always as of a date or a period, optionally **by store**
(the line dimension), never from operational tables, except the product margin below.

| Report | Content |
|---|---|
| Balances by account | each account's balance at a date; cash-kind accounts highlighted |
| Trial balance | debits and credits by account for a period; must balance |
| General ledger | the lines of one account, with running balance, filter by date, party and store |
| Journal | every entry of a period with its lines, source, user, hash |
| Income statement | income, cost of sales, gross margin, expenses, net result, by period, by store |
| Balance sheet | assets, liabilities, equity (including the result of the period) at a date |
| Cash flow | movement of the cash-kind accounts by source type (sales collected, remittances, purchases paid, expenses, transfers), a direct-method view |
| Payables and receivables | what is owed to each supplier and carrier (by party dimension), with age |
| VAT | §7 |
| Margin by product | from the order lines net of tax and the `ISSUE` movement costs; the totals **reconcile** with the ledger's revenue and cost of goods (a test) |

Exports are CSV through `GENERATE_EXPORT` (`TDD_07`), audited (`FINANCE_EXPORTED`), with the formula-injection
protection the existing exports use; the journal export has one row per line with the entry number, date, type,
source, user, hash and previous hash.

---

## 11. Integrity: reconciliation, chain, audit

`RECONCILE_FINANCE` (daily): recompute each account's period balances from the lines and compare with
`AccountPeriodBalance`; compare the `INVENTORY` and `INVENTORY_IN_TRANSIT` accounts with `InventoryLevel.valueCents`
and the goods in carrier hands; compare `RECEIVABLE_CARRIERS` with the open COD shipments of `TDD_17`; compare each
fiscal document with its entry; sweep unposted sources (§6.1). A mismatch raises the metric and an alert, never
"fixes" itself.

`VERIFY_LEDGER_CHAIN` (weekly and on demand for the auditor): recompute every `hash` and check each `prevHash`.
The canonical form is `sha256(prevHash | number | entryDate | type | sourceType | sourceId | each line: account,
debit, credit, store, party)`; one break is a `FINANCE_CHAIN_BREAKS` incident. **Honest limit:** the chain proves
that an entry was not changed in place and that none was removed from the middle; it does not prove that the last
entries were not truncated, which the closed periods' frozen head hash and the external CSV the auditor holds cover.

---

## 12. API routes, UI and where the code lives

Routes (all `AuthGuard` + `TenantGuard` + `@RequirePermissions`; `ApiRoutes` constants; organization from the
guard): `finance/settings`, `finance/accounts` (+ `:id`, deactivate), `finance/account-roles`, `finance/payment-accounts`,
`finance/tax-rates`, `finance/periods` (+ close, reopen), `finance/entries` (list, one, manual, reverse),
`finance/transactions` (expense, income, transfer; void), `finance/balances`, `finance/reports/*`, `finance/exports`,
`finance/bank-imports` (profiles, upload, matches), `finance/postings` (failed list, post again), `suppliers`,
`purchase-orders` (+ receive, close, cancel), `purchase-orders/:id/payments`, `fiscal/issuer`, `fiscal/documents`
(+ retry, void). Every route that creates an order-linked document or a remittance destination reuses the existing
routes of `TDD_17` with the one added field (the destination account on the remittance confirm).
Each is mapped in `scripts/frontend-coverage-map.ts` and `scripts/plugin-api-coverage-map.ts` (to a reason: no
plugin scope in the MVP).

UI (Step 4B.9, `TDD_09` conventions, Lucide icons, i18n keys): a finance home (balances, cash, receivables,
payables, open period), accounts and settings, the journal, expenses and incomes, transfers, suppliers and
purchase orders, the receive screen, bank reconciliation, reports, the period close checklist, fiscal documents on
the order and a fiscal issuer settings page; a setup wizard for the first run (country, start date, template,
mappings, opening balances).

Code: `libs/core/finance/` (pure rules: entry builders per event, tax math, period checks, hash; the posting
service; no Nest decorators except the module file), `apps/api/src/modules/finance/` (routes), `apps/worker`
(the processors), `libs/fiscal/sdk`, `libs/fiscal/<country>` (providers), `libs/api-client` (hooks).

---

## 13. What the accountant and the owner must confirm  **[ACCOUNTANT]**

None of these blocks the ledger core (Steps 4B.2 to 4B.6). Each says which step needs the answer.

| # | Question | Needed by |
|---|---|---|
| 1 | The chart of accounts (names, codes, the starter list of §3.1) and the opening balances | 4B.2 (before the first real entry) |
| 2 | VAT: rate and exempt categories; whether shipping fees are taxed; whether prices include VAT per store | 4B.3 |
| 3 | When a sale is recognized (delivered or shipped) and when its fiscal document is issued | 4B.6, 4B.7 |
| 4 | Withholdings and perceptions that apply to the buyers (and the advance payments of income tax): which, at what rates, on what base | 4B.3, 4B.6 |
| 5 | Whether the carriers' charges carry VAT and under which document; whether a purchase without a valid fiscal document gives input VAT | 4B.5, 4B.6 |
| 6 | The legal books (sales to consumers, sales to taxpayers, purchases): exact layout and the monthly VAT return data | 4B.8 |
| 7 | Document types per kind of buyer; the customer data required on each; the rounding and decimals the document uses versus the cents of the ledger; what happens to a sale below any threshold; credit notes for returns and exchanges | 4B.7 |
| 8 | **What blocks the real DTE (owner and accountant):** (a) the owner's registration as an issuer with the tax authority, for the test environment and for production; (b) the signing certificate and the credentials of both environments, and how they are obtained and renewed; (c) the accountant's confirmation of the document types and the exact format (row 7); (d) the authority's technical documents and its contingency and retention rules. Until then the step is built against the simulator (§8.1) and the real provider package waits. | 4B.7 (the real provider only; the step itself does not wait) |
| 9 | Fiscal year (calendar?) and the close routine of the accountant (what they expect in a month's close) | 4B.8 |
| 10 | Whether the owner needs the retention of accounting records in a specific form or place | 4B.8 |

---

## 14. Not in this phase

Several currencies and revaluation (§2.8); accounts per store (§2.2); FIFO and lots (`TDD_16 §13`); direct bank
connections; payroll; fixed assets and depreciation; budgets and cost centers beyond the store dimension; credit
sales to customers (a receivable from a customer) and a point of sale (**POS is Phase 2**, owner decision
2026-11-10, `TDD_16 §12`); returns to suppliers and debit notes; landed-cost allocation of freight on purchases
(a purchase's freight is an expense in the MVP); recurring expenses; an accounting API for plugins; the
Colombian provider and template; automatic fiscal-year closing entries; multi-organization consolidation.

---

## 15. Build order

`IMPLEMENTATION_PLAN.md` Milestone 4B: **4B.2** ledger core, **4B.3** VAT and the tax snapshot, **4B.4** expenses,
incomes, transfers and bank reconciliation, **4B.5** suppliers and purchase orders, **4B.6** the automatic entries
and the carrier-fee permission, **4B.7** fiscal documents, **4B.8** reports, close and audit export, **4B.9** the
interface. 4B.2 to 4B.4 do not depend on the real C807 remittance of Step 4.15; 4B.6 should be tested against it.
