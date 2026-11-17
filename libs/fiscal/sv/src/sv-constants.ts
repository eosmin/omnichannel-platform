import { FiscalEnvironment, PaymentMethod } from '@platform/core/domain'

// What this package knows about the electronic tax documents of El Salvador (the Sistema de Transmisión of the Ministerio de Hacienda).
// The platform knows none of it: core reads the manifest of the provider and nothing else. The sources are the public technical manual
// (version 2.0), the functional manual (version 2.0), the catalogs (version 1.1) and the JSON schemas of the authority; see ../README.md.

export const SV_PROVIDER_ID = 'sv-dte'
export const SV_COUNTRY_CODE = 'SV'

// The endpoints of each environment (Manual Técnico §4). No trailing slash: the authority refuses one. Nothing here is called by this
// package yet (Step 4B.7c-3 does it).
export const SvEndpoints: Readonly<
  Record<
    FiscalEnvironment,
    {
      readonly baseUrl: string
      readonly auth: string
      readonly reception: string
      readonly consult: string
      readonly invalidation: string
      readonly contingency: string
    }
  >
> = {
  [FiscalEnvironment.SANDBOX]: {
    baseUrl: 'https://apitest.dtes.mh.gob.sv',
    auth: '/seguridad/auth',
    reception: '/fesv/recepciondte',
    consult: '/fesv/recepcion/consultadte',
    invalidation: '/fesv/anulardte',
    contingency: '/fesv/contingencia'
  },
  [FiscalEnvironment.PRODUCTION]: {
    baseUrl: 'https://api.dtes.mh.gob.sv',
    auth: '/seguridad/auth',
    reception: '/fesv/recepciondte',
    consult: '/fesv/recepcion/consultadte',
    invalidation: '/fesv/anulardte',
    contingency: '/fesv/contingencia'
  }
}

// CAT-001: the environment of a document
export const SvEnvironmentCodes: Readonly<Record<FiscalEnvironment, string>> = {
  [FiscalEnvironment.SANDBOX]: '00',
  [FiscalEnvironment.PRODUCTION]: '01'
}

// CAT-002: the documents this provider makes. These are the ids of the manifest (the authority's own codes), the `tipoDte` of the JSON
// and the second part of the control number.
export const SvDocumentTypes = {
  INVOICE: '01',
  TAX_CREDIT: '03',
  CREDIT_NOTE: '05'
} as const
export type SvDocumentType = (typeof SvDocumentTypes)[keyof typeof SvDocumentTypes]

// The version of the JSON schema of each document (the folders of svfe-json-schemas: factura v2, comprobante de crédito fiscal v4, nota de
// crédito v4)
export const SvSchemaVersions: Readonly<Record<SvDocumentType, number>> = {
  [SvDocumentTypes.INVOICE]: 2,
  [SvDocumentTypes.TAX_CREDIT]: 4,
  [SvDocumentTypes.CREDIT_NOTE]: 4
}

// CAT-003 / CAT-004: the model of billing and the kind of transmission. Normal transmission is the previous model (the document is sent
// before it is handed to the receiver); contingency is Step 4B.7c-7.
export const SvTransmission = { MODEL_PREVIOUS: 1, OPERATION_NORMAL: 1 } as const

export const SvCurrency = 'USD'

// CAT-015: the tax of a sale, 13 % (IVA). Prices are held as cents and the rate as basis points; the divisor is the hundredth of
// 100 % + the rate (113), the way the authority writes the formulas `(sales / 1.13) x 13 %`.
export const SvVat = {
  CODE: '20',
  RATE_BPS: 1300,
  DIVISOR: 113n,
  DESCRIPTION: 'Impuesto al Valor Agregado 13%'
} as const

// CAT-014: unit of measure and CAT-011: kind of item, when the order says nothing. **[ACCOUNTANT]** Core has no unit or kind per product yet
// (debt (c) of Step 4B.7c-1): a unit, and goods, are the default, and the shipping fee is a service.
export const SvItemDefaults = {
  UNIT: 59,
  KIND_GOODS: 1,
  KIND_SERVICE: 2
} as const

// The text of the line that carries the shipping fee. **[ACCOUNTANT]** The fee is a taxed service when it carries tax (the order's own
// `shippingTaxCents`) and an exempt one when it carries none.
export const SvShippingLine = { DESCRIPTION: 'Servicio de envío' } as const

// CAT-016 and CAT-018: the condition of the operation and the term of a credit. **[ACCOUNTANT]** A payment that is not completed is read as a
// sale on credit with a term of one day: the order does not say its terms, and the authority asks for them. Change them here when the
// accountant says how a payment on delivery is declared.
export const SvOperationCondition = { CASH: 1, CREDIT: 2 } as const
export const SvDeferredTerm = { UNIT: '01', PERIOD: 1 } as const

// CAT-017: how the order was paid, in the authority's words. **[ACCOUNTANT]** A card is declared as a credit card (the order does not say
// which), and a payment on delivery as cash (it is cash in the hand of the carrier). An order with no recorded payment is cash.
export const SvPaymentForms: Readonly<Record<PaymentMethod, string>> = {
  [PaymentMethod.CASH]: '01',
  [PaymentMethod.CASH_ON_DELIVERY]: '01',
  [PaymentMethod.TRANSFER]: '05',
  [PaymentMethod.CARD]: '03',
  [PaymentMethod.OTHER]: '99'
}
export const SvDefaultPaymentForm = '01'

