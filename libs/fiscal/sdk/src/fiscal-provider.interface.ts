import type {
  FiscalConsultState,
  FiscalEnvironment,
  FiscalSubmitOutcome
} from '@platform/core/domain'

// The port of a provider of fiscal documents (TDD_18 §8.1). Core owns the lifecycle, the queue and the link to the ledger; a provider
// package owns everything legal and country-specific: the document types, the format, the signature and the authority's answer.
// Core never sees a signature algorithm, a control number format or an endpoint, and no provider is named outside its own package.

// A field a document type asks of the receiver (the customer), named by the provider in the words of its own manifest
export interface FiscalDocumentTypeDeclaration {
  // Plain data the provider owns (the authority's own name for the document); core stores it and never branches on it
  readonly id: string
  readonly label: string
  // The fields of the receiver this type cannot be built without
  readonly requiredReceiverFields: readonly FiscalReceiverField[]
  // A document of this type cancels another one (a credit note): reserved for the credit notes of a return (Step 4B.7b)
  readonly creditNote?: boolean
}

export type FiscalReceiverField =
  'name' | 'taxId' | 'registrationId' | 'address' | 'email' | 'phone'

export type FiscalIssuerField =
  'legalName' | 'taxId' | 'registrationId' | 'address' | 'activityCode' | 'establishmentCode'

export interface FiscalProviderManifest {
  readonly documentTypes: readonly FiscalDocumentTypeDeclaration[]
  readonly requiredIssuerFields: readonly FiscalIssuerField[]
  // The names of the credentials the provider reads (never their values), so the settings screen and the log redaction know them
  readonly credentialKeys: readonly string[]
  readonly environments: readonly FiscalEnvironment[]
}

// What core hands a provider about the issuer. Credentials are decrypted for the provider's call only and never leave it.
export interface FiscalIssuerInput {
  readonly legalName: string
  readonly taxId: string
  readonly registrationId: string | null
  readonly address: Readonly<Record<string, unknown>>
  readonly activityCode: string | null
  readonly establishmentCode: string | null
  readonly environment: FiscalEnvironment
}

export interface FiscalIssuerCredentials {
  readonly credentials: Readonly<Record<string, unknown>>
}

export interface IssuerCheck {
  readonly ok: boolean
  // Codes of what is missing or unreadable (a field, a certificate), never a credential value
  readonly problems: readonly string[]
}

export interface FiscalReceiver {
  readonly name: string | null
  readonly taxId: string | null
  readonly registrationId: string | null
  readonly address: Readonly<Record<string, string>> | null
  readonly email: string | null
  readonly phone: string | null
}

export interface FiscalLine {
  readonly description: string
  readonly quantity: number
  readonly unitPriceCents: number
  // Basis points; null for a line that carries no tax
  readonly taxRateBps: number | null
  readonly taxCents: number
  readonly totalCents: number
}

export interface FiscalBuildInput {
  readonly sequenceNumber: number
  readonly issuedAt: string
  readonly orderNumber: string
  readonly currency: string
  readonly issuer: FiscalIssuerInput
  readonly receiver: FiscalReceiver
  readonly lines: readonly FiscalLine[]
  readonly shippingCents: number
  readonly shippingTaxCents: number
  // What the order took off, once, for the whole document (the tax of the lines is already after it)
  readonly discountCents: number
  readonly totalCents: number
  readonly taxCents: number
}

export interface BuiltDocument {
  readonly documentType: string
  // The document as the provider will sign and send it: the legal evidence, kept as it is
  readonly payload: Readonly<Record<string, unknown>>
  // What the receiver's data lacks for this type: not an error of the provider, a thing a person can fix
  readonly missingReceiverFields: readonly FiscalReceiverField[]
}

export interface ProviderContext {
  readonly issuer: FiscalIssuerInput
  readonly credentials: Readonly<Record<string, unknown>>
  // One key per SUBMISSION of a document: it is the same on every attempt of that submission (the retries while the authority is down),
  // so a provider answers a repeated key with the first answer and never makes a second document. A document that was REJECTED and fixed
  // is a new submission and gets a new key, so a provider never answers a corrected document with the cached rejection.
  readonly idempotencyKey: string
  // 1 for the first attempt of the submission
  readonly attempt: number
}

// The answer of a submission, one shape per outcome so that what core stores is always complete: an accepted document has its number
// (without it the document could not be voided), a refused one has its code
export type SubmitResult =
  | {
      readonly outcome: FiscalSubmitOutcome.ACCEPTED
      readonly externalNumber: string
      // Opaque to core (generation code, control number, seal ...)
      readonly providerData?: Readonly<Record<string, unknown>>
      // What the authority answered: kept with the document
      readonly response?: Readonly<Record<string, unknown>>
    }
  | {
      readonly outcome: FiscalSubmitOutcome.REJECTED
      // A code, never customer data
      readonly reason: string
      readonly response?: Readonly<Record<string, unknown>>
    }
  // The authority is down or did not answer: the document stays queued
  | { readonly outcome: FiscalSubmitOutcome.UNAVAILABLE }

export interface VoidResult {
  readonly voided: boolean
  readonly reason?: string
  readonly response?: Readonly<Record<string, unknown>>
}

export type ConsultResult =
  | {
      readonly state: FiscalConsultState.ACCEPTED
      readonly externalNumber: string
      readonly providerData?: Readonly<Record<string, unknown>>
      readonly response?: Readonly<Record<string, unknown>>
    }
  | {
      readonly state: FiscalConsultState.REJECTED
      readonly reason: string
      readonly response?: Readonly<Record<string, unknown>>
    }
  | { readonly state: FiscalConsultState.UNKNOWN }

export interface StoredFiscalDocument {
  readonly documentType: string
  readonly externalNumber: string | null
  readonly providerData: Readonly<Record<string, unknown>> | null
  readonly payload: Readonly<Record<string, unknown>>
}

export interface ContingencyPolicy {
  // What a person reads about what the provider does while the authority is down (the queue keeps the document and retries)
  readonly description: string
}

export interface FiscalDocumentProvider {
  readonly id: string
  readonly countryCode: string
  readonly manifest: FiscalProviderManifest
  // Credentials and certificate readable and the issuer fields present; never reaches the authority with a real document
  validateIssuer(
    issuer: FiscalIssuerInput,
    credentials: FiscalIssuerCredentials
  ): Promise<IssuerCheck>
  // Pure: the sale and the issuer become the document (the choice of the type is the provider's rule)
  build(input: FiscalBuildInput): Promise<BuiltDocument>
  // Sign, send, return the answer. The same ProviderContext.idempotencyKey never makes two documents.
  submit(built: BuiltDocument, ctx: ProviderContext): Promise<SubmitResult>
  // The state of a document the provider may or may not have received (a submission that timed out): asked before a second submission
  consult(built: BuiltDocument, ctx: ProviderContext): Promise<ConsultResult>
  // The invalidation event of an accepted document
  void(doc: StoredFiscalDocument, reason: string, ctx: ProviderContext): Promise<VoidResult>
  readonly contingency?: ContingencyPolicy
}
