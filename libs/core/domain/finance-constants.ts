import { PaymentMethod } from './status-enums'

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

// What a person decided about a statement line and a line of the journal (TDD_18 §4.4): the only change a decision takes is to UNDONE
export enum ReconciliationMatchStatus {
  CONFIRMED = 'confirmed',
  REJECTED = 'rejected',
  UNDONE = 'undone'
}

// Which lines of an imported statement a list shows (TDD_18 §4.4)
export const BankLineFilters = {
  ALL: 'all',
  MATCHED: 'matched',
  UNMATCHED: 'unmatched',
  SUGGESTED: 'suggested'
} as const

// The time a request that reads a whole statement and writes its lines or its decisions may take: a statement has thousands of lines
export const BankStatementTransaction = { maxWait: 10_000, timeout: 30_000 } as const

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
  // A line of a stock transfer closed with units that did not arrive and were written off (E9, TDD_18 §4.2)
  TRANSFER_LINE = 'transfer_line',
  PURCHASE_RECEIPT = 'purchase_receipt',
  SUPPLIER_PAYMENT = 'supplier_payment',
  // A line of the ledger of guides of a carrier connection: a purchase of guides, or the void of one (Step 4B.6b-4)
  CARRIER_GUIDE_MOVEMENT = 'carrier_guide_movement',
  FINANCE_TRANSACTION = 'finance_transaction',
  MANUAL = 'manual'
}

// How a product is taxed (TDD_18 §7). Exempt and not subject both carry no tax; the books tell them apart (the legal books of the
// accountant list them apart, **[ACCOUNTANT]**), so the order keeps which one a line was.
export enum TaxTreatment {
  TAXED = 'taxed',
  EXEMPT = 'exempt',
  NOT_SUBJECT = 'not_subject'
}

// The kind of a tax rate: `vat` in the MVP, the field is there for a country with other taxes (TDD_18 §7)
export enum TaxKind {
  VAT = 'vat'
}

// How the fraction of a cent of a tax is placed (TDD_18 §6.4, §7: half up by default). **[ACCOUNTANT]** may ask for another.
export enum TaxRounding {
  HALF_UP = 'half_up',
  HALF_EVEN = 'half_even',
  DOWN = 'down',
  UP = 'up'
}

// The sides and the kinds of line of the VAT report (TDD_18 §7). A not taxed shipping fee has its own kind: whether it is exempt or not
// subject is for the accountant (**[ACCOUNTANT]**).
export enum VatSide {
  OUTPUT = 'output',
  INPUT = 'input'
}

// Why the hash chain of the journal does not verify (TDD_18 §11): the three the walk finds in the rows, and the two that only the places
// outside the walk can tell (the head the settings keep, the head a closed period froze). The migration's CHECK lists the same codes.
export enum ChainProblem {
  NUMBER_GAP = 'number_gap',
  PREV_HASH_MISMATCH = 'prev_hash_mismatch',
  HASH_MISMATCH = 'hash_mismatch',
  HEAD_MISMATCH = 'head_mismatch',
  FROZEN_HEAD_MISSING = 'frozen_head_missing'
}

// What a check of the chain did to the incident of the organization (TDD_18 §11): it is the audit value and the answer of the monitor
export enum ChainIncidentChange {
  OPENED = 'opened',
  STILL_OPEN = 'still_open',
  RESOLVED = 'resolved',
  NONE = 'none'
}

// What a CSV of the report says beside its rows: the monthly balance and the orders the report could not read or counted apart
export enum VatCsvSide {
  BALANCE = 'balance',
  WARNING = 'warning'
}

export enum VatWarningKind {
  ORDERS_WITHOUT_TAX_SNAPSHOT = 'orders_without_tax_snapshot',
  ORDERS_NOT_READABLE = 'orders_not_readable',
  RETURNED_ORDERS_INCLUDED = 'returned_orders_included'
}

