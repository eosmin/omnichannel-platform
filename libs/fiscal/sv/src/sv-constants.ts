import { FiscalEnvironment, FiscalVoidKind, PaymentMethod } from '@platform/core/domain'

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

// The token of the API: how long it lives in each environment (Manual Técnico §3) and when it is renewed (a share of that), and for how long
// a password the authority refused is not sent again (three wrong logins lock the user until a person changes the password in the site of
// the authority). (confirmed by the owner 2026-11-17) fifteen minutes.
export const SvAuthentication = {
  TOKEN_LIFETIME_MS: {
    [FiscalEnvironment.SANDBOX]: 48 * 60 * 60 * 1000,
    [FiscalEnvironment.PRODUCTION]: 24 * 60 * 60 * 1000
  },
  RENEW_AT: 0.8,
  REJECTED_MEMORY_MS: 15 * 60 * 1000
} as const

// The name the platform gives itself in the User-Agent of its calls: generic, with no data of the project. (confirmed by the owner 2026-11-17)
export const SvUserAgent = 'PlataformaOmnicanal/1.0'

// The time the authority gets to answer a document before it counts as no answer (Manual Técnico §3.3: 8 seconds)
export const SvTimeouts = { AUTH_MS: 8000, RECEPTION_MS: 8000, SIGNER_MS: 10000 } as const

// The words of the answers of the authority and of the signing service, and the route of the signing service
export const SvAnswerStates = {
  PROCESSED: 'PROCESADO',
  // What the contingency service says of an event it took
  RECEIVED: 'RECIBIDO',
  // What the consultation says of a document whose invalidation the authority accepted **[TO CONFIRM IN THE SANDBOX]**
  INVALIDATED: 'INVALIDADO',
  REFUSED: 'RECHAZADO',
  OK: 'OK',
  ERROR: 'ERROR'
} as const
export const SvSignerRoute = '/firmardocumento/'

// The environments this provider lets an issuer choose. **Only the sandbox until the owner authorizes production (Step 4B.7c-8)**: the
// invalidation exists since Step 4B.7c-4, but the real environment also needs its own configuration, apart from the sandbox's.
export const SvEnabledEnvironments: readonly FiscalEnvironment[] = [FiscalEnvironment.SANDBOX]

// CAT-002: the documents this provider makes. These are the ids of the manifest (the authority's own codes), the `tipoDte` of the JSON
// and the second part of the control number.
export const SvDocumentTypes = {
  INVOICE: '01',
  TAX_CREDIT: '03',
  REMISSION_NOTE: '04',
  CREDIT_NOTE: '05',
  DEBIT_NOTE: '06',
  // The invoice of an excluded subject (FSEE): the buyer makes it for a seller who is no taxpayer and issues none
  EXCLUDED_SUBJECT: '14'
} as const
export type SvDocumentType = (typeof SvDocumentTypes)[keyof typeof SvDocumentTypes]

// The version of the JSON schema of each document (the folders of svfe-json-schemas: factura v2, comprobante de crédito fiscal v4, nota de
// crédito v4, nota de débito v4, nota de remisión v4, factura de sujeto excluido v2)
export const SvSchemaVersions: Readonly<Record<SvDocumentType, number>> = {
  [SvDocumentTypes.INVOICE]: 2,
  [SvDocumentTypes.TAX_CREDIT]: 4,
  [SvDocumentTypes.REMISSION_NOTE]: 4,
  [SvDocumentTypes.CREDIT_NOTE]: 4,
  [SvDocumentTypes.DEBIT_NOTE]: 4,
  [SvDocumentTypes.EXCLUDED_SUBJECT]: 2
}

// CAT-003 (the billing model) and CAT-004 (the kind of transmission). Normal transmission is the previous model (the document is sent
// before it is handed to the receiver); a document made in contingency is deferred and transmitted after the event.
export const SvTransmission = {
  MODEL_PREVIOUS: 1,
  OPERATION_NORMAL: 1,
  MODEL_DEFERRED: 2,
  OPERATION_CONTINGENCY: 2
} as const

