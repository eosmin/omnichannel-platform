import { FiscalDocumentStatus } from './finance-constants'

// Fiscal documents (TDD_18 §8), Step 4B.7. Constants only: core owns the lifecycle and the link to the ledger, a provider package owns
// everything legal and country-specific, so nothing here names a country, an authority or a provider.

// After ACCEPTED the document is the legal evidence: no field of it changes but the status to VOIDED
export const FiscalDocumentImmutableStatuses: readonly FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOIDED
]

// What a document is for: the document of a sale, the credit note of a return, which cancels part (or all) of the sale document it names,
// a debit note, which charges more on the sale document it names, or a remission note, which backs goods that travel before the document
// of their sale exists (it names no document). A provider's own document types (`FiscalDocumentTypeDeclaration`)
// stay the provider's; this is core's word for the relation. **A debit note and a remission note are only built and sent by a provider
// today** (the conformance tests of an authority ask for them): the lifecycle of core does not make one yet, and the database accepts no row
// of these kinds until the step that issues them adds them (`IMPLEMENTATION_PLAN.md`, D3b).
export enum FiscalDocumentKind {
  SALE = 'sale',
  CREDIT_NOTE = 'credit_note',
  DEBIT_NOTE = 'debit_note',
  REMISSION_NOTE = 'remission_note'
}

export enum FiscalEnvironment {
  SANDBOX = 'sandbox',
  PRODUCTION = 'production'
}

// When the document of a sale is made: owner and accountant decide (TDD_18 §13 row 3); the default follows the sale's recognition
export enum FiscalIssueOn {
  DELIVERED = 'delivered',
  SHIPPED = 'shipped'
}

// The files of evidence a document keeps (Step 4B.7b-2): what was built, what the authority answered to the acceptance, and what it
// answered to the invalidation. One file of each kind at most, for ever (the database says it).
export enum FiscalEvidenceKind {
  DOCUMENT = 'document',
  RESPONSE = 'response',
  VOID_RESPONSE = 'void_response',
  DTE_FILE = 'dte_file',
  REPRESENTATION = 'representation'
}

// How the sale was paid, in core's words, for a provider whose document says it (the provider maps it to its own catalog). Core derives
// it from the payment status of the order: a payment that is COMPLETED is immediate, anything else is deferred. **[ACCOUNTANT]** A sale
// paid on delivery, or in parts, may be another condition in a country that has one: the provider reads the payments to say so.
export enum FiscalOperationCondition {
  IMMEDIATE = 'immediate',
  DEFERRED = 'deferred'
}