// CAT-007: how the document a credit note names was generated (1 on paper, 2 electronic): ours are electronic
export const SvGenerationType = { ELECTRONIC: 2 } as const

// What this provider keeps in `providerData` of an accepted document, for the documents that name it (a credit note) and for its
// invalidation. Step 4B.7c-3 writes them when the authority accepts the document; `build` of a credit note reads them.
export const SvProviderDataKeys = {
  GENERATION_CODE: 'generationCode',
  CONTROL_NUMBER: 'controlNumber',
  RECEPTION_SEAL: 'receptionSeal',
  ISSUE_DATE: 'issueDate'
} as const

// The documents a credit note may cancel. **[ACCOUNTANT]** The manual of the authority is not clear about whether a credit note may name
// an invoice to a final consumer (the invalidation within three months is the other way): until the accountant says, only the tax credit
// document is credited, and asking for a credit note of an invoice stops with a clear error. Add `INVOICE` here to allow it.
export const SvCreditableDocuments: readonly SvDocumentType[] = [SvDocumentTypes.TAX_CREDIT]

// The names of the keys of the address a customer or the issuer keeps in this provider (the address of core is a record of text keyed by
// the provider's own names): the codes of the catalogs of the authority and a free line.
export const SvAddressKeys = {
  DEPARTMENT: 'department',
  MUNICIPALITY: 'municipality',
  DISTRICT: 'district',
  COMPLEMENT: 'complement'
} as const

// CAT-022: the identity document of a receiver
export const SvIdentityDocuments = { TAX_ID: '36', NATIONAL_ID: '13', OTHER: '37' } as const

// The names of the credentials of the issuer (never their values): the password of the API, the password of the private key of the signing
// certificate and the certificate itself. The settings screen and the log redaction read them from the manifest.
export const SvCredentialKeys = {
  API_PASSWORD: 'apiPassword',
  CERTIFICATE_PASSWORD: 'certificatePassword',
  CERTIFICATE: 'certificate'
} as const

// Limits of the formats of the authority (from the JSON schemas and the functional manual)
export const SvLimits = {
  NAME_MAX: 250,
  ACTIVITY_DESCRIPTION_MAX: 150,
  COMPLEMENT_MAX: 200,
  PHONE_MIN: 8,
  PHONE_MAX: 30,
  EMAIL_MIN: 6,
  EMAIL_MAX: 100,
  ITEM_DESCRIPTION_MAX: 1500,
  ITEMS_MAX: 2000,
  OTHER_DOCUMENT_MAX: 20,
  PAYMENT_REFERENCE_MAX: 50,
  CONTROL_SEQUENCE_DIGITS: 15,
  // The tolerance of the authority between a figure of the document and its own formula (Funcional §XXI: one hundredth)
  TOLERANCE_CENTS: 1
} as const

// The codes this provider gives for what is wrong in the data of a receiver (by field; never a value)
export const SvProblemCodes = {
  DOCUMENT_TYPE_UNKNOWN: 'document_type_unknown',
  TAX_ID_INVALID: 'tax_id_invalid',
  REGISTRATION_INVALID: 'registration_invalid',
  ACTIVITY_UNKNOWN: 'activity_unknown',
  ADDRESS_INVALID: 'address_invalid',
  EMAIL_INVALID: 'email_invalid',
  PHONE_INVALID: 'phone_invalid',
  NAME_INVALID: 'name_invalid'
} as const

// What the check of an issuer names when it fails: the fields of the issuer, the names of the credentials, and the environment
export const SvIssuerProblems = { ENVIRONMENT: 'environment' } as const

// The codes of an establishment and a point of sale in the control number (Funcional §XI): a letter and three digits, then P and three digits
export const SvCodePatterns = {
  ESTABLISHMENT: /^[MBSP]\d{3}$/,
  POINT_OF_SALE: /^P\d{3}$/,
  TAX_ID: /^(\d{14}|\d{9})$/,
  REGISTRATION: /^\d{2,8}$/
} as const

// Why this provider refuses to build a document, in codes of its own (the error carries no customer data)
export const SvBuildErrors = {
  TAX_TREATMENT_UNKNOWN: 'tax_treatment_unknown',
  TAX_RATE_UNSUPPORTED: 'tax_rate_unsupported',
  PRICES_EXCLUDE_TAX_FOR_INVOICE: 'prices_exclude_tax_for_invoice',
  SALE_TOTALS_MISMATCH: 'sale_totals_mismatch',
  TAX_OUTSIDE_TOLERANCE: 'tax_outside_tolerance',
  ISSUER_INCOMPLETE: 'issuer_incomplete',
  RECEIVER_UNREADABLE: 'receiver_unreadable',
  CREDITED_DOCUMENT_UNKNOWN: 'credited_document_unknown',
  CREDITED_DOCUMENT_NOT_CREDITABLE: 'credited_document_not_creditable',
  TOO_MANY_ITEMS: 'too_many_items',
  NO_ITEMS: 'no_items',
  ITEM_DESCRIPTION_EMPTY: 'item_description_empty',
  QUANTITY_INVALID: 'quantity_invalid',
  NOT_IMPLEMENTED: 'not_implemented'
} as const
export type SvBuildErrorCode = (typeof SvBuildErrors)[keyof typeof SvBuildErrors]

export class SvBuildError extends Error {
  constructor(readonly code: SvBuildErrorCode) {
    // The code only: a message could carry the data of a customer
    super(code)
    this.name = 'SvBuildError'
  }
}