// Contingency (Step 4B.7c-7; Manual Técnico §3.3, Normativa cuadros 4 y 5, Funcional §XXIV).
export const SvContingency = {
  VERSION: 4,
  // CAT-005. The authority's own system not available is the one the lifecycle uses when a document found it down in every attempt.
  REASONS: {
    AUTHORITY_DOWN: 1,
    ISSUER_SYSTEM_DOWN: 2,
    INTERNET_DOWN: 3,
    POWER_DOWN: 4,
    OTHER: 5
  } as const,
  // The time to send the documents of the lot once the event was taken (Normativa cuadro 5)
  TRANSMIT_WITHIN_HOURS: 72,
  // The time to transmit the event of contingency once the force majeure ended (Normativa DTE v2.0, 13.2.2; field 10 of the event)
  REPORT_WITHIN_HOURS: 24,
  // A contingency that lasts more than three consecutive days needs a technical report before the event (Normativa DTE v2.0, 13.2.1.1)
  TECHNICAL_REPORT_AFTER_DAYS: 3,
  // The documents one event lists (the schema's maximum)
  MAX_DOCUMENTS: 1000,
  MOTIVE_MAX: 500
} as const

// A reason as the manifest declares it (text of CAT-005): the exact code, never one that merely starts with a digit
export const SvContingencyReasonCodes: readonly string[] = Object.values(SvContingency.REASONS).map(
  String
)

// Why this provider refuses to make or report a contingency, in codes of its own (never a value)
export const SvContingencyRefusals = {
  CREDENTIALS_INCOMPLETE: 'credentials_incomplete',
  CREDENTIALS_REJECTED: 'credentials_rejected',
  SIGNING_CREDENTIALS_REJECTED: 'signing_credentials_rejected',
  ISSUER_INCOMPLETE: 'issuer_incomplete',
  DOCUMENT_INCOMPLETE: 'document_incomplete',
  REASON_UNKNOWN: 'contingency_reason_unknown',
  MOTIVE_REQUIRED: 'contingency_motive_required',
  MOTIVE_TOO_LONG: 'contingency_motive_too_long',
  EVENT_ID_INVALID: 'contingency_event_id_invalid',
  RESPONSIBLE_REQUIRED: 'contingency_responsible_required',
  PARTY_INVALID: 'contingency_party_invalid',
  DOCUMENTS_INVALID: 'contingency_documents_invalid',
  TOO_MANY_DOCUMENTS: 'contingency_too_many_documents',
  WINDOW_INVALID: 'contingency_window_invalid'
} as const

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
  UNIT_OTHER: 99,
  KIND_GOODS: 1,
  KIND_SERVICE: 2,
  KIND_OTHER_CHARGES: 4
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

// What this provider keeps in `providerData` of an accepted document, for the documents that name it (a credit or debit note) and for its
// invalidation. Step 4B.7c-3 writes them when the authority accepts the document; `build` of a credit or debit note reads them.
export const SvProviderDataKeys = {
  GENERATION_CODE: 'generationCode',
  CONTROL_NUMBER: 'controlNumber',
  RECEPTION_SEAL: 'receptionSeal',
  ISSUE_DATE: 'issueDate',
  PROCESSED_AT: 'processedAt',
  OBSERVATIONS: 'observations',
  SIGNED_DOCUMENT: 'signedDocument',
  // Of a contingency: the documents its event listed, the hours it gave to send them, and whether the event was one the authority held
  DOCUMENTS: 'documents',
  WINDOW_HOURS: 'windowHours',
  DUPLICATE: 'duplicate'
} as const

// The reasons this provider gives when it refuses a document before or after the authority did (codes of its own, never a value). The
// authority's own refusal keeps the authority's code as its reason.
export const SvRejectionReasons = {
  CREDENTIALS_INCOMPLETE: 'credentials_incomplete',
  CREDENTIALS_REJECTED: 'credentials_rejected',
  SIGNING_CREDENTIALS_REJECTED: 'signing_credentials_rejected',
  DOCUMENT_INCOMPLETE: 'document_incomplete'
} as const

