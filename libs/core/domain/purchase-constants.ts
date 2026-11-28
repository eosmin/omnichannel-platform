// The constants of suppliers, purchase orders, receipts and supplier payments (TDD_18 §2.7, §4.2 E10 and E11, Step 4B.5). The
// enums of the module (PurchaseOrderStatus, the transition table, the source and entry types) live in finance-constants.ts.

export const PurchaseLimits = {
  SUPPLIER_NAME_MAX_LENGTH: 150,
  SUPPLIER_TAX_ID_MAX_LENGTH: 50,
  SUPPLIER_CONTACT_MAX_LENGTH: 150,
  SUPPLIER_EMAIL_MAX_LENGTH: 254,
  SUPPLIER_PHONE_MAX_LENGTH: 40,
  // Days between the receiving of goods and the day the bill is due: a supplier's terms
  MAX_PAYMENT_TERMS_DAYS: 365,
  MAX_SUPPLIERS_PER_ORGANIZATION: 5000,
  NOTES_MAX_LENGTH: 1000,
  // `PO-000001`: the digits of the number, so that the list sorts as it reads
  NUMBER_PAD: 6,
  NUMBER_PREFIX: 'PO-',
  REFERENCE_MAX_LENGTH: 100,
  CLIENT_KEY_MAX_LENGTH: 200,
  // The lines of one purchase order, and so of one receipt
  MAX_LINES_PER_ORDER: 200,
  // The units of one line: the same ceiling as one inventory movement, so a receipt line is always one movement
  MAX_LINE_QUANTITY: 1_000_000,
  // The accounting date of a receipt or a payment may be a day ahead of today (the clock of the person is not the server's)
  FUTURE_DAYS: 1,
  // The codes of the supplier's document (class, type, the sector...) are short text of the provider's catalogs; the code of generation of a
  // received electronic document is a UUID (36 with dashes), with room for a provider that writes another
  DOCUMENT_CODE_MAX_LENGTH: 2,
  GENERATION_CODE_MAX_LENGTH: 64,
  // How many receipts the refusal of an annex names: the first ones, by day, so the staff can complete them
  ANNEX_MISSING_LISTED: 20
} as const

// Where the goods of a purchase come from, for the annex of purchases of the return: bought in the country, brought in from a country of the
// customs union (internation), imported goods, imported services. One receipt is one origin (a mixed bill is two receipts)
export const PurchaseOrigins = {
  INTERNAL: 'internal',
  INTERNATION: 'internation',
  IMPORT_GOODS: 'import_goods',
  IMPORT_SERVICES: 'import_services'
} as const
export type PurchaseOrigin = (typeof PurchaseOrigins)[keyof typeof PurchaseOrigins]
export const PURCHASE_ORIGINS = Object.values(PurchaseOrigins) as [
  PurchaseOrigin,
  ...PurchaseOrigin[]
]

// Why a person rectifies the document of a receipt that an exported annex already held (a closed list: no free text, which could carry
// personal data into the audit row). Rectifying changes what was declared, so the month is exported again
export const PurchaseRectificationReasons = {
  DATA_ENTRY_ERROR: 'data_entry_error',
  SUPPLIER_CORRECTION: 'supplier_correction',
  ACCOUNTANT_INSTRUCTION: 'accountant_instruction'
} as const
export type PurchaseRectificationReason =
  (typeof PurchaseRectificationReasons)[keyof typeof PurchaseRectificationReasons]
export const PURCHASE_RECTIFICATION_REASONS = Object.values(PurchaseRectificationReasons) as [
  PurchaseRectificationReason,
  ...PurchaseRectificationReason[]
]

// Why a receipt is left out of the annex of purchases on purpose (marked by a person, audited): the document of the purchase is not one the
// annex declares. A purchase to a person with no document goes by the invoice of an excluded subject (its own annex), and a purchase that
// does not count as a cost or an expense for the income tax has no place in the columns of the annex
export const PurchaseAnnexExclusions = {
  EXCLUDED_SUBJECT: 'excluded_subject',
  NOT_DEDUCTIBLE: 'not_deductible'
} as const
export type PurchaseAnnexExclusion =
  (typeof PurchaseAnnexExclusions)[keyof typeof PurchaseAnnexExclusions]
export const PURCHASE_ANNEX_EXCLUSIONS = Object.values(PurchaseAnnexExclusions) as [
  PurchaseAnnexExclusion,
  ...PurchaseAnnexExclusion[]
]

// The problems a provider finds in the supplier's document of a receipt (`FiscalDocumentProvider.validatePurchaseDocument`), for the client to
// tell apart (`metadata.problems`)
export const PurchaseDocumentProblems = {
  CLASS_INVALID: 'class_invalid',
  TYPE_INVALID: 'type_invalid',
  CLASS_TYPE_MISMATCH: 'class_type_mismatch',
  GENERATION_CODE_REQUIRED: 'generation_code_required',
  GENERATION_CODE_INVALID: 'generation_code_invalid',
  GENERATION_CODE_NOT_ELECTRONIC: 'generation_code_not_electronic',
  // The document is issued after the day it arrived, or older than the periods the return may still take it (the provider's rule)
  ISSUED_AFTER_RECEIPT: 'issued_after_receipt',
  ISSUED_TOO_OLD: 'issued_too_old',
  NUMBER_REQUIRED: 'number_required',
  ORIGIN_INVALID_FOR_TYPE: 'origin_invalid_for_type',
  CLASSIFICATION_INVALID: 'classification_invalid'
} as const
export type PurchaseDocumentProblem =
  (typeof PurchaseDocumentProblems)[keyof typeof PurchaseDocumentProblems]

