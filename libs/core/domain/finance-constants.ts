// The constants of the finance module (TDD_18 §3). Prisma stores each of these as a String, so a value can be added
// without a migration; the TypeScript enum is the source of truth and the database holds the same list in a CHECK
// where an invalid value would break the books (tests/security/finance-schema.spec.ts compares the two).

export enum AccountType {
  ASSET = 'asset',
  LIABILITY = 'liability',
  EQUITY = 'equity',
  INCOME = 'income',
  COST_OF_SALES = 'cost_of_sales',
  EXPENSE = 'expense'
}

export enum NormalSide {
  DEBIT = 'debit',
  CREDIT = 'credit'
}

export enum CashKind {
  CASH = 'cash',
  BANK = 'bank',
  WALLET = 'wallet'
}

export enum PeriodStatus {
  OPEN = 'open',
  CLOSED = 'closed'
}

export enum EntryOrigin {
  USER = 'user',
  SYSTEM = 'system'
}

export enum PartyType {
  SUPPLIER = 'supplier',
  CARRIER_CONNECTION = 'carrier_connection',
  CUSTOMER = 'customer'
}

export enum SaleRecognition {
  DELIVERED = 'delivered',
  SHIPPED = 'shipped'
}

export enum FinanceTransactionKind {
  EXPENSE = 'expense',
  INCOME = 'income',
  TRANSFER = 'transfer'
}

export enum PurchaseOrderStatus {
  DRAFT = 'draft',
  ORDERED = 'ordered',
  PARTIALLY_RECEIVED = 'partially_received',
  RECEIVED = 'received',
  CLOSED = 'closed',
  CANCELLED = 'cancelled'
}

export enum FiscalDocumentStatus {
  DRAFT = 'draft',
  QUEUED = 'queued',
  SUBMITTED = 'submitted',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  VOIDED = 'voided'
}

export enum FinanceSourceType {
  ORDER = 'order',
  SHIPMENT = 'shipment',
  REMITTANCE = 'remittance',
  RETURN = 'return',
  INVENTORY_MOVEMENT = 'inventory_movement',
  PURCHASE_RECEIPT = 'purchase_receipt',
  SUPPLIER_PAYMENT = 'supplier_payment',
  FINANCE_TRANSACTION = 'finance_transaction',
  MANUAL = 'manual'
}

// The keys of AccountRoleMapping: which account each automatic entry posts to. A role without a mapping makes the
// posting that needs it fail visibly (TDD_18 §6.1), never fall into a default.
export enum AccountRole {
  CASH_DEFAULT = 'cash_default',
  BANK_DEFAULT = 'bank_default',
  INVENTORY = 'inventory',
  INVENTORY_IN_TRANSIT = 'inventory_in_transit',
  RECEIVABLE_CARRIERS = 'receivable_carriers',
  CUSTOMER_ADVANCES = 'customer_advances',
  PAYABLE_SUPPLIERS = 'payable_suppliers',
  PAYABLE_CARRIERS = 'payable_carriers',
  VAT_OUTPUT = 'vat_output',
  VAT_INPUT = 'vat_input',
  SALES_REVENUE = 'sales_revenue',
  SHIPPING_REVENUE = 'shipping_revenue',
  SALES_DISCOUNTS = 'sales_discounts',
  SALES_RETURNS = 'sales_returns',
  COST_OF_GOODS_SOLD = 'cost_of_goods_sold',
  INVENTORY_LOSS = 'inventory_loss',
  INVENTORY_GAIN = 'inventory_gain',
  CARRIER_FREIGHT_EXPENSE = 'carrier_freight_expense',
  CARRIER_COMMISSION_EXPENSE = 'carrier_commission_expense',
  COD_DIFFERENCES = 'cod_differences',
  OPENING_EQUITY = 'opening_equity',
  ROUNDING = 'rounding',
  UNCATEGORIZED_EXPENSE = 'uncategorized_expense'
}

export enum JournalEntryType {
  MANUAL = 'manual',
  OPENING_BALANCE = 'opening_balance',
  EXPENSE = 'expense',
  INCOME = 'income',
  TRANSFER = 'transfer',
  SALE = 'sale',
  SALE_SHIPMENT = 'sale_shipment',
  SALE_RETURN = 'sale_return',
  COD_REMITTANCE = 'cod_remittance',
  COD_WRITE_OFF = 'cod_write_off',
  PURCHASE_RECEIPT = 'purchase_receipt',
  SUPPLIER_PAYMENT = 'supplier_payment',
  INVENTORY_ADJUSTMENT = 'inventory_adjustment',
  REVERSAL = 'reversal'
}

// Asset, cost of sales and expense grow on the debit side; liability, equity and income on the credit side
export const NormalSideOfType: Readonly<Record<AccountType, NormalSide>> = {
  [AccountType.ASSET]: NormalSide.DEBIT,
  [AccountType.COST_OF_SALES]: NormalSide.DEBIT,
  [AccountType.EXPENSE]: NormalSide.DEBIT,
  [AccountType.LIABILITY]: NormalSide.CREDIT,
  [AccountType.EQUITY]: NormalSide.CREDIT,
  [AccountType.INCOME]: NormalSide.CREDIT
}

