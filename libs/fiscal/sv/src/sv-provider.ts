import type { FiscalAuthorityProbeOutcome, FiscalVoidKind } from '@platform/core/domain'
import type {
  BuiltDocument,
  ConsultResult,
  ContingencyPolicy,
  FiscalBatchConsultResult,
  FiscalBatchRequest,
  FiscalBatchSendResult,
  ContingencyReportResult,
  DeferResult,
  FiscalContingencyEvent,
  FiscalBuildInput,
  FiscalDocumentProvider,
  FiscalIssuerCredentials,
  FiscalIssuerInput,
  FiscalProviderManifest,
  FiscalRepresentation,
  FiscalReceiver,
  FiscalPurchaseDocumentInput,
  FiscalReceiverProblem,
  FiscalTypeInput,
  FiscalVoidDetails,
  IssuerCheck,
  ProviderContext,
  StoredFiscalDocument,
  StoredVoidedDocument,
  SubmitResult,
  VoidConsultResult,
  VoidResult
} from '@platform/fiscal/sdk'

import { ACTIVITIES } from './catalogs/activities'
import { IDENTITY_DOCUMENTS } from './catalogs/identity-documents'
import { svAnnexes } from './sv-annex-exporter'
import { SvAuthenticator } from './sv-auth'
import { buildDocument, resolveDocumentType } from './sv-build'
import {
  SV_COUNTRY_CODE,
  SV_PROVIDER_ID,
  SvBatch,
  SvContingency,
  SvCredentialKeys,
  SvDocumentTypes,
  SvEnabledEnvironments,
  type SvEndpoints,
  SvInvalidation,
  SvIssuerProblems,
  SvTimeouts,
  SvUserAgent
} from './sv-constants'
import type { SvFetch } from './sv-http'
import { voidDeadlineOf } from './sv-invalidation'
import { issuerProblems, receiverProblems } from './sv-parties'
import { purchaseDocumentProblems } from './sv-purchase-document'
import { representDocument, representVoid } from './sv-representation'
import type { SvSigner } from './sv-signer'
import { isPlausiblePartyTaxId } from './sv-tax-id'
import {
  consultDocument,
  consultVoided,
  consultBatch,
  deferDocument,
  probeAuthority,
  reportContingencyEvent,
  submitBatch,
  submitDocument,
  voidDocument,
  type SvTransmissionDeps
} from './sv-transmission'

// What a taxpayer needs of a customer to make a tax credit document or a credit note
const BUSINESS_RECEIVER_FIELDS = [
  'name',
  'taxId',
  'registrationId',
  'economicActivity',
  'address'
] as const

// What a remission note needs of the person the goods are sent to: who they are, an identity document and the address (the activity is "other" when none)
const REMISSION_RECEIVER_FIELDS = ['name', 'taxId', 'address'] as const

// The provider of the electronic tax documents of El Salvador: Step 4B.7c-2 builds the documents and Step 4B.7c-3 sends and consults them.
// Step 4B.7c-4 invalidates them. The provider is offered where the deployment sets the address of its signing service
// (`FISCAL_SIGNER_URL`), which stays refused in production until the owner authorizes it (Step 4B.7c-8).
export interface SvProviderOptions {
  // Signs a document (the official signing service, or one of our own)
  readonly signer: SvSigner
  readonly fetch?: SvFetch
  readonly now?: () => number
  readonly userAgent?: string
  // The time the authority gets to answer a document (8 seconds): the specs shorten it
  readonly receptionTimeoutMs?: number
  // The endpoints of the authority, for the specs against a server of their own: the real ones are the constants of this package
  readonly endpoints?: typeof SvEndpoints
}

// The `fetch` of the platform (Node's own), adapted to what this package asks of one
const platformFetch: SvFetch = (url, init) => fetch(url, init)

export class SvProvider implements FiscalDocumentProvider {
  readonly id = SV_PROVIDER_ID
  readonly countryCode = SV_COUNTRY_CODE
  private readonly deps: SvTransmissionDeps

