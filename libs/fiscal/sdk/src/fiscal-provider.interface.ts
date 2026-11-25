import type {
  FiscalConsultState,
  FiscalContingencyReportOutcome,
  FiscalDeferOutcome,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalOperationCondition,
  FiscalSubmitOutcome,
  FiscalVoidConsultState,
  FiscalVoidKind,
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
  // A document of this type charges more on another one: it is the type of the debit note, which `build` picks when it is told the document
  // is one (`FiscalBuildInput.kind`). Never both this and `creditNote`.
  readonly debitNote?: boolean
  // A document of this type backs goods that travel before the document of their sale exists: it is the type of the remission note, which
  // `build` picks when it is told the document is one (`FiscalBuildInput.kind`). It is no sale (it never enters a book of sales) and it
  // cancels nothing. Never together with `creditNote` or `debitNote`.
  readonly remissionNote?: boolean
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
  // What the provider's authority asks a person for when an accepted document is invalidated. Absent: the reason alone is enough.
  readonly voidInputs?: FiscalVoidInputsDeclaration
  // What the provider's authority lets an issuer do while it cannot be reached (Step 4B.7c-7). Absent: the provider has no deferred model
  // and a document waits in the queue for the authority.
  readonly contingencyMode?: FiscalContingencyDeclaration
  // The lists of values the provider's authority defines (a kind of establishment, an economic activity, a kind of identity document), by
  // the provider's own name for each list. The settings screen draws a select from one, so a person picks a code instead of typing it and
  // the screen knows no catalog of any country (Step 4B.7c-5).
  readonly catalogs?: Readonly<Record<string, readonly FiscalCatalogOption[]>>
  // Which catalog an issuer field is chosen from; a field with no entry is typed
  readonly issuerFieldCatalogs?: Readonly<Partial<Record<FiscalIssuerField, string>>>
}

// One value of a catalog: the code the provider reads and the words a person reads
export interface FiscalCatalogOption {
  readonly code: string
  readonly label: string
}

// Contingency, in the provider's words: the reasons the authority tells apart (core keeps the one a person picks and never reads it), the
// one that stands for "the authority is down" (the lifecycle uses it when it enters contingency by itself), the time the authority gives to
// send the documents of the lot once the event that reports it was accepted, and how many documents one event takes.
export interface FiscalContingencyDeclaration {
  readonly reasons: readonly string[]
  readonly authorityDownReason: string
  readonly transmitWithinHours: number
  // The time the authority gives to send the event once the situation that kept the documents from being sent has ended. Absent: the
  // authority sets none, and nothing is watched
  readonly reportWithinHours?: number
  readonly maxDocumentsPerEvent: number
  // The authority wants to know who answers for the establishment (the person who ends the contingency gives it)
  readonly requiresResponsible: boolean
}

// What `build` is told when the document is made in contingency: the document is made, signed and kept, and sent after the event
export interface FiscalBuildContingency {
  readonly reason: string
  // What the person wrote about it (the authority takes it for the reason that has no code of its own)
  readonly motive: string | null
}

// The answer to making a document in contingency: signed and kept, or not (a signature that cannot be made means the document is not
// made in contingency either, and nothing is handed to the receiver)
export type DeferResult =
  | {
      readonly outcome: FiscalDeferOutcome.DEFERRED
      // Opaque to core: what the provider keeps with the document (the signed document, its codes); a delivery to the receiver carries it
      readonly providerData?: Readonly<Record<string, unknown>>
    }
  | { readonly outcome: FiscalDeferOutcome.REJECTED; readonly reason: string }
  | { readonly outcome: FiscalDeferOutcome.UNAVAILABLE }

// The event that reports a contingency to the authority: the window and the documents made in it (stored, as they were built)
export interface FiscalContingencyEvent {
  // A stable identifier of the event, in the shape of a random UUID (version 4, lowercase): the same on every attempt to report it
  readonly eventId: string
  readonly reason: string
  readonly motive: string | null
  readonly startedAt: string
  readonly endedAt: string
  readonly documents: readonly StoredFiscalDocument[]
  // Who answers for the establishment, when the manifest says the authority asks
  readonly responsible: FiscalVoidParty | null
}

