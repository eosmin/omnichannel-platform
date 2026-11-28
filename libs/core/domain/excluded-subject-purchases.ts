import { z } from 'zod'

import { FiscalAnnexLimits } from './fiscal-constants'
import { isIsoDate } from './ledger-days'
import { PurchaseLimits } from './purchase-constants'
import { purchaseIdempotencyKey } from './purchase-schemas'
import { singleLineText } from './validation'

// Purchases from an excluded subject (D20b): what is bought from a person who is not a taxpayer of the VAT and is paid against the invoice of
// an excluded subject that the buyer issues (article 119 of the Tax Code). The record is the buyer's: the seller, the day, what was paid
// and the income tax the buyer withheld. The annex of the monthly return that declares these purchases is made by the fiscal provider; core
// stores the codes as short text and knows no country.

export const ExcludedSubjectLimits = {
  // One invoice is a handful of concepts; the cap keeps a request and the rows of one purchase bounded
  MAX_LINES: 50,
  // What one purchase adds up to: the column of the annex is ten characters with the point (9999999.99), so a larger sum could not be declared
  MAX_TOTAL_CENTS: 999_999_999,
  DESCRIPTION_MAX_LENGTH: 200,
  SELLER_NAME_MAX_LENGTH: 150,
  SELLER_DOCUMENT_MAX_LENGTH: 14,
  // The seal of reception and the code of generation of the electronic document (a UUID is 36 with dashes)
  SERIES_MAX_LENGTH: 100,
  CODE_MAX_LENGTH: 64
} as const

// What a concept is. The income tax the buyer withholds depends on it: a service paid to a natural person is withheld, goods are not
export const ExcludedSubjectLineKinds = {
  GOODS: 'goods',
  SERVICE: 'service'
} as const
export type ExcludedSubjectLineKind =
  (typeof ExcludedSubjectLineKinds)[keyof typeof ExcludedSubjectLineKinds]
export const EXCLUDED_SUBJECT_LINE_KINDS = Object.values(ExcludedSubjectLineKinds) as [
  ExcludedSubjectLineKind,
  ...ExcludedSubjectLineKind[]
]

// The withholding of the income tax on what is paid for a service (articles 154 and 156 of the Tax Code): ten per cent of the sum paid,
// whatever the amount, withheld when the payment is made or credited. Basis points, so the arithmetic is whole numbers.
export const ExcludedSubjectWithholding = {
  SERVICE_RATE_BPS: 1000,
  BPS_DENOMINATOR: 10_000
} as const

export const ExcludedSubjectResourceTypes = {
  EXCLUDED_SUBJECT_PURCHASE: 'excluded_subject_purchase'
} as const

// What the provider finds wrong in the data of a purchase (its manual's rules): codes for the client, never a value
export const ExcludedSubjectProblems = {
  SELLER_DOCUMENT_TYPE_INVALID: 'seller_document_type_invalid',
  SELLER_DOCUMENT_NUMBER_INVALID: 'seller_document_number_invalid',
  // The day of the purchase is after today (with the day of slack the clock of a person may have)
  PURCHASED_IN_THE_FUTURE: 'purchased_in_the_future',
  SERIES_INVALID: 'series_invalid',
  GENERATION_CODE_INVALID: 'generation_code_invalid',
  VAT_WITHHELD_INVALID: 'vat_withheld_invalid',
  OPERATION_TYPE_INVALID: 'operation_type_invalid',
  CLASSIFICATION_INVALID: 'classification_invalid'
} as const
export type ExcludedSubjectProblem =
  (typeof ExcludedSubjectProblems)[keyof typeof ExcludedSubjectProblems]

// Why a request that is valid in itself is refused by the state of the data (`metadata.conflict`)
export const ExcludedSubjectConflicts = {
  // The key of a request that made another purchase: a retry sends the same content, never another
  KEY_REUSED: 'excluded_subject_key_reused',
  // The electronic document is already on another purchase of the organization: it would be declared twice
  GENERATION_CODE_IN_USE: 'excluded_subject_generation_code_in_use'
} as const

