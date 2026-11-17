import type {
  FiscalConsultState,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalOperationCondition,
  FiscalSubmitOutcome,
  FiscalVoidConsultState,
  PaymentMethod,
  TaxTreatment
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
  // A document of this type cancels (part of) another one: it is the type of the credit note of a return, which `build` picks when it is
  // told the document is one (`FiscalBuildInput.kind`)
  readonly creditNote?: boolean
}

export type FiscalReceiverField =
  | 'name'
  | 'taxId'
  | 'registrationId'
  | 'address'
  | 'email'
  | 'phone'
  | 'taxpayerType'
  | 'economicActivity'
  | 'documentType'

// What a provider finds wrong in the fiscal data of a customer: the field and a code of the provider's own, never the value
export interface FiscalReceiverProblem {
  readonly field: FiscalReceiverField
  readonly code: string
}

export type FiscalIssuerField =
  | 'legalName'
  | 'taxId'
  | 'registrationId'
  | 'address'
  | 'activityCode'
  | 'establishmentCode'
  | 'establishmentType'
  | 'pointOfSaleCode'
  | 'phone'
  | 'email'

// What a correlative counts, declared by the provider (the law of a country says whether a document type, an establishment or a point of
// sale has a series of its own). Core keeps one counter per distinct combination of what is declared here, of the provider and of the
// environment, and hands the next number to `build`; a manifest that declares nothing has one counter for the organization, which is
// how documents were numbered before this existed. Core never reads what the numbers mean: no format, no year, no padding.
export interface FiscalSequenceDeclaration {
  readonly perDocumentType?: boolean
  readonly perEstablishment?: boolean
  readonly perPointOfSale?: boolean
}

export interface FiscalProviderManifest {
  readonly documentTypes: readonly FiscalDocumentTypeDeclaration[]
  readonly requiredIssuerFields: readonly FiscalIssuerField[]
  // The names of the credentials the provider reads (never their values), so the settings screen and the log redaction know them
  readonly credentialKeys: readonly string[]
  readonly environments: readonly FiscalEnvironment[]
  // The scope of the correlative (see `FiscalSequenceDeclaration`). A provider that declares `perDocumentType` must implement
  // `resolveDocumentType`: core asks for the type before it takes the number, and the registry refuses a provider that does not.
  readonly sequence?: FiscalSequenceDeclaration
}

// What core hands a provider about the issuer. Credentials are decrypted for the provider's call only and never leave it.
export interface FiscalIssuerInput {
  readonly legalName: string
  readonly taxId: string
  readonly registrationId: string | null
  readonly address: Readonly<Record<string, unknown>>
  readonly activityCode: string | null
  readonly establishmentCode: string | null
  // The kind of establishment and the code of the point of sale the document is made at, in the words of the provider's own manifest
  // (core stores them and never reads them), and the contact of the issuer. Null until the owner sets them: what a provider needs of them
  // is declared in `requiredIssuerFields`.
  readonly establishmentType: string | null
  readonly pointOfSaleCode: string | null
  readonly phone: string | null
  readonly email: string | null
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
  // The kind of taxpayer and the economic activity, in the words of the provider's own manifest (core stores them and never reads them).
  // Optional: a receiver made before they existed, or for a provider that does not ask for them, leaves them out.
  readonly taxpayerType?: string | null
  readonly economicActivity?: string | null
  // The kind of the identity document of `taxId` (a tax number, a national id, a passport ...), in the words of the provider's manifest
  readonly documentType?: string | null
}

export interface FiscalLine {
  readonly description: string
  readonly quantity: number
  readonly unitPriceCents: number
  // Basis points; null for a line that carries no tax
  readonly taxRateBps: number | null
  readonly taxCents: number
  readonly totalCents: number
  // How the line was taxed when the order was made (the snapshot of the order): taxed, exempt or not subject. Null on a line of an order
  // that predates the snapshot, which carries no tax: the provider decides what that means for its document.
  readonly taxTreatment: TaxTreatment | null
  // What the line is and its unit of measure, in the words of the provider's own manifest. Optional and null until the catalog of the
  // store keeps them: a provider falls back on the default it declares (a unit, goods or services).
  readonly itemKind?: string | null
  readonly unit?: string | null
}

// How the order was paid, in core's words: the provider maps the method to the catalog of its own
export interface FiscalPayment {
  readonly method: PaymentMethod
  readonly amountCents: number
  // The number of a transfer or a deposit recorded by hand
  readonly reference: string | null
}