export const FiscalLimits = {
  // The limits of the context of the organization that ONE unit of fiscal work opens in a job (a claim, an answer of the authority, a page of
  // the sweep). The call to the authority is never inside one, so a unit holds the database for the rows only. 30 s (twice the 15 s of a
  // request) because the page of the entry check reads up to ENTRY_SCAN_MAX documents in one unit; a row lock never waits that long
  CONTEXT_MAX_WAIT_MS: 10_000,
  CONTEXT_TIMEOUT_MS: 30_000,
  // A file of evidence larger than this is not made (the sealed copy in the row stays, which is what the document is): a provider whose
  // document is this big is a fault to read in the logs
  EVIDENCE_MAX_BYTES: 4 * 1024 * 1024,
  // What a representation may hold before it is drawn (it is drawn by the worker, so its size is bounded first): a text longer than this or
  // more rows than this is refused, never cut (a cut legal paper is a wrong one). The rows of the items table have their own bound, above
  // the most items a provider builds (the provider of El Salvador builds up to 2000; its spec checks it), and the rest of the rows (the
  // sections, the totals, the notes) another one, so a legitimate document never reaches either.
  REPRESENTATION_MAX_TEXT_CHARS: 5000,
  REPRESENTATION_MAX_TABLE_ROWS: 2500,
  REPRESENTATION_MAX_OTHER_ROWS: 300,
  // Attempts of the job; the provider's own contingency decides what an attempt does while the authority is down
  MAX_ATTEMPTS: 6,
  // The delay before the first retry; it doubles each time, so the last wait of the queue (BACKOFF_MS * 2^(MAX_ATTEMPTS - 2) = 12 min)
  // stays under the 15 minutes the rules of the authority allow between two attempts while the authority cannot be reached
  BACKOFF_MS: 45_000,
  REASON_MAX_LENGTH: 500,
  // What a provider may hand back of the authority's answer, as text: more is cut (a provider may copy the whole body of the authority)
  RESPONSE_MAX_CHARS: 16_000,
  // What the provider keeps for the invalidation (the codes and seals of the authority) is needed to void the document and cannot be repaired
  // once it is accepted: its limit is far above the response's, and a provider that goes over it is a fault to read in the logs
  PROVIDER_DATA_MAX_CHARS: 256_000,
  VOID_REASON_MAX_LENGTH: 500,
  // The name and the number of the identity document of the person who makes or asks for an invalidation
  VOID_PARTY_NAME_MAX_LENGTH: 100,
  VOID_PARTY_ID_MAX_LENGTH: 20,
  FAILED_JOB_KEEP_SECONDS: 7 * 24 * 60 * 60,
  // The correlative is an INTEGER of the database
  MAX_SEQUENCE: 2_000_000_000,
  // A submission that was claimed less than this ago is alive: another attempt is working on it. Older, its worker died and it is taken over.
  CLAIM_LEASE_MS: 5 * 60 * 1000,
  // A call to a provider that does not answer in this time counts as no answer: well under the lease, so a slow provider never outlives
  // the claim of its attempt
  PROVIDER_CALL_TIMEOUT_MS: 60 * 1000,
  // How long an invalidation holds its document: the consultation, the invalidation and the second consultation, each with the call timeout, and a margin
  VOID_CLAIM_LEASE_MS: 4 * 60 * 1000,
  // The check of an issuer reads fields and a certificate and runs while the row of the issuer is locked: it never takes long
  ISSUER_CHECK_TIMEOUT_MS: 5 * 1000,
  // The correlative of a document is an INTEGER of the database: a scope that reaches it stops (it never wraps to a number already used)
  MAX_CORRELATIVE: 2_000_000_000,
  LIST_PAGE_SIZE: 25,
  LIST_MAX_PAGE_SIZE: 100
} as const

// What the provider's answer to a submission can be, in core's words (the provider maps the authority's own to these)
export enum FiscalSubmitOutcome {
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  // The authority is down or did not answer: keep the document and try again
  UNAVAILABLE = 'unavailable'
}

// The answer of a provider to a document made in contingency
export enum FiscalDeferOutcome {
  DEFERRED = 'deferred',
  REJECTED = 'rejected',
  UNAVAILABLE = 'unavailable'
}

// The answer of the authority to the event that reports a contingency, in core's words
export enum FiscalContingencyReportOutcome {
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  UNAVAILABLE = 'unavailable'
}

export const fiscalJobOptions = (): {
  attempts: number
  backoff: { type: 'exponential'; delay: number }
  removeOnComplete: true
  removeOnFail: { age: number }
} => ({
  attempts: FiscalLimits.MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: FiscalLimits.BACKOFF_MS },
  removeOnComplete: true,
  // A failed submission is kept a week for whoever looks into it, then goes: the document row is what lasts
  removeOnFail: { age: FiscalLimits.FAILED_JOB_KEEP_SECONDS }
})

// The retries of a report of a contingency: the rules of the authority ask for an attempt at least every 15 minutes while the authority
// cannot be reached, for as long as the event may still be sent in time (24 hours after the situation ended), so the queue asks at a fixed
// interval for that long and the person is told when none went through
export const fiscalReportJobOptions = (): {
  attempts: number
  backoff: { type: 'fixed'; delay: number }
  removeOnComplete: true
  removeOnFail: { age: number }
} => ({
  attempts: FiscalContingencyLimits.REPORT_MAX_ATTEMPTS,
  backoff: { type: 'fixed', delay: FiscalContingencyLimits.REPORT_RETRY_DELAY_MS },
  removeOnComplete: true,
  removeOnFail: { age: FiscalLimits.FAILED_JOB_KEEP_SECONDS }
})