// The invalidation event (Manual Técnico §4.4, schema `invalidacion-schema-v3`; CAT-024 is the kind of invalidation)
export const SvInvalidation = {
  VERSION: 3,
  // CAT-024. A correction and "other" name the document that takes the place of the invalidated one (its generation code); a rescission
  // does not.
  KINDS: {
    [FiscalVoidKind.CORRECTION]: 1,
    [FiscalVoidKind.RESCISSION]: 2,
    [FiscalVoidKind.OTHER]: 3
  } as const satisfies Readonly<Record<FiscalVoidKind, number>>,
  KINDS_WITH_REPLACEMENT: [
    FiscalVoidKind.CORRECTION,
    FiscalVoidKind.OTHER
  ] as readonly FiscalVoidKind[],
  REASON_MAX: 200,
  PARTY_NAME_MAX: 100,
  PARTY_ID_MAX: 20,
  // The months after the date of an invoice its event may be dated within (Anexo V, field 9)
  INVOICE_EVENT_MONTHS: 3
} as const

// How a deadline of invalidation is counted, from the day the authority gave the document its reception seal (Normativa de Interoperabilidad
// DTE v2.0, cuadro 6 and Anexo V, validation of field 47)
export const SvInvalidationDeadlineUnits = {
  // Calendar months after the day of the seal (to the last day of a shorter month)
  CALENDAR_MONTHS: 'calendar_months',
  // Calendar days after the day of the seal
  CALENDAR_DAYS: 'calendar_days',
  // The n-th business day of the month after the one the seal was given in (holidays: `SvHolidays`)
  BUSINESS_DAY_OF_NEXT_MONTH: 'business_day_of_next_month'
} as const
export type SvInvalidationDeadlineUnit =
  (typeof SvInvalidationDeadlineUnits)[keyof typeof SvInvalidationDeadlineUnits]

export interface SvInvalidationDeadlineRule {
  readonly unit: SvInvalidationDeadlineUnit
  readonly amount: number
}

// The window of each type, counted from the SEAL (not from the date of the document). **[ACCOUNTANT / AUTHORITY]** The Normativa
// contradicts itself for a tax credit document and a credit note: the body (cuadro 6, and the Manual Funcional) says the tenth business
// day of the month after the seal, and the Anexo V (field 47, rule 2: CCFE, CRE, NCE and NDE) says one day after the seal, which is what
// the reception platform is said to apply. A late invalidation is a fine, so the STRICTER window, one calendar day after the seal, is used
// until the authority answers the consultation sent to it (B4). To adopt the body's rule, change these three lines to
// `{ unit: BUSINESS_DAY_OF_NEXT_MONTH, amount: 10 }` and list the holidays in `SvHolidays`; nothing else changes. An invoice is three
// calendar months after the seal in both texts.
export const SvInvalidationDeadlineRules: Readonly<
  Record<SvDocumentType, SvInvalidationDeadlineRule>
> = {
  [SvDocumentTypes.INVOICE]: { unit: SvInvalidationDeadlineUnits.CALENDAR_MONTHS, amount: 3 },
  [SvDocumentTypes.TAX_CREDIT]: { unit: SvInvalidationDeadlineUnits.CALENDAR_DAYS, amount: 1 },
  // Anexo V, field 47, rule 4: the remission note (NRE) is invalidated within four calendar days after its seal (the Manual Funcional
  // says the tenth business day of the next month for it too, the same contradiction as above: the stricter window is used)
  [SvDocumentTypes.REMISSION_NOTE]: { unit: SvInvalidationDeadlineUnits.CALENDAR_DAYS, amount: 4 },
  [SvDocumentTypes.CREDIT_NOTE]: { unit: SvInvalidationDeadlineUnits.CALENDAR_DAYS, amount: 1 },
  [SvDocumentTypes.DEBIT_NOTE]: { unit: SvInvalidationDeadlineUnits.CALENDAR_DAYS, amount: 1 },
  // Three calendar months after the seal, like an invoice (Anexo V, field 47, rule 5: FE, FEXE and FSEE)
  [SvDocumentTypes.EXCLUDED_SUBJECT]: {
    unit: SvInvalidationDeadlineUnits.CALENDAR_MONTHS,
    amount: 3
  }
}