export type ContingencyReportResult =
  | {
      readonly outcome: FiscalContingencyReportOutcome.ACCEPTED
      // Opaque to core: the seal the authority gave the event, kept with the contingency
      readonly providerData?: Readonly<Record<string, unknown>>
      readonly response?: Readonly<Record<string, unknown>>
      // The instant the authority took the event, from which the window to send the documents runs (ISO 8601)
      readonly receivedAt: string
    }
  | {
      readonly outcome: FiscalContingencyReportOutcome.REJECTED
      readonly reason: string
      readonly response?: Readonly<Record<string, unknown>>
      // Nothing was sent (a credential that is missing, an event that is incomplete)
      readonly neverSent?: true
    }
  | { readonly outcome: FiscalContingencyReportOutcome.UNAVAILABLE }

// What an invalidation asks of the person (Step 4B.7c-4): the screen draws the fields from this, and core passes what was typed on
export interface FiscalVoidInputsDeclaration {
  // The reasons the authority tells apart (the person picks one)
  readonly kinds: readonly FiscalVoidKind[]
  // The authority wants to know who makes the invalidation and who asks for it
  readonly requiresParties: boolean
  // The reasons that name the document that takes the place of the invalidated one (the authority wants it first)
  readonly kindsWithReplacement?: readonly FiscalVoidKind[]
  // The catalog the kind of identity document of the two people is chosen from; absent: typed
  readonly identityCatalog?: string
  // The longest reason the authority takes; the screen counts with it (core's own limit is wider)
  readonly reasonMaxLength?: number
}

// A person who takes part in an invalidation, in the words of the provider's own catalog of identity documents
export interface FiscalVoidParty {
  readonly name: string
  readonly idType: string
  readonly idNumber: string
}