// (`FiscalContingencyLimits` is declared below: these two are functions, so it is read only when they run, never at load)
// The retries of a document released from a contingency: the same fixed interval as the report, for the whole window in which the lot may
// be sent (72 hours at most), so that it is still retrying, and not stuck, while the window lasts
export const fiscalReleasedJobOptions = (): {
  attempts: number
  backoff: { type: 'fixed'; delay: number }
  removeOnComplete: true
  removeOnFail: { age: number }
} => ({
  attempts: FiscalContingencyLimits.RELEASED_MAX_ATTEMPTS,
  backoff: { type: 'fixed', delay: FiscalContingencyLimits.REPORT_RETRY_DELAY_MS },
  removeOnComplete: true,
  removeOnFail: { age: FiscalLimits.FAILED_JOB_KEEP_SECONDS }
})

// The attempts a submission job gets, by where its document is: kept in a contingency (released) or not
export const fiscalSubmitMaxAttempts = (inContingency: boolean): number =>
  inContingency ? FiscalContingencyLimits.RELEASED_MAX_ATTEMPTS : FiscalLimits.MAX_ATTEMPTS

export const FiscalResourceTypes = {
  ISSUER: 'fiscal_issuer',
  DOCUMENT: 'fiscal_document',
  DELIVERY: 'fiscal_delivery',
  CUSTOMER_DATA: 'customer_fiscal_data',
  CONTINGENCY: 'fiscal_contingency'
} as const

// Contingency (Step 4B.7c-7): while the authority cannot be reached an issuer may go on making documents in a deferred model (made, signed
// and kept, not sent). OPEN while it lasts; CLOSED when the person (or the window) ends it and the event that reports it has not been
// accepted yet; REPORTED when the authority accepted the event, from which the documents of the lot go out through the queue.
export enum FiscalContingencyStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  REPORTED = 'reported'
}

// Who started it: a person, or the lifecycle itself when a document ran out of attempts with the authority down
// What the report of a contingency came to, and what became of a document that tried to enter one
export enum FiscalContingencyReportResult {
  REPORTED = 'reported',
  REFUSED = 'refused',
  NOTHING = 'nothing'
}
export enum FiscalContingencyAttachResult {
  ATTACHED = 'attached',
  CLOSED = 'closed',
  FULL = 'full',
  GONE = 'gone'
}

// Why a report did not go through, in codes (core's own; a provider's are kept as codes of its shape, anything else is `rejected`)
export const FiscalContingencyFailures = {
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  ISSUER_CHANGED: 'issuer_changed',
  CREDENTIALS_UNREADABLE: 'credentials_unreadable',
  DOCUMENT_UNREADABLE: 'document_unreadable',
  RESPONSIBLE_UNREADABLE: 'responsible_unreadable',
  TOO_MANY_DOCUMENTS: 'too_many_documents',
  PROVIDER_ANSWER_INVALID: 'provider_answer_invalid',
  NO_ANSWER: 'no_answer',
  REJECTED: 'rejected'
} as const

// The shape of a code a provider or an authority may give as the reason of a refusal: letters, digits and a few marks, never free text
export const FiscalContingencyCodePattern = /^[A-Za-z0-9_.-]{1,60}$/

export enum FiscalContingencyOrigin {
  USER = 'user',
  SYSTEM = 'system'
}

// The delivery of an accepted document to its receiver (Normativa DTE v2.0, section 11): the DTE file and its graphic representation, given
// with the document and never held back for a payment. One row for each document. SENT: the files went by a channel or by email. NOT_SENT:
// nothing could carry them and a person must give them by hand.
export enum FiscalDeliveryStatus {
  SENT = 'sent',
  NOT_SENT = 'not_sent'
}

// How the files went. A channel carries them as two documents of the conversation; the email as two attachments of one message.
export enum FiscalDeliveryRoute {
  CHANNEL = 'channel',
  EMAIL = 'email',
  NONE = 'none'
}