// The types whose event is dated the way an invoice's is (Anexo V, field 9, rules 4 and 5): the day it is made, but never later than three
// months after the date of the document. The others take the date of their document.
export const SvInvalidationDatedLikeInvoice: readonly SvDocumentType[] = [
  SvDocumentTypes.INVOICE,
  SvDocumentTypes.EXCLUDED_SUBJECT
]

// The types whose invalidation names no replacement document whatever the kind (Anexo V, field 48: null for 05, 08, 16, 17 and 18). The
// debit note (06) is not among them: it names one like a tax credit document.
export const SvInvalidationWithoutReplacement: readonly SvDocumentType[] = [
  SvDocumentTypes.CREDIT_NOTE
]

// Whether a person may invalidate a document of each type. **[ACCOUNTANT]** Whether a final consumer's invoice is cancelled by an
// invalidation or by a credit note is the accountant's to say, and the manual does not settle it: the answer is one switch per type (the
// type says the kind of buyer: the invoice is the final consumer's, the others are the taxpayer's), all of them open until it is decided.
// A closed one refuses with `SvVoidRefusals.NOT_ALLOWED`, and nothing is sent.
export const SvInvalidationAllowed: Readonly<Record<SvDocumentType, boolean>> = {
  [SvDocumentTypes.INVOICE]: true,
  [SvDocumentTypes.TAX_CREDIT]: true,
  [SvDocumentTypes.REMISSION_NOTE]: true,
  [SvDocumentTypes.CREDIT_NOTE]: true,
  [SvDocumentTypes.DEBIT_NOTE]: true,
  [SvDocumentTypes.EXCLUDED_SUBJECT]: true
}

// The deadlines are checked before anything is sent (a refusal with a code of ours, the authority is not troubled); switch this off to leave
// the verdict to the authority alone. **[ACCOUNTANT]**
export const SvInvalidationEnforceDeadline = true

// The days that are not business days besides Saturdays and Sundays (holidays), as yyyy-MM-dd. **[ACCOUNTANT]** Empty until the official
// list the authority counts by is given (none is invented here). Used only by a rule counted in business days
// (`SvInvalidationDeadlineUnits.BUSINESS_DAY_OF_NEXT_MONTH`, none today): an unlisted holiday makes the n-th business day come EARLIER than
// the authority's, so such a rule is enforced only when the list is given and the authority has the last word until then. A rule in
// calendar days or months always is.
export const SvHolidays: readonly string[] = []

// Why this provider refuses an invalidation, in codes of its own (never a value). Nothing was sent when one of these is the reason.
export const SvVoidRefusals = {
  CREDENTIALS_INCOMPLETE: 'credentials_incomplete',
  CREDENTIALS_REJECTED: 'credentials_rejected',
  SIGNING_CREDENTIALS_REJECTED: 'signing_credentials_rejected',
  DOCUMENT_INCOMPLETE: 'document_incomplete',
  ISSUER_INCOMPLETE: 'issuer_incomplete',
  KIND_REQUIRED: 'void_kind_required',
  PARTIES_REQUIRED: 'void_parties_required',
  PARTY_INVALID: 'void_party_invalid',
  REPLACEMENT_REQUIRED: 'void_replacement_required',
  REPLACEMENT_INVALID: 'void_replacement_invalid',
  REASON_INVALID: 'void_reason_invalid',
  NOT_ALLOWED: 'void_not_allowed',
  DEADLINE_PASSED: 'void_deadline_passed'
} as const

// The documents a credit note may cancel. **[ACCOUNTANT]** The manual of the authority is not clear about whether a credit note may name
// an invoice to a final consumer (the invalidation within three months is the other way): until the accountant says, only the tax credit
// document is credited, and asking for a credit note of an invoice stops with a clear error. Add `INVOICE` here to allow it.
export const SvCreditableDocuments: readonly SvDocumentType[] = [SvDocumentTypes.TAX_CREDIT]

// The documents a debit note may add to: the tax credit document only, the taxpayer's document (a debit note names a document of the
// same taxpayer, and an invoice to a final consumer is not one). It is its own list, apart from the credit note's, so that one may change
// without the other.
export const SvDebitableDocuments: readonly SvDocumentType[] = [SvDocumentTypes.TAX_CREDIT]