  constructor(options: SvProviderOptions) {
    const request = options.fetch ?? platformFetch
    const userAgent = options.userAgent ?? SvUserAgent
    this.deps = {
      auth: new SvAuthenticator({
        fetch: request,
        now: options.now ?? Date.now,
        userAgent,
        timeoutMs: SvTimeouts.AUTH_MS,
        ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints })
      }),
      signer: options.signer,
      fetch: request,
      ...(options.now === undefined ? {} : { now: options.now }),
      userAgent,
      ...(options.receptionTimeoutMs === undefined
        ? {}
        : { receptionTimeoutMs: options.receptionTimeoutMs }),
      ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints })
    }
  }

  readonly manifest: FiscalProviderManifest = {
    documentTypes: [
      { id: SvDocumentTypes.INVOICE, label: 'Factura electrónica', requiredReceiverFields: [] },
      {
        id: SvDocumentTypes.TAX_CREDIT,
        label: 'Comprobante de crédito fiscal electrónico',
        requiredReceiverFields: BUSINESS_RECEIVER_FIELDS
      },
      {
        id: SvDocumentTypes.REMISSION_NOTE,
        label: 'Nota de remisión electrónica',
        requiredReceiverFields: REMISSION_RECEIVER_FIELDS,
        remissionNote: true
      },
      {
        id: SvDocumentTypes.CREDIT_NOTE,
        label: 'Nota de crédito electrónica',
        requiredReceiverFields: BUSINESS_RECEIVER_FIELDS,
        creditNote: true
      },
      {
        id: SvDocumentTypes.DEBIT_NOTE,
        label: 'Nota de débito electrónica',
        requiredReceiverFields: BUSINESS_RECEIVER_FIELDS,
        debitNote: true
      },
      {
        id: SvDocumentTypes.EXCLUDED_SUBJECT,
        label: 'Factura de sujeto excluido electrónica',
        // The seller is no taxpayer: a name, an identity document and an address are what the schema asks (no registration number)
        requiredReceiverFields: ['name', 'taxId', 'address'],
        purchase: true
      }
    ],
    requiredIssuerFields: [
      'legalName',
      'taxId',
      'registrationId',
      'address',
      'activityCode',
      'establishmentCode',
      'pointOfSaleCode',
      'phone',
      'email'
    ],
    credentialKeys: Object.values(SvCredentialKeys),
    environments: [...SvEnabledEnvironments],
    // The control number runs by document type, establishment and point of sale (Funcional §XI)
    sequence: { perDocumentType: true, perEstablishment: true, perPointOfSale: true },
    // The lists of the authority's catalogs a person chooses from: the economic activities of the issuer (CAT-019) and the identity
    // documents of the people of an invalidation (CAT-022)
    catalogs: {
      activities: ACTIVITIES.map(row => ({ code: row.code, label: row.name })),
      identityDocuments: IDENTITY_DOCUMENTS.map(row => ({ code: row.code, label: row.name }))
    },
    issuerFieldCatalogs: { activityCode: 'activities' },
    // The authority asks who makes an invalidation and who asks for it, and tells three reasons apart (CAT-024)
    voidInputs: {
      kinds: Object.keys(SvInvalidation.KINDS) as FiscalVoidKind[],
      requiresParties: true,
      identityCatalog: 'identityDocuments',
      kindsWithReplacement: [...SvInvalidation.KINDS_WITH_REPLACEMENT],
      reasonMaxLength: SvInvalidation.REASON_MAX
    },
    // The deferred model: the reasons of CAT-005 (1 is the authority's own system not available), 72 hours to send the documents once the event
    // was taken, 1000 documents an event, and the person who answers for the establishment
    contingencyMode: {
      reasons: Object.values(SvContingency.REASONS).map(String),
      authorityDownReason: String(SvContingency.REASONS.AUTHORITY_DOWN),
      transmitWithinHours: SvContingency.TRANSMIT_WITHIN_HOURS,
      reportWithinHours: SvContingency.REPORT_WITHIN_HOURS,
      technicalReportAfterDays: SvContingency.TECHNICAL_REPORT_AFTER_DAYS,
      maxDocumentsPerEvent: SvContingency.MAX_DOCUMENTS,
      batch: {
        maxDocumentsPerBatch: SvBatch.MAX_DOCUMENTS,
        maxBatchesPerContingency: SvBatch.MAX_BATCHES
      },
      requiresResponsible: true
    }
  }

  readonly contingency: ContingencyPolicy = {
    description:
      'The document is made, signed and kept without the authority, the contingency is reported with an event, and the documents are sent within 72 hours.'
  }

  validateIssuer(
    issuer: FiscalIssuerInput,
    credentials: FiscalIssuerCredentials
  ): Promise<IssuerCheck> {
    const problems = issuerProblems(issuer)
    // The certificate itself is a credential of a signer of our own; the official service keeps it on its own disk
    for (const key of [SvCredentialKeys.API_PASSWORD, SvCredentialKeys.CERTIFICATE_PASSWORD]) {
      const value = credentials.credentials[key]
      if (typeof value !== 'string' || value.trim() === '') problems.push(key)
    }
    if (!this.manifest.environments.includes(issuer.environment))
      problems.push(SvIssuerProblems.ENVIRONMENT)
    return Promise.resolve({ ok: problems.length === 0, problems })
  }

  validateReceiver(receiver: FiscalReceiver): readonly FiscalReceiverProblem[] {
    return receiverProblems(receiver)
  }

  validatePartyTaxId(taxId: string): boolean {
    return isPlausiblePartyTaxId(taxId)
  }

  validatePurchaseDocument(input: FiscalPurchaseDocumentInput): readonly string[] {
    return purchaseDocumentProblems(input)
  }

  resolveDocumentType(input: FiscalTypeInput): string {
    return resolveDocumentType(input)
  }

  build(input: FiscalBuildInput): Promise<BuiltDocument> {
    // A document that cannot be made right throws a code (SvBuildError): core refuses it and nothing is sent
    return Promise.resolve().then(() => buildDocument(input))
  }

  submit(built: BuiltDocument, ctx: ProviderContext): Promise<SubmitResult> {
    return submitDocument(this.deps, built, ctx)
  }

  consult(built: BuiltDocument, ctx: ProviderContext): Promise<ConsultResult> {
    return consultDocument(this.deps, built, ctx)
  }

  void(
    doc: StoredFiscalDocument,
    reason: string,
    ctx: ProviderContext,
    details?: FiscalVoidDetails
  ): Promise<VoidResult> {
    return voidDocument(this.deps, doc, reason, ctx, details)
  }

  deferDocument(built: BuiltDocument, ctx: ProviderContext): Promise<DeferResult> {
    return deferDocument(this.deps, built, ctx)
  }

  reportContingency(
    event: FiscalContingencyEvent,
    ctx: ProviderContext
  ): Promise<ContingencyReportResult> {
    return reportContingencyEvent(this.deps, event, ctx)
  }

  submitBatch(request: FiscalBatchRequest, ctx: ProviderContext): Promise<FiscalBatchSendResult> {
    return submitBatch(this.deps, request, ctx)
  }

  consultBatch(
    batchCode: string,
    request: FiscalBatchRequest,
    ctx: ProviderContext
  ): Promise<FiscalBatchConsultResult> {
    return consultBatch(this.deps, batchCode, request, ctx)
  }

  probeAuthority(ctx: ProviderContext): Promise<FiscalAuthorityProbeOutcome> {
    return probeAuthority(this.deps, ctx)
  }

  // The annexes of the monthly VAT return (F-07)
  readonly annexes = svAnnexes

  represent(doc: StoredFiscalDocument): FiscalRepresentation | null {
    return representDocument(doc)
  }

  representVoid(doc: StoredVoidedDocument): FiscalRepresentation | null {
    return representVoid(doc)
  }

  voidDeadline(doc: StoredFiscalDocument): string | null {
    return voidDeadlineOf(doc)
  }

  consultVoid(doc: StoredFiscalDocument, ctx: ProviderContext): Promise<VoidConsultResult> {
    return consultVoided(this.deps, doc, ctx)
  }
}

export const svProvider = (options: SvProviderOptions): SvProvider => new SvProvider(options)
