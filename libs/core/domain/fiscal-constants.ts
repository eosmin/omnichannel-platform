import { FiscalDocumentStatus } from './finance-constants'

// Fiscal documents (TDD_18 §8), Step 4B.7. Constants only: core owns the lifecycle and the link to the ledger, a provider package owns
// everything legal and country-specific, so nothing here names a country, an authority or a provider.

// After ACCEPTED the document is the legal evidence: no field of it changes but the status to VOIDED
export const FiscalDocumentImmutableStatuses: readonly FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOIDED
]

// What a document is for: the document of a sale, or the credit note of a return, which cancels part (or all) of the sale document it
// names. A provider's own document types (`FiscalDocumentTypeDeclaration`) stay the provider's; this is core's word for the relation.
export enum FiscalDocumentKind {
  SALE = 'sale',
  CREDIT_NOTE = 'credit_note'
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
  VOID_RESPONSE = 'void_response'
}

// How the sale was paid, in core's words, for a provider whose document says it (the provider maps it to its own catalog). Core derives
// it from the payment status of the order: a payment that is COMPLETED is immediate, anything else is deferred. **[ACCOUNTANT]** A sale
// paid on delivery, or in parts, may be another condition in a country that has one: the provider reads the payments to say so.
export enum FiscalOperationCondition {
  IMMEDIATE = 'immediate',
  DEFERRED = 'deferred'
}

export const FiscalLimits = {
  // A file of evidence larger than this is not made (the sealed copy in the row stays, which is what the document is): a provider whose
  // document is this big is a fault to read in the logs
  EVIDENCE_MAX_BYTES: 4 * 1024 * 1024,
  // Attempts of the job; the provider's own contingency decides what an attempt does while the authority is down
  MAX_ATTEMPTS: 6,
  BACKOFF_MS: 60_000,
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

export const FiscalResourceTypes = {
  ISSUER: 'fiscal_issuer',
  DOCUMENT: 'fiscal_document',
  CUSTOMER_DATA: 'customer_fiscal_data'
} as const

export const FiscalEvidenceContentType = 'application/json'

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
  // A sale document with credit notes that are not voided: the notes go first
  HAS_CREDIT_NOTES: 'has_credit_notes',
  // A voided sale document that already has the document that replaces it
  ALREADY_REPLACED: 'already_replaced',
  // The receiver of a credit note is the one of the document it cancels: it is fixed there
  CREDIT_NOTE_RECEIVER: 'credit_note_receiver',
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
  // The return of a credit note has a live note already
  NOTE_ALREADY_REPLACED: 'note_already_replaced'
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