// CAT-025: the title the goods of a remission note are sent under (the `bienTitulo` of its receiver). **[ACCOUNTANT]** Which title a dispatch
// to a buyer whose sale document is made on delivery carries is the accountant's to say; "transfer" is used until then, because the note
// backs the movement of the goods and no sale is declared by it. Change `SvDefaultRemissionTitle` to adopt another.
export const SvRemissionTitles = {
  DEPOSIT: '01',
  OWNERSHIP: '02',
  CONSIGNMENT: '03',
  TRANSFER: '04',
  OTHER: '05'
} as const
export type SvRemissionTitle = (typeof SvRemissionTitles)[keyof typeof SvRemissionTitles]
export const SvDefaultRemissionTitle: SvRemissionTitle = SvRemissionTitles.TRANSFER

// The economic activity (CAT-019) the receiver of a remission note carries when the customer declares none: the schema asks for one as text and
// a final consumer has none. "Other" is the code the catalog offers for natural persons (section "employees and other natural persons").
// **[ACCOUNTANT / AUTHORITY]** No text of the authority says which code a final consumer takes: this is the reasonable technical choice, to
// confirm with the 50 minimum tests of the sandbox and with a question to the authority. Change this one constant to adopt another.
export const SvDefaultRemissionActivity = '10005'

// How long after the generation of a tax credit document a credit or debit note may name it (Normativa DTE v2.0, Anexo IV, field 17 rule
// 2 c): three calendar months, the last day included, counted on the dates the documents carry (`fecEmi`). **[ACCOUNTANT]** The manual
// adds "except the legal exceptions", which are not known: no exception is applied, a note out of time is refused before it is sent.
export const SvRelatedDocument = { DEADLINE_MONTHS: 3 } as const

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
  REGISTRATION: /^\d{2,8}$/,
  // The generation code of a document or an event: a UUID in capitals
  GENERATION_CODE: /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/,
  CONTROL_NUMBER: /^DTE-\d{2}-[MBSP]\d{3}P\d{3}-\d{15}$/
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
  RELATED_DOCUMENT_DEADLINE_PASSED: 'related_document_deadline_passed',
  TOO_MANY_ITEMS: 'too_many_items',
  NO_ITEMS: 'no_items',
  ITEM_DESCRIPTION_EMPTY: 'item_description_empty',
  QUANTITY_INVALID: 'quantity_invalid',
  CONTINGENCY_REASON_UNKNOWN: 'contingency_reason_unknown',
  CONTINGENCY_MOTIVE_REQUIRED: 'contingency_motive_required',
  CONTINGENCY_MOTIVE_TOO_LONG: 'contingency_motive_too_long',
  // A purchase document asks the caller for the income tax withheld, always stated and never assumed
  WITHHOLDING_REQUIRED: 'withholding_required',
  WITHHOLDING_INVALID: 'withholding_invalid',
  // A purchase from an excluded subject carries no sales tax
  PURCHASE_HAS_TAX: 'purchase_has_tax'
} as const
export type SvBuildErrorCode = (typeof SvBuildErrors)[keyof typeof SvBuildErrors]

export class SvBuildError extends Error {
  constructor(readonly code: SvBuildErrorCode) {
    // The code only: a message could carry the data of a customer
    super(code)
    this.name = 'SvBuildError'
  }
}