// The accepted document that a credit note cancels (part of): what the provider needs to name it, in the words the provider gave it
export interface FiscalCreditedDocument {
  readonly documentType: string
  readonly externalNumber: string
  readonly issuedAt: string
  // Opaque to core: what the provider kept when it accepted the original (generation code, seal ...)
  readonly providerData: Readonly<Record<string, unknown>> | null
}

export interface FiscalBuildInput {
  // The sale, or the credit note of a return: the provider picks the type of document by its own rule (a credit note has the type its
  // manifest marks as `creditNote`)
  readonly kind: FiscalDocumentKind
  // Set for a credit note, null for the document of a sale
  readonly credited: FiscalCreditedDocument | null
  // The correlative of the organization (the order the documents were made in). Never the number a legal document carries unless the
  // provider declares no scope of its own: see `correlative`.
  readonly sequenceNumber: number
  // The number the provider writes in the document: from the counter its manifest's `sequence` scope names (the next number of that
  // series, kept for this document across every attempt and every submission, so a document refused and corrected keeps its number),
  // or `sequenceNumber` when the manifest declares no scope.
  readonly correlative: number
  // A stable identifier of the document, in the shape of a random UUID (version 4, lowercase), derived from the organization and the
  // document: the same on every attempt, every submission and every build of it, so a document sent again after a refusal is the same
  // document for the authority. A provider that needs another casing or another shape derives it from this one.
  readonly documentUuid: string
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
  // Whether the unit prices and the shipping fee of the order already hold their tax (the default of a store) or the tax comes on top of
  // them. The amounts of `lines` are the order's own either way: `totalCents` of a line is `quantity x unitPriceCents`, its `taxCents` is
  // inside that amount when this is true.
  readonly pricesIncludeTax: boolean
  // How it was paid: one entry for the whole order today (the order records one method). The condition is core's reading of the status
  // of the payment, which a provider may refine from `payments`.
  readonly payments: readonly FiscalPayment[]
  readonly condition: FiscalOperationCondition
}

// What a provider needs to say which type of document a sale or a credit note is: the choice never depends on anything else, so core
// can ask for it before it takes the number of the series of that type
export interface FiscalTypeInput {
  readonly kind: FiscalDocumentKind
  readonly receiver: FiscalReceiver
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

export interface VoidConsultResult {
  readonly state: FiscalVoidConsultState
  // What the authority answered: kept as the evidence of the void when the state is VOIDED
  readonly response?: Readonly<Record<string, unknown>>
}

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
  // Pure, optional: what is wrong in the fiscal data of a customer, by the rules of the provider (the format of a tax id, the values a kind
  // of taxpayer may take). Core calls it when a person saves the data of a customer, so the format of a country is never core's. A
  // provider without it accepts any value within core's limits.
  validateReceiver?(receiver: FiscalReceiver): readonly FiscalReceiverProblem[]
  // Pure, required when the manifest declares `sequence.perDocumentType`: the id of the type `build` will pick for this sale. It must
  // answer exactly what `build` puts in `BuiltDocument.documentType` for the same kind and receiver (the contract suite checks it).
  resolveDocumentType?(input: FiscalTypeInput): string
  // Pure: the sale and the issuer become the document (the choice of the type is the provider's rule)
  build(input: FiscalBuildInput): Promise<BuiltDocument>
  // Sign, send, return the answer. The same ProviderContext.idempotencyKey never makes two documents.
  submit(built: BuiltDocument, ctx: ProviderContext): Promise<SubmitResult>
  // The state of a document the provider may or may not have received (a submission that timed out): asked before a second submission
  consult(built: BuiltDocument, ctx: ProviderContext): Promise<ConsultResult>
  // The invalidation event of an accepted document
  void(doc: StoredFiscalDocument, reason: string, ctx: ProviderContext): Promise<VoidResult>
  // Whether the authority has an accepted document invalidated already: asked before a void is sent (the invalidation may have been made
  // elsewhere, or by an earlier request whose answer was lost) and after a void that got no answer. Optional: a provider that cannot tell
  // leaves it out and core goes by the answer of `void` alone.
  consultVoid?(doc: StoredFiscalDocument, ctx: ProviderContext): Promise<VoidConsultResult>
  readonly contingency?: ContingencyPolicy
}