// Why nothing was sent. Codes only: the receiver's data never goes in a reason.
export enum FiscalDeliveryReason {
  // No conversation takes both files and the customer has no email
  NO_CHANNEL = 'no_channel',
  // The two files could not be made or read (the evidence is made again when a person asks for it)
  FILES_UNAVAILABLE = 'files_unavailable',
  // The files are larger than what an email carries
  TOO_LARGE = 'too_large',
  // The customer was erased: nobody is left to give them to
  CUSTOMER_ERASED = 'customer_erased'
}

// The largest pair of files an email carries (the sum of the two, before the encoding): above it the person gives them by hand
export const FISCAL_DELIVERY_EMAIL_MAX_BYTES = 8 * 1024 * 1024

// What a person is told about a contingency
export enum FiscalContingencyAlertKind {
  // The lifecycle opened it by itself (the authority did not answer): the documents are being made in the deferred model
  OPENED_BY_SYSTEM = 'opened_by_system',
  // The event that reports it was not accepted after every attempt of the queue
  REPORT_FAILED = 'report_failed',
  // The window to send the documents of the lot is closing
  WINDOW_CLOSING = 'window_closing'
}

const REPORT_RETRY_INTERVAL_MS = 15 * 60 * 1000
// The wait between two attempts of a report is a minute under the interval: the call itself and the queue add to it, and the gap between
// two attempts must stay under the 15 minutes
const REPORT_RETRY_DELAY_MS = 14 * 60 * 1000
const REPORT_RETRY_HOURS = 24
// The longest window a provider may declare to send the documents of a lot (`transmitWithinHours`): the registry refuses a provider that
// declares more, so the retries of a released document (every 14 minutes) always cover the window
const RELEASED_RETRY_HOURS = 72

export const FiscalContingencyLimits = {
  // The attempts of one submission that find the authority down before the lifecycle opens a contingency by itself
  AUTO_OPEN_AFTER_ATTEMPTS: 3,
  MOTIVE_MAX_LENGTH: 500,
  // The longest time between two attempts to reach the authority (the rules of the authority)
  RETRY_INTERVAL_MS: REPORT_RETRY_INTERVAL_MS,
  REPORT_RETRY_DELAY_MS,
  // A report that fails is asked again every REPORT_RETRY_DELAY_MS for REPORT_RETRY_HOURS (the 24 hours the event may wait after the situation
  // ended); after the last attempt the person is told
  REPORT_MAX_ATTEMPTS: Math.ceil((REPORT_RETRY_HOURS * 60 * 60 * 1000) / REPORT_RETRY_DELAY_MS),
  RELEASED_RETRY_HOURS,
  // A document released after the report of its event is asked again every REPORT_RETRY_DELAY_MS through the whole window of the lot, and
  // only then is it stuck: the rules of the authority do not allow a longer gap between two attempts while the authority cannot be reached
  RELEASED_MAX_ATTEMPTS: Math.ceil((RELEASED_RETRY_HOURS * 60 * 60 * 1000) / REPORT_RETRY_DELAY_MS),
  // Fraction of the transmission window left at which the person is warned (the provider declares the window)
  WARN_REMAINING_RATIO: 0.25
} as const

// A document the authority refused is corrected and sent again within a day of the moment the refusal was communicated, with the same
// generation code. It is the rule of the authority that receives the documents, read here as data of core.
export const FiscalRejectionRetry = {
  WINDOW_MS: 24 * 60 * 60 * 1000,
  // From this long before the end of the window the person is told, once for each refusal (the daily check asks; a window already over is told too)
  WARN_BEFORE_MS: 12 * 60 * 60 * 1000
} as const

// The hourly look at the windows of the authority (D14b): a daily one cannot promise a warning 12 hours before the end of a 24-hour window
export const FiscalDeadlineSweep = {
  // Organizations one page of the scheduler reads
  ORGANIZATIONS_PAGE_SIZE: 200,
  // Attempts of the job of one organization when the infrastructure fails, and the pause between them (the next hour asks again anyway)
  JOB_ATTEMPTS: 2,
  JOB_BACKOFF_MS: 60_000
} as const

