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
  PURCHASE_RECEIPT = 'purchase_receipt',
  SUPPLIER_PAYMENT = 'supplier_payment',
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
  SHIPPING_NOT_TAXED = 'shipping_not_taxed'
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
  RECONCILIATION_MATCH: 'finance_reconciliation_match'
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
export const FinanceConflicts = {
  // A check of the hash chain is running for the organization: it scans the whole journal, so one at a time
  CHAIN_CHECK_RUNNING: 'chain_check_running',
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
  BANK_CHANGED: 'bank_changed'
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
  LEDGER_PAGE_MAX: 200
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
  AGING = 'aging'
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