// The graphic representation of a document (Normativa de Cumplimiento DTE v2.0, apartado 11.3 and Anexo I 4 and 8; Manual Técnico §5). The
// names of the fields are the authority's own (Anexos II and III), in Spanish: the document is a legal paper of the country, so its words are
// not translated. The address of the public consultation is the one of the Manual Técnico §5.
export const SvRepresentation = {
  CONSULT_URL: 'https://admin.factura.gob.sv/consultaPublica',
  // A representation made in the test environment must stand out that the document has no legal value (Normativa 11.3, page 25)
  TEST_NOTICE:
    'Este documento carece de valor legal por tratarse de documentación de ensayo con información aparente.',
  // The 40 characters of the seal are replaced by this when the document has none (a document made in contingency is sealed later)
  NO_SEAL: '-',
  EMPTY: '-',
  MODELS: { 1: 'Modelo de facturación previo', 2: 'Modelo de facturación diferido' },
  TRANSMISSIONS: { 1: 'Transmisión normal', 2: 'Transmisión por contingencia' },
  // CAT-002: the description of a type of document, as the representation shows it (the type drawn and the type of a related document)
  TITLES: {
    '01': 'Factura',
    '03': 'Comprobante de crédito fiscal',
    '04': 'Nota de remisión',
    '05': 'Nota de crédito',
    '06': 'Nota de débito',
    '07': 'Comprobante de retención',
    '08': 'Comprobante de liquidación',
    '09': 'Documento contable de liquidación',
    '11': 'Factura de exportación',
    '14': 'Factura de sujeto excluido',
    '15': 'Comprobante de donación'
  }
} as const satisfies Record<string, unknown>

// The annexes of the monthly VAT return (Formulario F-07) as the Ministerio de Hacienda loads them: "Manual de Anexos del Formulario de IVA
// F-07", version 14 (January 2025), public. The page of each rule is cited where it is used (`sv-annexes.ts`).
export const SvAnnexIds = {
  // Anexo 1: sales to taxpayers (03, 05, 06)
  SALES_TAXPAYERS: 'sales-taxpayers',
  // Anexo 2: sales to final consumers (01), one row for each day and type
  SALES_CONSUMERS: 'sales-consumers',
  // Anexo of voided documents ("Documentos Emitidos Anulados y Extraviados": the voided ones only, a DTE has no lost ones)
  VOIDED: 'voided'
} as const

export const SvAnnex = {
  // Column B "clase de documento": 4 is the electronic document
  DOCUMENT_CLASS_DTE: '4',
  // The cell a field that does not apply to a document grouped by day holds (manual V14, p.12-13)
  NOT_APPLICABLE: 'N/A',
  // The last column of the sales annexes: the number of the annex (manual V14, p.8 and p.14)
  NUMBER_TAXPAYERS: '1',
  NUMBER_CONSUMERS: '2',
  // The columns of rent (R and S of the annex 1, U and V of the annex 2) exist from this period; before it they hold "0" (p.5 and p.11)
  RENT_COLUMNS_FROM: '2025-01',
  RENT_NOT_APPLICABLE: '0',
  // "Tipo de operación (Renta)": 1 taxed, 2 not taxed or exempt, 4 mixed (p.7). **[ACCOUNTANT]** which one a sale is, and the type of income
  // below, are the accountant's; this is the reading by the amounts of the document, and the type of income of a shop that sells goods
  OPERATION_TAXED: '1',
  OPERATION_NOT_TAXED: '2',
  OPERATION_MIXED: '4',
  INCOME_COMMERCIAL: '3',
  // Voided: "tipo de detalle" D is a DTE that was invalidated (p.60-62); desde/hasta and the preprinted range are 0 in a DTE
  DETAIL_DTE_INVALIDATED: 'D',
  ZERO: '0',
  // The extension and the separator of the file: a CSV with semicolons, with no header (p.3-6)
  SEPARATOR: ';',
  LINE_END: '\r\n',
  FILE_EXTENSION: 'csv',
  // The provider's own file name: the annex and the month
  FILE_PREFIX: 'f07',
  // Column A of the voided annex: the control number with its dashes (p.60-62; the manual contradicts itself, see `sv-annexes.ts`)
  VOIDED_CONTROL_NUMBER_WITH_DASHES: true,
  // A voided document is written in the annex of consumers of the month of its invalidation when it was issued at most this many periods
  // before (article 111 of the Tax Code, manual p.11)
  VOID_MAX_PERIODS_BACK: 3,
  // The seal of reception has 40 characters (p.61)
  SEAL_LENGTH: 40,
  GENERATION_CODE_LENGTH: 36
} as const

export const SvAnnexErrors = {
  // A document of the month has no seal yet (made in contingency and not reported): the annex waits for it
  UNSEALED: 'annex_document_unsealed',
  // A figure of a document is not a whole number of cents, or a field the file needs is missing or unreadable
  UNREADABLE: 'annex_document_unreadable'
} as const