// Where a refused document stands against that window
export enum FiscalRejectionDeadlineState {
  OPEN = 'open',
  CLOSING = 'closing',
  EXPIRED = 'expired'
}

// What a provider declares about contingency in its manifest (`FiscalContingencyDeclaration`) is in its own words; these are core's reasons
// for refusing a person's action on a contingency (`details.reason`)
export const FiscalContingencyConflictReasons = {
  UNSUPPORTED: 'contingency_unsupported',
  ALREADY_OPEN: 'contingency_already_open',
  NOT_OPEN: 'contingency_not_open',
  UNKNOWN_REASON: 'contingency_unknown_reason',
  RESPONSIBLE_REQUIRED: 'contingency_responsible_required',
  NOT_CLOSED: 'contingency_not_closed',
  NOT_FAILED: 'contingency_report_not_failed',
  MOTIVE_TOO_LONG: 'contingency_motive_too_long'
} as const

export const FiscalEvidenceContentType = 'application/json'
// The type of the file of each kind: the representation is the only one that is not JSON
export const FiscalEvidenceContentTypes: Readonly<Record<FiscalEvidenceKind, string>> = {
  [FiscalEvidenceKind.DOCUMENT]: FiscalEvidenceContentType,
  [FiscalEvidenceKind.RESPONSE]: FiscalEvidenceContentType,
  [FiscalEvidenceKind.VOID_RESPONSE]: FiscalEvidenceContentType,
  [FiscalEvidenceKind.DTE_FILE]: FiscalEvidenceContentType,
  [FiscalEvidenceKind.REPRESENTATION]: 'application/pdf'
}

// The reasons core itself gives for a rejection (a provider's own are codes of its own, kept as they come)
export const FiscalRejectionReasons = {
  RECEIVER_INCOMPLETE: 'receiver_incomplete',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  BUILD_FAILED: 'build_failed',
  CREDENTIALS_UNREADABLE: 'credentials_unreadable',
  // The lines, the shipping, the discount and the tax of the sale do not add up to its total: no provider is asked to sign it
  SALE_INCONSISTENT: 'sale_inconsistent',
  // The issuer was changed (its provider or its environment) after this document was made: a person retries it and it is made again
  // with the issuer as it is now
  ISSUER_CHANGED: 'issuer_changed',
  // A provider answered "accepted" with no number, or in a shape the port does not allow: nothing is kept of it as an acceptance
  PROVIDER_ANSWER_INVALID: 'provider_answer_invalid',
  // A credit note whose original document was voided: a person retries it and it names the document that replaced the original
  ORIGINAL_VOIDED: 'original_voided',
  // The units of a return do not fit the sale they came from (more units back than were sold): no provider is asked to sign it
  RETURN_INCONSISTENT: 'return_inconsistent',
  // The series the provider numbers this document in has no number left: no document is sent that could carry a repeated one
  SEQUENCE_EXHAUSTED: 'sequence_exhausted'
} as const