export enum VatLineKind {
  TAXED = 'taxed',
  EXEMPT = 'exempt',
  NOT_SUBJECT = 'not_subject',
  SHIPPING_NOT_TAXED = 'shipping_not_taxed',
  // What the returns (E8) take back, one line without a rate (HC-003)
  RETURNS = 'returns'
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
  // Guides bought in advance and not used yet (an asset): the purchase of guides debits it (the next PR of Step 4B.6b-4), each guide a prepaid connection makes credits it
  PREPAID_CARRIER_GUIDES = 'prepaid_carrier_guides',
  CARRIER_FREIGHT_EXPENSE = 'carrier_freight_expense',
  CARRIER_COMMISSION_EXPENSE = 'carrier_commission_expense',
  COD_DIFFERENCES = 'cod_differences',
  OPENING_EQUITY = 'opening_equity',
  ROUNDING = 'rounding',
  UNCATEGORIZED_EXPENSE = 'uncategorized_expense'
}

// The roles that hold a balance a reader adds up on one account: moving one of them once its account has entries splits the balance
// (the debt of a supplier on two accounts, the stock on two). The rest are in RolesFreeOfHistory (HC-119).
export const RolesPinnedByHistory: readonly AccountRole[] = [
  AccountRole.INVENTORY,
  AccountRole.INVENTORY_IN_TRANSIT,
  AccountRole.RECEIVABLE_CARRIERS,
  AccountRole.CUSTOMER_ADVANCES,
  AccountRole.PAYABLE_SUPPLIERS,
  AccountRole.PAYABLE_CARRIERS,
  // An asset with the advance paid to the carrier: pointing the role elsewhere would leave the advance without its account
  AccountRole.PREPAID_CARRIER_GUIDES,
  AccountRole.VAT_OUTPUT,
  AccountRole.VAT_INPUT,
  AccountRole.OPENING_EQUITY
]

// The other roles, free to move with history on purpose: the defaults of cash and bank only say where a new payment lands (an
// account of the organization that is not the default keeps its own balance), the roles of the income statement keep their past in
// the period it was posted to, the rounding and the differences of cash on delivery are settled by their own entries. Every role is in one list or the other: a spec
// holds it, so a new role is classified when it is born (HC-119).
export const RolesFreeOfHistory: readonly AccountRole[] = [
  AccountRole.CASH_DEFAULT,
  AccountRole.BANK_DEFAULT,
  AccountRole.SALES_REVENUE,
  AccountRole.SHIPPING_REVENUE,
  AccountRole.SALES_DISCOUNTS,
  AccountRole.SALES_RETURNS,
  AccountRole.COST_OF_GOODS_SOLD,
  AccountRole.INVENTORY_LOSS,
  AccountRole.INVENTORY_GAIN,
  AccountRole.CARRIER_FREIGHT_EXPENSE,
  AccountRole.CARRIER_COMMISSION_EXPENSE,
  AccountRole.COD_DIFFERENCES,
  AccountRole.ROUNDING,
  AccountRole.UNCATEGORIZED_EXPENSE
]

// The types of account each role may point at, and the payment methods (LED-154, LED-163). The TDD does not tabulate them, so the
// table is read off the template of the chart (`templates/sv.ts`): what each role holds there is its type here, widened only where a
// chart can reasonably book the same thing in a neighbour type (a cost of goods in expenses, a rounding that goes either way). A
// role mapped to a type outside its list would post to the wrong side of a statement (an input tax to a liability doubles the tax).
const { ASSET, LIABILITY, EQUITY, INCOME, COST_OF_SALES, EXPENSE } = AccountType
export const AccountTypesOfRole: Readonly<Record<AccountRole, readonly AccountType[]>> = {
  [AccountRole.CASH_DEFAULT]: [ASSET],
  [AccountRole.BANK_DEFAULT]: [ASSET],
  [AccountRole.INVENTORY]: [ASSET],
  [AccountRole.INVENTORY_IN_TRANSIT]: [ASSET],
  [AccountRole.RECEIVABLE_CARRIERS]: [ASSET],
  [AccountRole.CUSTOMER_ADVANCES]: [LIABILITY],
  [AccountRole.PAYABLE_SUPPLIERS]: [LIABILITY],
  [AccountRole.PAYABLE_CARRIERS]: [LIABILITY],
  [AccountRole.VAT_OUTPUT]: [LIABILITY],
  [AccountRole.VAT_INPUT]: [ASSET],
  [AccountRole.SALES_REVENUE]: [INCOME],
  [AccountRole.SHIPPING_REVENUE]: [INCOME],
  [AccountRole.SALES_DISCOUNTS]: [INCOME],
  [AccountRole.SALES_RETURNS]: [INCOME],
  [AccountRole.COST_OF_GOODS_SOLD]: [COST_OF_SALES, EXPENSE],
  [AccountRole.INVENTORY_LOSS]: [EXPENSE, COST_OF_SALES],
  [AccountRole.INVENTORY_GAIN]: [INCOME],
  [AccountRole.PREPAID_CARRIER_GUIDES]: [ASSET],
  [AccountRole.CARRIER_FREIGHT_EXPENSE]: [EXPENSE, COST_OF_SALES],
  [AccountRole.CARRIER_COMMISSION_EXPENSE]: [EXPENSE, COST_OF_SALES],
  // A shortfall debits it and a surplus credits it (`return-entry-rules.ts`), so a chart may book it as an expense or as income
  [AccountRole.COD_DIFFERENCES]: [EXPENSE, COST_OF_SALES, INCOME],
  [AccountRole.OPENING_EQUITY]: [EQUITY],
  [AccountRole.ROUNDING]: [EXPENSE, INCOME],
  [AccountRole.UNCATEGORIZED_EXPENSE]: [EXPENSE, COST_OF_SALES]
}

