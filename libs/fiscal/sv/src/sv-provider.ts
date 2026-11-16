import type { FiscalEnvironment } from '@platform/core/domain'
import type {
  BuiltDocument,
  ConsultResult,
  ContingencyPolicy,
  FiscalBuildInput,
  FiscalDocumentProvider,
  FiscalIssuerCredentials,
  FiscalIssuerInput,
  FiscalProviderManifest,
  FiscalReceiver,
  FiscalReceiverProblem,
  FiscalTypeInput,
  IssuerCheck,
  ProviderContext,
  StoredFiscalDocument,
  SubmitResult,
  VoidResult
} from '@platform/fiscal/sdk'

import { buildDocument, resolveDocumentType } from './sv-build'
import {
  SV_COUNTRY_CODE,
  SV_PROVIDER_ID,
  SvBuildError,
  SvBuildErrors,
  SvCredentialKeys,
  SvDocumentTypes,
  SvEndpoints,
  SvIssuerProblems
} from './sv-constants'
import { issuerProblems, receiverProblems } from './sv-parties'

// What a taxpayer needs of a customer to make a tax credit document or a credit note
const BUSINESS_RECEIVER_FIELDS = [
  'name',
  'taxId',
  'registrationId',
  'economicActivity',
  'address'
] as const

// The provider of the electronic tax documents of El Salvador. Step 4B.7c-2 builds the documents; sending, consulting and invalidating
// them is Step 4B.7c-3 and 4B.7c-4, so until then those three refuse with a clear error and the provider is registered only where the
// simulator is, and no issuer can be set up with it in production.
export class SvProvider implements FiscalDocumentProvider {
  readonly id = SV_PROVIDER_ID
  readonly countryCode = SV_COUNTRY_CODE

  readonly manifest: FiscalProviderManifest = {
    documentTypes: [
      { id: SvDocumentTypes.INVOICE, label: 'Factura electrónica', requiredReceiverFields: [] },
      {
        id: SvDocumentTypes.TAX_CREDIT,
        label: 'Comprobante de crédito fiscal electrónico',
        requiredReceiverFields: BUSINESS_RECEIVER_FIELDS
      },
      {
        id: SvDocumentTypes.CREDIT_NOTE,
        label: 'Nota de crédito electrónica',
        requiredReceiverFields: BUSINESS_RECEIVER_FIELDS,
        creditNote: true
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
    environments: Object.keys(SvEndpoints) as FiscalEnvironment[],
    // The control number runs by document type, establishment and point of sale (Funcional §XI)
    sequence: { perDocumentType: true, perEstablishment: true, perPointOfSale: true }
  }

  readonly contingency: ContingencyPolicy = {
    description: 'Not available yet: the document stays queued and is sent again.'
  }

  validateIssuer(
    issuer: FiscalIssuerInput,
    credentials: FiscalIssuerCredentials
  ): Promise<IssuerCheck> {
    const problems = issuerProblems(issuer)
    for (const key of Object.values(SvCredentialKeys)) {
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

  resolveDocumentType(input: FiscalTypeInput): string {
    return resolveDocumentType(input)
  }

  build(input: FiscalBuildInput): Promise<BuiltDocument> {
    // A document that cannot be made right throws a code (SvBuildError): core refuses it and nothing is sent
    return Promise.resolve().then(() => buildDocument(input))
  }

  submit(_built: BuiltDocument, _ctx: ProviderContext): Promise<SubmitResult> {
    return Promise.reject(new SvBuildError(SvBuildErrors.NOT_IMPLEMENTED))
  }

  consult(_built: BuiltDocument, _ctx: ProviderContext): Promise<ConsultResult> {
    return Promise.reject(new SvBuildError(SvBuildErrors.NOT_IMPLEMENTED))
  }

  void(_doc: StoredFiscalDocument, _reason: string, _ctx: ProviderContext): Promise<VoidResult> {
    return Promise.reject(new SvBuildError(SvBuildErrors.NOT_IMPLEMENTED))
  }
}

export const svProvider = (): SvProvider => new SvProvider()