// The kind of a resource, for the audit log and for the not-found answers
export const PurchaseResourceTypes = {
  SUPPLIER: 'supplier',
  PURCHASE_ORDER: 'purchase_order',
  PURCHASE_RECEIPT: 'purchase_receipt',
  SUPPLIER_PAYMENT: 'supplier_payment',
  SUPPLIER_PAYMENT_RETURN: 'supplier_payment_return'
} as const

// The idempotency key of the entry each event posts (TDD_18 §4.1): `receipt:<id>:receive`, `payment:<id>:pay`, and the reversal of a
// payment is the generic `reversal:<entryId>`
export const PurchaseIdempotencyKey = {
  RECEIPT: (receiptId: string): string => `receipt:${receiptId}:receive`,
  PAYMENT: (paymentId: string): string => `payment:${paymentId}:pay`,
  // The entry of the money a supplier gave back (E11b): once per return, the retry of a request finds it and posts nothing
  PAYMENT_RETURN: (returnId: string): string => `payment_return:${returnId}`,
  // The key of the stock movement one line of a receipt makes: inventory keys are unique per store
  RECEIPT_LINE: (receiptId: string, lineId: string): string => `receipt:${receiptId}:${lineId}`
} as const

// Why a request that is valid in itself is refused by the state of the purchase: for the client to tell apart (`metadata.conflict`)
export const PurchaseConflicts = {
  SUPPLIER_LIMIT: 'supplier_limit',
  SUPPLIER_NAME_IN_USE: 'supplier_name_in_use',
  SUPPLIER_INACTIVE: 'supplier_inactive',
  // The payable account of a supplier cannot change once it has bills: its payments would post to another account than its bills
  SUPPLIER_PAYABLE_ACCOUNT_LOCKED: 'supplier_payable_account_locked',
  // The lines of an order are edited while it is a draft; after that they are what was ordered
  ORDER_NOT_DRAFT: 'order_not_draft',
  ORDER_NEEDS_LINES: 'order_needs_lines',
  ORDER_HAS_RECEIPTS: 'order_has_receipts',
  // The key of a request that made another order, receipt or payment: a retry sends the same content, never another
  KEY_REUSED: 'purchase_key_reused',
  // The product, the variant, the warehouse or the rate of a line is not usable (switched off, not linked)
  LINE_REFERENCE_INVALID: 'line_reference_invalid',
  // A line names an item that is not stocked: a purchase receives units
  PRODUCT_NOT_TRACKED: 'product_not_tracked',
  // The caller does not see the store of a line (a line is read and written by the members of ITS store only, TDD_18 §2.1)
  LINE_STORE_NOT_VISIBLE: 'line_store_not_visible',
  // A supplier's document number belongs to ONE order: the same invoice on another order would credit its tax twice [ACCOUNTANT]
  DOCUMENT_NUMBER_IN_USE: 'document_number_in_use',
  // A payment is never above what is owed: to the supplier in all, or on the bill it names (E11)
  PAYMENT_EXCEEDS_BALANCE: 'payment_exceeds_balance',
  PAYMENT_EXCEEDS_RECEIPT: 'payment_exceeds_receipt',
  PAYMENT_ALREADY_VOIDED: 'payment_already_voided',
  // A return is never above what is left of its payment (the payment minus its live returns), and a payment with live returns is not
  // voided: the return is voided first
  RETURN_EXCEEDS_PAYMENT: 'return_exceeds_payment',
  RETURN_ALREADY_VOIDED: 'return_already_voided',
  PAYMENT_HAS_RETURNS: 'payment_has_returns',
  // The debt a return reopened was paid again: voiding the return would put the payments above what is owed
  RETURN_VOID_WOULD_OVERPAY: 'return_void_would_overpay',
  PAYMENT_VOIDED: 'payment_voided',
  // The entry of a receipt or a payment is reversed through the purchase (its permission, its audit row), never alone
  ENTRY_OWNED_BY_PURCHASE: 'entry_owned_by_purchase',
  // The supplier's document of a receipt is already on another receipt of the organization (the same electronic document twice would be declared twice)
  GENERATION_CODE_IN_USE: 'generation_code_in_use',
  // A receipt with a document to declare cannot also be marked as left out of the annex
  ANNEX_EXCLUSION_WITH_DOCUMENT: 'annex_exclusion_with_document',
  // The document of a receipt that an exported annex already held is not changed without a rectification (a person with the fiscal
  // permission, a reason, an audit row): what was declared is not rewritten quietly
  DOCUMENT_EXPORTED: 'purchase_document_exported'
} as const