// What a person gives besides the reason. Every part is optional for core; the provider refuses (with a code, nothing sent) what its
// authority requires and is not here.
export interface FiscalVoidDetails {
  readonly kind?: FiscalVoidKind
  readonly responsible?: FiscalVoidParty
  readonly requester?: FiscalVoidParty
  // The accepted document that takes the place of the one invalidated
  readonly replacement?: StoredFiscalDocument
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
  // The sale, the credit note of a return, a debit note or a remission note: the provider picks the type of document by its own rule (a
  // credit note has the type its manifest marks as `creditNote`, a debit note the one it marks as `debitNote`, a remission note the one it
  // marks as `remissionNote`)
  readonly kind: FiscalDocumentKind
  // Set for a credit note or a debit note, null for the document of a sale
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
  // Set when the document is made in contingency (the deferred model): the provider marks it so and the authority takes it after the event
  readonly contingency?: FiscalBuildContingency
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
      // The provider refused it itself and nothing was sent (a credential that is missing, a document that is incomplete): it is not a
      // refusal of the authority, so the attempt is given back and the document reads as one that never left
      readonly neverSent?: true
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

// What a provider hands back to be shown to the receiver of a document (the graphic representation of a tax authority that asks for
// one): a model of plain text and numbers, never a layout. Core draws it as a PDF without knowing what any field means. Every text is
// already the provider's own words (the names of the fields are the authority's, written in the language of the document).
export interface FiscalRepresentationRow {
  readonly label: string
  readonly value: string
}

export interface FiscalRepresentationSection {
  readonly heading: string
  readonly rows: readonly FiscalRepresentationRow[]
}

export interface FiscalRepresentationTable {
  readonly columns: readonly string[]
  // Columns that hold an amount are aligned to the right
  readonly numericColumns: readonly number[]
  // The column that takes the room the others leave (the description of an item)
  readonly wideColumn: number
  readonly rows: readonly (readonly string[])[]
}

// The file the receiver is given next to the picture, exactly as the authority defines it
export interface FiscalDeliveryFile {
  readonly filename: string
  readonly content: Readonly<Record<string, unknown>>
}

export interface FiscalRepresentation {
  readonly title: string
  // What the files of the document are named, without the extension (the authority names them by the code of generation)
  readonly name: string
  // Lines shown in a band on top (for instance that a document of a test environment has no legal value); empty when there is none
  readonly notices: readonly string[]
  readonly sections: readonly FiscalRepresentationSection[]
  readonly table: FiscalRepresentationTable | null
  // The summary, drawn after the table
  readonly totals: readonly FiscalRepresentationRow[]
  // Free lines after the totals (the amount in words, observations)
  readonly footnotes: readonly FiscalRepresentationRow[]
  // The address the code the receiver scans leads to; null when the authority has none
  readonly qrUrl: string | null
  // The file of the document as the authority defines it (the receiver is given it with the picture); null when it has none
  readonly file: FiscalDeliveryFile | null
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
  // provider without it accepts any value within core's limits. A problem of `taxId` must depend only on `taxId` and `documentType`: core
  // does not judge a tax id again when only another field changes.
  validateReceiver?(receiver: FiscalReceiver): readonly FiscalReceiverProblem[]
  // Pure, optional: whether a tax id written for a party that is not a receiver (a supplier) has the shape the country of the provider
  // uses, as its document shows it. Core calls it when a person writes one; a provider without it accepts any value within core's limits. The answer must depend on the value alone.
  validatePartyTaxId?(taxId: string): boolean
  // Pure, required when the manifest declares `sequence.perDocumentType`: the id of the type `build` will pick for this sale. It must
  // answer exactly what `build` puts in `BuiltDocument.documentType` for the same kind and receiver (the contract suite checks it).
  resolveDocumentType?(input: FiscalTypeInput): string
  // Pure, optional: what the receiver is shown of an ACCEPTED document, made only from the document as it was kept (its built payload and
  // the data the provider wrote when the authority accepted it), so the same document always gives the same representation, whatever
  // changes later in the order or the issuer. Null for a type the provider has no representation for. A provider without it has none.
  represent?(doc: StoredFiscalDocument): FiscalRepresentation | null
  // Pure: the sale and the issuer become the document (the choice of the type is the provider's rule)
  build(input: FiscalBuildInput): Promise<BuiltDocument>
  // Sign, send, return the answer. The same ProviderContext.idempotencyKey never makes two documents.
  submit(built: BuiltDocument, ctx: ProviderContext): Promise<SubmitResult>
  // The state of a document the provider may or may not have received (a submission that timed out): asked before a second submission
  consult(built: BuiltDocument, ctx: ProviderContext): Promise<ConsultResult>
  // The invalidation event of an accepted document
  void(
    doc: StoredFiscalDocument,
    reason: string,
    ctx: ProviderContext,
    details?: FiscalVoidDetails
  ): Promise<VoidResult>
  // Whether the authority has an accepted document invalidated already: asked before a void is sent (the invalidation may have been made
  // elsewhere, or by an earlier request whose answer was lost) and after a void that got no answer. Optional: a provider that cannot tell
  // leaves it out and core goes by the answer of `void` alone.
  consultVoid?(doc: StoredFiscalDocument, ctx: ProviderContext): Promise<VoidConsultResult>
  readonly contingency?: ContingencyPolicy
  // Signs a document built in the deferred model and says whether it can be kept for the report (Step 4B.7c-7). Sends nothing. Required
  // when the manifest declares `contingencyMode`.
  deferDocument?(built: BuiltDocument, ctx: ProviderContext): Promise<DeferResult>
  // Reports a contingency with the documents made in it (Step 4B.7c-7). It is idempotent by `event.eventId`: an event the authority took
  // already (an answer that was lost) is answered with what the authority holds (ACCEPTED, the seal and the instant it took it), never as a
  // refusal, because core asks again after a call that got no answer and a refusal would leave the lot held for good.
  // Required when the manifest declares `contingencyMode`; the registry refuses a provider that declares one and cannot report it.
  reportContingency?(
    event: FiscalContingencyEvent,
    ctx: ProviderContext
  ): Promise<ContingencyReportResult>
}