// Why a person's action on a document is refused with a conflict (`details.reason`), for the interface to tell them apart
export const FiscalConflictReasons = {
  // Another invalidation of the same document is being sent: one at a time
  VOID_IN_PROGRESS: 'void_in_progress',
  // A sale document with credit notes that are not voided: the notes go first
  HAS_CREDIT_NOTES: 'has_credit_notes',
  // The picture of a document is larger than what is drawn (a text or a number of items beyond the bound): the person gives the receiver the
  // file of the document by another way and the provider is told
  REPRESENTATION_TOO_LARGE: 'representation_too_large',
  // A voided sale document that already has the document that replaces it
  ALREADY_REPLACED: 'already_replaced',
  // The receiver of a credit note is the one of the document it cancels: it is fixed there
  CREDIT_NOTE_RECEIVER: 'credit_note_receiver',
  // The sealed receiver cannot be read and the change does not carry the whole receiver: it would be merged over nothing and drop what
  // was stored (the tax id first)
  RECEIVER_UNREADABLE: 'receiver_unreadable',
  // A credit note whose sale document was voided and has no replacement yet
  ORIGINAL_VOIDED: FiscalRejectionReasons.ORIGINAL_VOIDED,
  // The units of a return still do not fit its sale
  RETURN_INCONSISTENT: FiscalRejectionReasons.RETURN_INCONSISTENT,
  // The issuer of the document is the one it was made with: there is no change to confirm (a retry does it)
  NO_ISSUER_CHANGE: 'no_issuer_change',
  // The document may be at the issuer it was made with, which was changed since: a person confirms that it is not there
  ISSUER_CHANGED_IN_FLIGHT: 'issuer_changed_in_flight',
  // A credit note that is not voided, or that is not the one of its return
  NOTE_NOT_VOIDED: 'note_not_voided',
  // The provider of the document asks for no replacement before an invalidation: the replacement is made once the document is voided
  REPLACE_FIRST_UNAVAILABLE: 'replace_first_unavailable',
  // An original and its replacement are both alive (the replacement was made first): the original is invalidated before anything else is
  // made for the sale
  REPLACEMENT_PENDING: 'replacement_pending',
  // The return of a credit note has a live note already
  NOTE_ALREADY_REPLACED: 'note_already_replaced',
  // The order has no tax snapshot (it was made before the tax columns): no sale document is made of it with a tax of 0
  TAX_SNAPSHOT_MISSING: 'tax_snapshot_missing'
} as const

// The type of a document that has not been built yet: the provider picks the real one when it builds (its rule, not core's)
export const FiscalPendingDocumentType = 'pending'

// What a provider says about a document it may have received (the answer to a consultation)
export enum FiscalConsultState {
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  // The provider has no such document: it was never received
  UNKNOWN = 'unknown'
}

// The parts a series of correlatives can be made of, as the series view names them (what a provider's manifest declares it counts by)
export const FiscalSeriesScopeKeys = {
  PROVIDER: 'providerId',
  ENVIRONMENT: 'environment',
  DOCUMENT_TYPE: 'documentType',
  ESTABLISHMENT: 'establishmentCode',
  POINT_OF_SALE: 'pointOfSaleCode'
} as const

// Why a person invalidates an accepted document, in the platform's own words (a provider maps it to the code of its authority): the
// document had wrong information, the operation was cancelled (rescinded), or another reason the person writes down (Step 4B.7c-4)
export enum FiscalVoidKind {
  CORRECTION = 'correction',
  RESCISSION = 'rescission',
  OTHER = 'other'
}

// What a provider says about the invalidation of an accepted document (the answer to a void consultation, Step 4B.7b-2)
export enum FiscalVoidConsultState {
  // The authority has the document invalidated: a void whose answer was lost, or one made elsewhere
  VOIDED = 'voided',
  NOT_VOIDED = 'not_voided',
  // The provider cannot tell
  UNKNOWN = 'unknown'
}

// The environments in which a provider that signs nothing real (a simulator) may be registered: closed by default, so a staging
// deployment or a process whose NODE_ENV is not set never gets one
export const FiscalSimulatorEnvironments: readonly string[] = ['development', 'test']

// The fiscal data of a customer (Step 4B.7b-3): what the store keeps about whom it invoices, apart from the contact data of the
// customer. The limits are core's (a sane size for a text kept sealed); what a value must look like is the provider's rule.
export const FiscalCustomerDataLimits = {
  VALUE_MAX_LENGTH: 200,
  ID_MAX_LENGTH: 40,
  ADDRESS_MAX_FIELDS: 12,
  ADDRESS_KEY_MAX_LENGTH: 40
} as const

// The daily check of the fiscal documents (TDD_18 §8.3, §11; Step 4B.8b-2b). It finds what the lifecycle lost and asks the queue for it; it
// never submits a document itself, and the simulator or the provider the issuer names is the only thing that ever emits one.
export enum FiscalSweepKind {
  // A sale the issuer's setting says must have a document, and none was ever made (the listener runs in process and logs its failure)
  SALE_WITHOUT_DOCUMENT = 'sale_without_document',
  // A document left QUEUED (the attempts of its job ran out) or SUBMITTED (the worker died after the claim): the job is asked again
  STALLED_DOCUMENT = 'stalled_document',
  // A return that was received on a documented sale and has no credit note
  CREDIT_NOTE_MISSING = 'credit_note_missing',
  // A sale document whose total or tax differs from the entry of the books that holds the same sale: only a person looks at it
  ENTRY_MISMATCH = 'entry_mismatch'
}