// What a payment lands in is money held or owed to the business (cash, a bank, a carrier that collects): always an asset
export const AccountTypesOfPaymentMethod: Readonly<Record<PaymentMethod, readonly AccountType[]>> =
  {
    [PaymentMethod.CASH]: [ASSET],
    [PaymentMethod.TRANSFER]: [ASSET],
    [PaymentMethod.CARD]: [ASSET],
    [PaymentMethod.CASH_ON_DELIVERY]: [ASSET],
    [PaymentMethod.OTHER]: [ASSET]
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
  // Guides bought in advance from a carrier, and the void of the purchase
  CARRIER_GUIDES = 'carrier_guides',
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
  [FiscalDocumentStatus.SUBMITTED]: [
    FiscalDocumentStatus.ACCEPTED,
    FiscalDocumentStatus.REJECTED,
    FiscalDocumentStatus.QUEUED
  ],
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

// What a tax rate and a tax computation are held to. A rate is basis points (13 % is 1300): no float ever holds a percent.
export const FinanceTaxLimits = {
  MIN_RATE_BPS: 0,
  MAX_RATE_BPS: 10_000,
  // The divisor of basis points: a rate of 10000 is the whole amount
  BPS_DENOMINATOR: 10_000,
  CODE_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/,
  NAME_MAX_LENGTH: 100,
  MAX_TAX_RATES_PER_ORGANIZATION: 50
} as const

export const FinanceLimits = {
  // The accountant's numbering: ASCII letters and digits with . _ - inside, so no space, control or look-alike character
  ACCOUNT_CODE_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/,
  ACCOUNT_NAME_MAX_LENGTH: 150,
  MEMO_MAX_LENGTH: 500,
  REOPEN_REASON_MAX_LENGTH: 500,
  IDEMPOTENCY_KEY_MAX_LENGTH: 200,
  DOCUMENT_NUMBER_MAX_LENGTH: 100,
  // The accounting date of a transaction may be a day ahead of today: the clock of the person is not the server's
  TRANSACTION_FUTURE_DAYS: 1,
  MAX_LINES_PER_ENTRY: 200,
  MAX_ACCOUNTS_PER_ORGANIZATION: 2000,
  // How deep a chart of accounts may nest: a header, its groups and the accounts that post
  MAX_ACCOUNT_DEPTH: 8,
  // A cent amount of one line is an Int of the database (TDD_18 §2): the same ceiling as an order total
  MAX_LINE_CENTS: 2_147_483_647,
  // The longest range one VAT report reads, in days: one request is one bounded read (TDD_18 §7)
  VAT_REPORT_MAX_DAYS: 366,
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
  // What a report or a file taken from the books is audited against (the report is in the metadata)
  REPORT: 'finance_report',
  POSTING: 'finance_posting',
  TAX_RATE: 'finance_tax_rate',
  // The tax preferences of a store (`finance.pricesIncludeTax`), kept in its preferences
  STORE_TAX_SETTINGS: 'finance_store_tax_settings',
  // An expense, an income or a transfer registered by hand (TDD_18 §2.6)
  TRANSACTION: 'finance_transaction',
  // The bank reconciliation by CSV (TDD_18 §4.4)
  BANK_PROFILE: 'finance_bank_profile',
  BANK_IMPORT: 'finance_bank_import',
  BANK_LINE: 'finance_bank_line',
  RECONCILIATION_MATCH: 'finance_reconciliation_match',
  // The legal books (TDD_18 §7): the layout of a kind of book, and a closed period's book as it was frozen
  BOOK_LAYOUT: 'finance_book_layout',
  BOOK_SNAPSHOT: 'finance_book_snapshot'
} as const

// Why a posting failed, kept in FinancePostingFailure.reason (a code, never free text: the interface translates it)
export enum FinancePostingFailureReason {
  ROLE_NOT_MAPPED = 'role_not_mapped',
  ACCOUNT_INACTIVE = 'account_inactive',
  ACCOUNT_NOT_POSTABLE = 'account_not_postable',
  MISSING_AMOUNT = 'missing_amount',
  UNBALANCED = 'unbalanced',
  PERIOD_UNAVAILABLE = 'period_unavailable',
  UNEXPECTED = 'unexpected',
  // Added by the automatic entries (4B.6a)
  // The payment method has no account that receives it
  PAYMENT_ACCOUNT_MISSING = 'payment_account_missing',
  // The movements of the order carry no cost for a line of it (a cost of zero would hide the gap)
  COST_MISSING = 'cost_missing',
  // The order has no tax recorded (made before the tax columns): its entry would be invented
  TAX_MISSING = 'tax_missing',
  // The figures of the order do not add up to its total: the entry would be forced, so it is refused
  AMOUNTS_DISAGREE = 'amounts_disagree',
  // A cash on delivery order with no carrier to owe it: the receivable needs a party
  CARRIER_MISSING = 'carrier_missing',
  // The source is not in the state the event says (a sale not yet paid, a prepaid sale whose advance is not posted)
  SOURCE_NOT_READY = 'source_not_ready',
  // The order was delivered with its payment refunded: waiting changes nothing, the sale would be a credit sale (not built), so nothing
  // is posted and a person is told [ACCOUNTANT]
  PAYMENT_REFUNDED = 'payment_refunded',
  // The ledger refused the entry (the period, the dimensions): the cause is in the logs
  LEDGER_REFUSED = 'ledger_refused',
  // The event never reached the queue, or the queue ran out of attempts: a person, or the sweep of 4B.6b, posts it again
  NOT_QUEUED = 'not_queued',
  // The same key already holds an entry of another amount: a bug, never overwritten (TDD_18 §4.1 rule 4)
  KEY_CONTENT_MISMATCH = 'key_content_mismatch'
}

// The prefix of the idempotency key of each kind of entry (TDD_18 §4.1): `<prefix>:<sourceId>:<event>`
export const FinanceIdempotencyKey = {
  MANUAL: (key: string): string => `manual:${key}`,
  REVERSAL: (entryId: string): string => `reversal:${entryId}`,
  // The entry of an expense, an income or a transfer registered by hand (TDD_18 §4.1): one per transaction
  TRANSACTION: (transactionId: string): string => `transaction:${transactionId}:record`
} as const

// What the hash of an entry is made of, in this order and with this separator (TDD_18 §11). Changing either breaks
// every chain already written, so the version travels with the code and a spec pins the output.
export const LedgerHash = {
  ALGORITHM: 'sha256',
  SEPARATOR: '|'
} as const

// Why a request that is valid in itself is refused by the state of the books: for the client to tell apart (`metadata.conflict`)
// A person may ask the worker to check the chain again once in this time (N-B8-1): each check walks the whole journal, so a loop of
// requests while a real break stays open must not keep the worker on it. The job stays in the queue this long, finished or failed.
export const CHAIN_RESOLVE_COOLDOWN_SECONDS = 600

export const FinanceConflicts = {
  // A check of the hash chain is running for the organization: it scans the whole journal, so one at a time
  CHAIN_CHECK_RUNNING: 'chain_check_running',
  // There is no open incident of the chain to ask the worker to close
  CHAIN_NO_OPEN_INCIDENT: 'chain_no_open_incident',
  ALREADY_SET_UP: 'already_set_up',
  ACCOUNT_CODE_IN_USE: 'account_code_in_use',
  ACCOUNT_LIMIT: 'account_limit',
  // A role, a payment method or the rounding setting points at the account, so switching it off would break the postings
  ACCOUNT_IN_USE_BY_SETTING: 'account_in_use_by_setting',
  // A reversal stays as it is: reversing it could put the first entry's effect back on an account that is off
  REVERSAL_NOT_REVERSIBLE: 'reversal_not_reversible',
  // A payment method keeps its default account: only a store's own choice is taken away
  DEFAULT_PAYMENT_ACCOUNT: 'default_payment_account',
  TAX_RATE_CODE_IN_USE: 'tax_rate_code_in_use',
  TAX_RATE_LIMIT: 'tax_rate_limit',
  // The default rate is what a product that names none is taxed at: another one is chosen first, then this one can go off
  TAX_RATE_IS_DEFAULT: 'tax_rate_is_default',
  // A product names the rate, so switching it off would make that product's next order fail
  TAX_RATE_IN_USE_BY_PRODUCT: 'tax_rate_in_use_by_product',
  // A switched-off rate cannot be made the default
  TAX_RATE_INACTIVE: 'tax_rate_inactive',
  // The accounts of a rate: the tax owed is a liability, the tax to credit is an asset, and they are not the same account
  TAX_RATE_ACCOUNT_TYPE: 'tax_rate_account_type',
  // A rate that already has posted entries keeps its accounts: moving them would split the tax between two accounts and take the
  // posted tax out of the report of VAT (HC-119)
  TAX_RATE_ACCOUNT_HAS_HISTORY: 'tax_rate_account_has_history',
  // A role that holds a balance (what is owed, the stock, the tax) keeps its account once the account has entries: the balance would
  // be split between two accounts. The way out is a reclassifying entry, then the change (HC-119)
  ROLE_HAS_HISTORY: 'role_has_history',
  // The key of a request that registered another transaction: a retry sends the same content, never another
  TRANSACTION_KEY_REUSED: 'transaction_key_reused',
  // A transaction is voided once; the reversing entry is in the journal
  TRANSACTION_ALREADY_VOIDED: 'transaction_already_voided',
  // A change keeps the kind: an expense is not turned into a transfer (void it and register the other)
  TRANSACTION_KIND_CHANGED: 'transaction_kind_changed',
  // The entry of a transaction registered by hand is voided through the transaction (its kind's permission, its audit row), not reversed alone
  ENTRY_OWNED_BY_TRANSACTION: 'entry_owned_by_transaction',
  // The receipt of a transaction is set once; another file is a new transaction (void and register it again)
  TRANSACTION_DOCUMENT_ALREADY_SET: 'transaction_document_already_set',
  // Only a file the scan found clean is a receipt (the pointer is set once): wait for the scan, then attach
  TRANSACTION_DOCUMENT_NOT_CLEAN: 'transaction_document_not_clean',
  // The transaction changed between the read and the write and nothing says how: read it and try again
  TRANSACTION_CHANGED: 'transaction_changed',
  // A profile reads the file of ONE cash, bank or wallet account
  BANK_ACCOUNT_NOT_CASH: 'bank_account_not_cash',
  BANK_PROFILE_NAME_IN_USE: 'bank_profile_name_in_use',
  BANK_PROFILE_LIMIT: 'bank_profile_limit',
  // The profile a change would leave breaks a rule of the profiles, or one saved before a rule changed
  BANK_PROFILE_INVALID: 'bank_profile_invalid',
  // The file was imported with this profile already and every line of it is known (nothing new in it)
  BANK_IMPORT_NOTHING_NEW: 'bank_import_nothing_new',
  // The pair is not one the rules allow (another account, another amount or direction, outside the window, a line already matched)
  BANK_PAIR_NOT_ALLOWED: 'bank_pair_not_allowed',
  BANK_LINE_ALREADY_MATCHED: 'bank_line_already_matched',
  BANK_BOOK_LINE_ALREADY_MATCHED: 'bank_book_line_already_matched',
  // A decision that was taken back already
  BANK_DECISION_ALREADY_UNDONE: 'bank_decision_already_undone',
  // The line is matched: only a line without a confirmed match is registered as a transaction
  BANK_LINE_MATCHED: 'bank_line_matched',
  // The statement said no closing balance, so there is nothing to compare the books with
  BANK_NO_CLOSING_BALANCE: 'bank_no_closing_balance',
  // The books moved between the read and the decision (an entry reversed, two decisions that took turns badly): read again
  BANK_CHANGED: 'bank_changed',
  // Every date of the file reads in both orders of the day and the month (03/11/2026): the person confirms the order of the profile
  // before the statement, which is never changed, is kept
  BANK_DATE_FORMAT_UNCONFIRMED: 'bank_date_format_unconfirmed'
} as const

// What the database says when it refuses a decision of the reconciliation, by the prefix of the message its trigger raises (the LAST
// prefix of a message is the database's: Prisma echoes the query, which can carry typed text)
export const BankTriggerPrefixes = {
  MATCH: 'RECONCILIATION_MATCH',
  ENTRY_RECONCILED: 'FINANCE_ENTRY_RECONCILED'
} as const

// The names of the ways a chart change breaks the chart, beside the ones `account-rules` returns
export const FinanceChartProblems = { HAS_CHILDREN: 'has_children' } as const

// The payment methods whose money lands in an account of the organization: a collect-on-delivery parcel is the carrier's until
// a remittance brings it (TDD_18 §6.2)
export const FinancePaymentMethods: readonly PaymentMethod[] = Object.values(PaymentMethod).filter(
  method => method !== PaymentMethod.CASH_ON_DELIVERY
)

// Why an account cannot receive the money of a remittance (TDD_18 §4.2 E5): it is off, or it is not an account the books post to that is
// cash, a bank or a wallet. One rule for the route that confirms, the writer of the confirmation and the posting service, so that they
// never differ.
export enum RemittanceDestinationProblem {
  INACTIVE = 'inactive',
  NOT_CASH = 'not_cash'
}

export function remittanceDestinationProblem(account: {
  active: boolean
  isPostable: boolean
  cashKind: string | null
}): RemittanceDestinationProblem | null {
  if (!account.active) return RemittanceDestinationProblem.INACTIVE
  if (!account.isPostable || account.cashKind === null) return RemittanceDestinationProblem.NOT_CASH
  return null
}

// Why the check of the hash chain says it is broken (TDD_18 §11): the three the walk finds and the two that only the places outside the
// chain can tell. The screen reads this list; the api still writes them as literals until Step 4B.8b makes them constants (debt (q) of 4B.8a)
export const FinanceChainProblems = [
  'number_gap',
  'prev_hash_mismatch',
  'hash_mismatch',
  'head_mismatch',
  'frozen_head_missing'
] as const
export type FinanceChainProblem = (typeof FinanceChainProblems)[number]

// The reports and the auditor's files (TDD_18 §10, §11, Step 4B.8)
export const FinanceReportLimits = {
  // Lines a CSV of the journal or the ledger carries: a file that would be larger is refused with the range to narrow (EXPORT_TOO_LARGE),
  // never cut short, because a cut file looks like a whole one to an auditor
  MAX_CSV_ROWS: 200_000,
  // Entries the check of the chain reads at once; it walks the journal in pages in number order
  CHAIN_PAGE_SIZE: 500,
  // Lines the CSV of the journal reads from the database per round trip: the file is written as it is read, never held
  CSV_PAGE_SIZE: 1000,
  // Lines of the ledger of one account one request answers (it pages by line)
  LEDGER_PAGE_MAX: 200,
  // Entries (each with all its lines) the journal report of one request answers; it pages by entry number
  JOURNAL_PAGE_MAX: 100,
  // Sale entries (and so orders) the margin report reads at once: it walks the range in pages and never holds the orders of a month
  MARGIN_PAGE_SIZE: 500,
  // The range of days a CSV of the journal or the ledger may cover: a year and a leap day, so a fiscal year always fits. The api
  // refuses a longer one; the screen says so first (a spec compares both)
  CSV_MAX_RANGE_DAYS: 366
} as const

// The statements and the lists with age (TDD_18 §10, Step 4B.8b). Which accounts a statement reads is the chart of the accountant: it groups
// by the type of each account and by its parent, never by a code written here (**[ACCOUNTANT]**).
export enum StatementWarning {
  // A section the statement needs has no account with activity: the result would look better than it is, or nothing is said at all
  NO_INCOME = 'no_income',
  NO_COST_OF_SALES = 'no_cost_of_sales',
  NO_CASH_ACCOUNTS = 'no_cash_accounts',
  // An account role the report reads has no account mapped (settings): the report says so instead of choosing an account
  ROLE_NOT_MAPPED = 'role_not_mapped',
  // The lines of a role carry no party: they are in the total but in no row
  LINES_WITHOUT_PARTY = 'lines_without_party',
  // The identity of the books failed (assets differ from liabilities plus equity plus the result): an incident, the report still answers
  NOT_BALANCED = 'not_balanced',
  CASH_FLOW_DOES_NOT_CLOSE = 'cash_flow_does_not_close'
}

export enum AgingKind {
  PAYABLES = 'payables',
  RECEIVABLES = 'receivables'
}

// The roles each list reads (settings → account roles): the accountant may map them to the accounts of her chart. Both sides are balances
// by party (a supplier, a carrier connection).
export const AgingRoles: Readonly<Record<AgingKind, readonly AccountRole[]>> = {
  [AgingKind.PAYABLES]: [AccountRole.PAYABLE_SUPPLIERS, AccountRole.PAYABLE_CARRIERS],
  [AgingKind.RECEIVABLES]: [AccountRole.RECEIVABLE_CARRIERS]
}

// Upper bounds, in days, of the age buckets: 0-30, 31-60, 61-90 and more than 90. **[ACCOUNTANT]** may ask for other cuts; one place to change.
export const AgingBucketDays: readonly number[] = [30, 60, 90]

// The statements by name: what an audit row and a file say they are
export enum FinanceReport {
  INCOME_STATEMENT = 'income_statement',
  BALANCE_SHEET = 'balance_sheet',
  CASH_FLOW = 'cash_flow',
  AGING = 'aging',
  MARGIN = 'margin',
  VAT = 'vat'
}

// What the margin by product says beside its rows (TDD_18 §10, Step 4B.8b-2): the rows themselves, the totals, the comparison with the
// ledger and what the report could not use. A warning is a count, never a guess.
export enum MarginCsvSection {
  PRODUCT = 'product',
  TOTAL = 'total',
  LEDGER = 'ledger',
  RETURNS = 'returns',
  WARNING = 'warning'
}

export enum MarginWarning {
  // The organization has not mapped the role: the report says so and compares against nothing, never against zero
  REVENUE_ROLE_NOT_MAPPED = 'revenue_role_not_mapped',
  COST_ROLE_NOT_MAPPED = 'cost_role_not_mapped',
  // A sale entry whose order the report could not read, or that does not add up the way the books required
  ORDERS_NOT_READABLE = 'orders_not_readable',
  // Units that left with no cost on the movement: their cost is unknown and is not in the figures
  UNVALUED_UNITS = 'unvalued_units'
}

// The rows of a statement file that are not an account: the totals, and what the report warns about
export enum StatementCsvSection {
  SUMMARY = 'summary',
  WARNING = 'warning',
  CASH = 'cash'
}

export enum StatementTotalLine {
  TOTAL = 'total',
  GROSS_MARGIN = 'gross_margin',
  NET_RESULT = 'net_result',
  RESULT_NOT_CLOSED = 'result_not_closed',
  EQUITY_WITH_RESULT = 'equity_with_result',
  OPENING = 'opening',
  CLOSING = 'closing',
  NET = 'net'
}

// The legal books (TDD_18 §7, §13 row 6; Step 4B.8b-3). **[ACCOUNTANT]** The exact layout of a legal book is the accountant's and the
// law's, not the design's: what ships is the mechanism (a book is a read-only report over the ledger whose columns, order and
// correlative are the organization's own data) and a PROPOSAL that nobody has validated. A book says which one it is.
export enum LegalBookKind {
  SALES_TAXPAYERS = 'sales_taxpayers',
  SALES_CONSUMERS = 'sales_consumers',
  PURCHASES = 'purchases'
}

// The columns a book can show: a closed list, so a layout can never ask for a field that is not meant to leave the system (no
// customer data, no credential). A kind of book accepts the subset of `LegalBookFieldsOfKind`.
export enum LegalBookField {
  CORRELATIVE = 'correlative',
  DATE = 'date',
  ENTRY_NUMBER = 'entry_number',
  DOCUMENT_TYPE = 'document_type',
  DOCUMENT_NUMBER = 'document_number',
  SOURCE_NUMBER = 'source_number',
  BASE_TAXED = 'base_taxed',
  BASE_EXEMPT = 'base_exempt',
  BASE_NOT_SUBJECT = 'base_not_subject',
  BASE_SHIPPING_UNTAXED = 'base_shipping_untaxed',
  BASE = 'base',
  TAX = 'tax',
  TOTAL = 'total',
  SUPPLIER_NAME = 'supplier_name',
  SUPPLIER_TAX_ID = 'supplier_tax_id',
  TAX_CREDITABLE = 'tax_creditable',
  DUE_DATE = 'due_date'
}

const SALES_FIELDS = [
  LegalBookField.CORRELATIVE,
  LegalBookField.DATE,
  LegalBookField.ENTRY_NUMBER,
  LegalBookField.DOCUMENT_TYPE,
  LegalBookField.DOCUMENT_NUMBER,
  LegalBookField.SOURCE_NUMBER,
  LegalBookField.BASE_TAXED,
  LegalBookField.BASE_EXEMPT,
  LegalBookField.BASE_NOT_SUBJECT,
  LegalBookField.BASE_SHIPPING_UNTAXED,
  LegalBookField.TAX,
  LegalBookField.TOTAL
] as const

export const LegalBookFieldsOfKind: Readonly<Record<LegalBookKind, readonly LegalBookField[]>> = {
  [LegalBookKind.SALES_TAXPAYERS]: SALES_FIELDS,
  [LegalBookKind.SALES_CONSUMERS]: SALES_FIELDS,
  [LegalBookKind.PURCHASES]: [
    LegalBookField.CORRELATIVE,
    LegalBookField.DATE,
    LegalBookField.ENTRY_NUMBER,
    LegalBookField.DOCUMENT_NUMBER,
    LegalBookField.SUPPLIER_NAME,
    LegalBookField.SUPPLIER_TAX_ID,
    LegalBookField.BASE,
    LegalBookField.TAX,
    LegalBookField.TOTAL,
    LegalBookField.TAX_CREDITABLE,
    LegalBookField.DUE_DATE
  ]
}

// The columns that hold whole cents: the ones a book totals
export const LegalBookMoneyFields: readonly LegalBookField[] = [
  LegalBookField.BASE_TAXED,
  LegalBookField.BASE_EXEMPT,
  LegalBookField.BASE_NOT_SUBJECT,
  LegalBookField.BASE_SHIPPING_UNTAXED,
  LegalBookField.BASE,
  LegalBookField.TAX,
  LegalBookField.TOTAL
]

// The fields of the receiver of a fiscal document that name a tax identity: a document type that asks for one of them is a sale to a
// taxpayer (the names are the ones the fiscal port gives the fields of a receiver)
export const TaxIdentityReceiverFields: readonly string[] = ['taxId', 'registrationId']

export enum LegalBookSort {
  // By the accounting date, then by the number of the entry: the order the books were written in
  DATE = 'date',
  // By the number of the document, then the date and the entry (the order some books are kept in) **[ACCOUNTANT]**
  DOCUMENT = 'document'
}

// When the correlative of a book starts again at its first number: every month or every year **[ACCOUNTANT]**
export enum LegalBookCorrelativeRestart {
  MONTH = 'month',
  YEAR = 'year'
}

// How a sale with no fiscal document of its own is listed: in the book of the final consumers or left out of both sale books, which
// the accountant decides **[ACCOUNTANT]**
export enum LegalBookUnissuedSales {
  CONSUMERS = 'consumers',
  EXCLUDED = 'excluded'
}

// Who vouches for a layout: the proposal ships with the code and nobody has validated it; a stored layout is the organization's own and
// says whether its accountant confirmed it
export enum LegalBookLayoutSource {
  PROPOSAL = 'proposal',
  STORED = 'stored'
}

// The headers that travel beside a book's CSV (the file carries only rows) and the key of its audit rows
export const LegalBookHeaders = {
  UNVALIDATED: 'X-Book-Unvalidated',
  SHA256: 'X-Book-Sha256'
} as const
export const legalBookReport = (kind: LegalBookKind): string => `book_${kind}`

export const LegalBookLimits = {
  MAX_COLUMNS: 24,
  LABEL_MAX_LENGTH: 64,
  CORRELATIVE_START_MAX: 1_000_000_000
} as const
