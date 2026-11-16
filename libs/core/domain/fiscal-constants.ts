import { FiscalDocumentStatus } from './finance-constants'

// Fiscal documents (TDD_18 §8), Step 4B.7. Constants only: core owns the lifecycle and the link to the ledger, a provider package owns
// everything legal and country-specific, so nothing here names a country, an authority or a provider.

// After ACCEPTED the document is the legal evidence: no field of it changes but the status to VOIDED
export const FiscalDocumentImmutableStatuses: readonly FiscalDocumentStatus[] = [
  FiscalDocumentStatus.ACCEPTED,
  FiscalDocumentStatus.VOIDED
]

export enum FiscalEnvironment {
  SANDBOX = 'sandbox',
  PRODUCTION = 'production'
}

// When the document of a sale is made: owner and accountant decide (TDD_18 §13 row 3); the default follows the sale's recognition
export enum FiscalIssueOn {
  DELIVERED = 'delivered',
  SHIPPED = 'shipped'
}

export const FiscalLimits = {
  // Attempts of the job; the provider's own contingency decides what an attempt does while the authority is down
  MAX_ATTEMPTS: 6,
  BACKOFF_MS: 60_000,
  REASON_MAX_LENGTH: 500,
  // What a provider may hand back of the authority's answer, as text: more is cut (a provider may copy the whole body of the authority)
  RESPONSE_MAX_CHARS: 16_000,
  VOID_REASON_MAX_LENGTH: 500,
  FAILED_JOB_KEEP_SECONDS: 7 * 24 * 60 * 60,
  // The correlative is an INTEGER of the database
  MAX_SEQUENCE: 2_000_000_000,
  // A submission that was claimed less than this ago is alive: another attempt is working on it. Older, its worker died and it is taken over.
  CLAIM_LEASE_MS: 5 * 60 * 1000,
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
  DOCUMENT: 'fiscal_document'
} as const

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
  ISSUER_CHANGED: 'issuer_changed'
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

// The environments in which a provider that signs nothing real (a simulator) may be registered: closed by default, so a staging
// deployment or a process whose NODE_ENV is not set never gets one
export const FiscalSimulatorEnvironments: readonly string[] = ['development', 'test']