// What differs between a sale document and its entry
export enum FiscalEntryMismatchField {
  TOTAL = 'total',
  TAX = 'tax'
}

export const FiscalSweepLimits = {
  // How far back the check looks for a sale or a return with no document, never before the first sale document of the organization
  LOOKBACK_DAYS: 120,
  // The size of a page of findings the check reads (the report asks for at most `PAGE_SIZE_MAX`)
  RUN_PAGE_SIZE: 200,
  // The entry check reads documents this many at a time, and at most `ENTRY_SCAN_MAX` of them in one call (a call that stops there says where to go on)
  ENTRY_SCAN_PAGE: 200,
  ENTRY_SCAN_MAX: 2_000,
  // Pages of that size one run reads for each kind: the pages go on past findings nobody can act on, so they cannot starve the ones behind
  MAX_PAGES_PER_KIND: 25,
  // The dry run (the report of the findings): rows one page gives
  PAGE_SIZE_DEFAULT: 50,
  PAGE_SIZE_MAX: 200,
  // A document is "left" when it did not move for this long: a retry with backoff waits for less, and a claim lives five minutes
  QUEUED_STALL_MINUTES: 60,
  SUBMITTED_STALL_MINUTES: 15
} as const

// Which sealed value of the fiscal area a log line says could not be opened (the label an operator filters on after a key change)
export const SealedValueKind = {
  RECEIVER: 'receiver',
  BUILT_PAYLOAD: 'built-payload',
  ISSUER_CREDENTIALS: 'issuer-credentials',
  CUSTOMER_DATA: 'customer-data',
  RESPONSIBLE: 'responsible'
} as const
export type SealedValueKind = (typeof SealedValueKind)[keyof typeof SealedValueKind]

// How often the same sealed value that does not open is logged (Step 7.3-S11b-2): a document that cannot be opened is tried again by every
// retry of the submit, and a line per try would bury the rest. One line per value, cause and window; the map that remembers them is bounded.
export const SealedOpenLog = {
  WINDOW_MS: 15 * 60 * 1000,
  MAX_REMEMBERED: 1000
} as const

// The re-seal of the fiscal values after a rotation of CREDENTIALS_ENCRYPTION_KEY (Step 7.3-S11b). The names are the database's: the
// function that swaps the sealed columns of a decided document and the transaction-local setting that only that function turns on
export const FiscalReseal = {
  FUNCTION: 'fiscal_reseal_document',
  SETTING: 'app.fiscal_reseal',
  // Rows read and swapped per page of one organization, and the most one run of one organization touches (the next run goes on)
  PAGE_SIZE: 100,
  // The most values of one kind that one run of one organization seals again (or fails on): the rows already current are only skipped and
  // do not count, so the next run reaches the rest
  MAX_VALUES_PER_KIND: 5000,
  // The rows of one run whose failed mask is named in the log (the rest are only counted)
  MAX_MASK_FAILURES_LOGGED: 20,
  // The most rows of one run that the step of the masks reads (the ones nobody opens are read again each night)
  MAX_MASK_ROWS_READ: 50_000
} as const

// What the re-seal did with one value, and the failure code of an error that is not a cipher failure (a write the database refused)
export const FiscalResealOutcome = {
  CURRENT: 'current',
  RESEALED: 'resealed',
  CONFLICT: 'conflict'
} as const
export type FiscalResealOutcome = (typeof FiscalResealOutcome)[keyof typeof FiscalResealOutcome]
export const FISCAL_RESEAL_WRITE_FAILED = 'write_failed'
// The value was sealed again but the new one did not open to the same content: nothing was written
export const FISCAL_RESEAL_MISMATCH = 'reseal_mismatch'