export interface ExcludedSubjectLine {
  kind: ExcludedSubjectLineKind
  amountCents: number
}

// What is paid in all: the sum of the concepts
export function excludedSubjectAmountOf(
  lines: readonly Pick<ExcludedSubjectLine, 'amountCents'>[]
): number {
  return lines.reduce((sum, line) => sum + line.amountCents, 0)
}

// The income tax the buyer withholds: ten per cent of what is paid for services, nothing on goods, rounded to the cent (half up) on the
// whole sum of the services, not concept by concept. Whole-number arithmetic: no float is ever rounded. It is the buyer's computation and the
// only one: the request carries no figure for it, so a client cannot state another.
export function withheldIncomeTaxOf(lines: readonly ExcludedSubjectLine[]): number {
  const services = lines
    .filter(line => line.kind === ExcludedSubjectLineKinds.SERVICE)
    .reduce((sum, line) => sum + line.amountCents, 0)
  const { SERVICE_RATE_BPS, BPS_DENOMINATOR } = ExcludedSubjectWithholding
  return Math.floor((services * SERVICE_RATE_BPS + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR)
}

// A calendar day, not only a string that looks like one
const day = z
  .string()
  .refine(isIsoDate, { message: 'not a calendar date (YYYY-MM-DD)' })
  // The record is immutable and feeds a monthly return: a year that cannot be declared is a typing mistake that could never be corrected
  .refine(value => value >= `${FiscalAnnexLimits.FIRST_YEAR}-01-01`, {
    message: 'before the first year of the annexes'
  })
const code = (max: number) => z.string().regex(new RegExp(`^[0-9]{1,${max}}$`))
const line = z.strictObject({
  description: singleLineText(ExcludedSubjectLimits.DESCRIPTION_MAX_LENGTH, 1),
  kind: z.enum(EXCLUDED_SUBJECT_LINE_KINDS),
  amountCents: z.number().int().min(1).max(ExcludedSubjectLimits.MAX_TOTAL_CENTS)
})

// The body of the purchase. It has no field for the income tax withheld (it is computed from the concepts, see above) and a field the schema
// does not know is a refusal, so a client that sends one is told, not ignored.
export const createExcludedSubjectPurchaseSchema = z
  .strictObject({
    idempotencyKey: purchaseIdempotencyKey,
    purchasedOn: day,
    seller: z.strictObject({
      documentType: code(PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH),
      documentNumber: z
        .string()
        .regex(/^[A-Za-z0-9]+$/)
        .max(ExcludedSubjectLimits.SELLER_DOCUMENT_MAX_LENGTH),
      name: singleLineText(ExcludedSubjectLimits.SELLER_NAME_MAX_LENGTH, 1)
    }),
    // The two of the electronic document, together or none (the annex declares both): taken from the invoice once the authority accepted it
    documentSeries: singleLineText(ExcludedSubjectLimits.SERIES_MAX_LENGTH, 1).optional(),
    generationCode: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .max(ExcludedSubjectLimits.CODE_MAX_LENGTH)
      .optional(),
    // The 13 % of the VAT the buyer withheld, when it applies: the figure of the invoice, checked against the amount by the provider
    vatWithheldCents: z.number().int().min(0).max(ExcludedSubjectLimits.MAX_TOTAL_CENTS).default(0),
    operationType: code(PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH),
    expenseClass: code(PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH),
    sector: code(PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH),
    costType: code(PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH),
    lines: z.array(line).min(1).max(ExcludedSubjectLimits.MAX_LINES)
  })
  .refine(body => (body.documentSeries === undefined) === (body.generationCode === undefined), {
    message: 'the series and the code of generation go together'
  })
  .refine(body => excludedSubjectAmountOf(body.lines) <= ExcludedSubjectLimits.MAX_TOTAL_CENTS, {
    message: 'the purchase adds up to more than the annex can declare'
  })
  .refine(body => body.vatWithheldCents <= excludedSubjectAmountOf(body.lines), {
    message: 'the VAT withheld is more than what was paid'
  })
export type CreateExcludedSubjectPurchaseBody = z.infer<typeof createExcludedSubjectPurchaseSchema>