// Only an asset can be cash, a bank account or a wallet
export const CashKindAccountTypes: readonly AccountType[] = [AccountType.ASSET]

// Enforced inside the owning service (TDD_18 §3). A period goes back to OPEN only through the reopen action, for the
// latest closed period (FINANCE_REOPEN_NOT_LATEST says otherwise).
export const PeriodStatusTransitions: Record<PeriodStatus, readonly PeriodStatus[]> = {
  [PeriodStatus.OPEN]: [PeriodStatus.CLOSED],
  [PeriodStatus.CLOSED]: [PeriodStatus.OPEN]
}

export const PurchaseOrderStatusTransitions: Record<
  PurchaseOrderStatus,
  readonly PurchaseOrderStatus[]
> = {
  [PurchaseOrderStatus.DRAFT]: [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.CANCELLED],
  [PurchaseOrderStatus.ORDERED]: [
    PurchaseOrderStatus.PARTIALLY_RECEIVED,
    PurchaseOrderStatus.RECEIVED,
    PurchaseOrderStatus.CANCELLED
  ],
  [PurchaseOrderStatus.PARTIALLY_RECEIVED]: [
    PurchaseOrderStatus.RECEIVED,
    PurchaseOrderStatus.CLOSED
  ],
  [PurchaseOrderStatus.RECEIVED]: [PurchaseOrderStatus.CLOSED],
  [PurchaseOrderStatus.CLOSED]: [],
  [PurchaseOrderStatus.CANCELLED]: []
}

export const FiscalDocumentStatusTransitions: Record<
  FiscalDocumentStatus,
  readonly FiscalDocumentStatus[]
> = {
  [FiscalDocumentStatus.DRAFT]: [FiscalDocumentStatus.QUEUED],
  [FiscalDocumentStatus.QUEUED]: [FiscalDocumentStatus.SUBMITTED],
  [FiscalDocumentStatus.SUBMITTED]: [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.REJECTED],
  [FiscalDocumentStatus.ACCEPTED]: [FiscalDocumentStatus.VOIDED],
  [FiscalDocumentStatus.REJECTED]: [FiscalDocumentStatus.QUEUED],
  [FiscalDocumentStatus.VOIDED]: []
}

// The only currency of the MVP (TDD_18 §2.8): a CHECK of the database pins it, the service refuses anything else
export const FinanceCurrency = 'USD'

// The countries that have a template (TDD_18 §3.1): choosing one at setup seeds the organization once
export const FinanceCountryCodes = {
  EL_SALVADOR: 'SV'
} as const

export const FinanceLimits = {
  // The accountant's numbering: ASCII letters and digits with . _ - inside, so no space, control or look-alike character
  ACCOUNT_CODE_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/,
  ACCOUNT_NAME_MAX_LENGTH: 150,
  MEMO_MAX_LENGTH: 500,
  REOPEN_REASON_MAX_LENGTH: 500,
  IDEMPOTENCY_KEY_MAX_LENGTH: 200,
  MAX_LINES_PER_ENTRY: 200,
  MAX_ACCOUNTS_PER_ORGANIZATION: 2000,
  // How deep a chart of accounts may nest: a header, its groups and the accounts that post
  MAX_ACCOUNT_DEPTH: 8,
  // A cent amount of one line is an Int of the database (TDD_18 §2): the same ceiling as an order total
  MAX_LINE_CENTS: 2_147_483_647,
  FIRST_MONTH: 1,
  LAST_MONTH: 12,
  MIN_YEAR: 2000,
  MAX_YEAR: 2200
} as const

// The kind of a resource, for the audit log and for the not-found answers
export const FinanceResourceTypes = {
  SETTINGS: 'finance_settings',
  ACCOUNT: 'finance_account',
  ROLE_MAPPING: 'finance_account_role',
  PAYMENT_ACCOUNT: 'finance_payment_account',
  PERIOD: 'finance_period',
  ENTRY: 'finance_entry',
  POSTING: 'finance_posting'
} as const

// Why a posting failed, kept in FinancePostingFailure.reason (a code, never free text: the interface translates it)
export enum FinancePostingFailureReason {
  ROLE_NOT_MAPPED = 'role_not_mapped',
  ACCOUNT_INACTIVE = 'account_inactive',
  ACCOUNT_NOT_POSTABLE = 'account_not_postable',
  MISSING_AMOUNT = 'missing_amount',
  UNBALANCED = 'unbalanced',
  PERIOD_UNAVAILABLE = 'period_unavailable',
  UNEXPECTED = 'unexpected'
}

// The prefix of the idempotency key of each kind of entry (TDD_18 §4.1): `<prefix>:<sourceId>:<event>`
export const FinanceIdempotencyKey = {
  MANUAL: (key: string): string => `manual:${key}`,
  REVERSAL: (entryId: string): string => `reversal:${entryId}`
} as const

// What the hash of an entry is made of, in this order and with this separator (TDD_18 §11). Changing either breaks
// every chain already written, so the version travels with the code and a spec pins the output.
export const LedgerHash = {
  ALGORITHM: 'sha256',
  SEPARATOR: '|'
} as const
