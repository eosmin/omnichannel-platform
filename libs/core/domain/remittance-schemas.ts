import { z } from 'zod'

import {
  headerKey,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  RemittanceImportLimits
} from './remittance-import'
import { RemittanceLimits } from './remittance-rules'
import { isoDaySchema } from './shipment-schemas'
import { singleLineText, uuidSchema } from './validation'

// What a client sends to build, edit and settle a remittance (TDD_17 §4.15, §6). Every shape is strict: a store, a status, a
// total or an outcome is never taken from the request, the service works them out (the status moves only through its own
// routes, the totals are written at confirmation and the outcome comes from the matching).

// A free note: one block of text without NUL (Postgres text cannot hold it)
const noteSchema = z
  .string()
  .trim()
  .min(1)
  .max(RemittanceLimits.NOTE_MAX_LENGTH)
  .refine(value => !value.includes('\u0000'), { message: 'a NUL character' })

// Whole cents, never negative and bounded: a fraction or a negative number is a mistake of the caller, not a rounding of ours
export const remittanceAmountSchema = z.number().int().min(0).max(RemittanceLimits.MAX_AMOUNT_CENTS)

// One line of a settlement: the guide as the carrier prints it, what it remitted for it and, when it says so, its fee
export const remittanceLineInputSchema = z.strictObject({
  guideNumber: singleLineText(RemittanceLimits.GUIDE_MAX_LENGTH, 1),
  reportedCents: remittanceAmountSchema,
  reportedFeeCents: remittanceAmountSchema.optional(),
  note: noteSchema.optional()
})
export type RemittanceLineInput = z.output<typeof remittanceLineInputSchema>

export const createRemittanceSchema = z.strictObject({
  connectionId: uuidSchema,
  reference: singleLineText(RemittanceLimits.REFERENCE_MAX_LENGTH, 1).optional(),
  receivedOn: isoDaySchema.optional(),
  note: noteSchema.optional(),
  lines: z.array(remittanceLineInputSchema).max(RemittanceLimits.MAX_LINES).default([])
})
export type CreateRemittanceBody = z.output<typeof createRemittanceSchema>

export const addRemittanceLinesSchema = z.strictObject({
  lines: z.array(remittanceLineInputSchema).min(1).max(RemittanceLimits.MAX_LINES)
})
export type AddRemittanceLinesBody = z.output<typeof addRemittanceLinesSchema>

// A line of a draft can be left out of the confirmation, annotated, or corrected in what the carrier reported
export const updateRemittanceLineSchema = z
  .strictObject({
    excluded: z.boolean().optional(),
    note: noteSchema.nullable().optional(),
    reportedCents: remittanceAmountSchema.optional(),
    reportedFeeCents: remittanceAmountSchema.nullable().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })
export type UpdateRemittanceLineBody = z.output<typeof updateRemittanceLineSchema>

// The settlement number and the day it arrived are often known only when the agent confirms
export const confirmRemittanceSchema = z.strictObject({
  reference: singleLineText(RemittanceLimits.REFERENCE_MAX_LENGTH, 1).optional(),
  receivedOn: isoDaySchema.optional(),
  note: noteSchema.optional()
})
export type ConfirmRemittanceBody = z.output<typeof confirmRemittanceSchema>

export const voidRemittanceSchema = z.strictObject({ reason: noteSchema.optional() })
export type VoidRemittanceBody = z.output<typeof voidRemittanceSchema>

export const remittancePendingQuerySchema = z.strictObject({
  connectionId: uuidSchema.optional()
})
export type RemittancePendingQuery = z.output<typeof remittancePendingQuerySchema>

// ------------------------------------------------------------------------------------------------------ the import

// A column of the file: the text of its header, or its position (0 is the first column)
const columnRefSchema = z.union([singleLineText(80, 1), z.number().int().min(0).max(200)])

export const remittanceImportMappingSchema = z.strictObject({
  guideNumber: columnRefSchema,
  amount: columnRefSchema,
  fee: columnRefSchema.optional(),
  date: columnRefSchema.optional(),
  reference: columnRefSchema.optional()
})

const delimiterSchema = z.enum([
  RemittanceDelimiters.COMMA,
  RemittanceDelimiters.SEMICOLON,
  RemittanceDelimiters.TAB
])
const decimalSchema = z.enum([RemittanceDecimalSeparators.DOT, RemittanceDecimalSeparators.COMMA])
const dateFormatSchema = z.enum([
  RemittanceDateFormats.ISO,
  RemittanceDateFormats.DAY_FIRST_SLASH,
  RemittanceDateFormats.MONTH_FIRST_SLASH,
  RemittanceDateFormats.DAY_FIRST_DASH
])

// The two rules a profile must keep, written once: the schemas refuse a profile that breaks one (400) and the service checks the
// profile a change would leave (the database repeats the second as a CHECK). Returns what is wrong, or null.
export function remittanceProfileProblem(value: {
  hasHeader: boolean
  delimiter: string
  decimalSeparator: string
  columns: Record<string, string | number | undefined>
}): string | null {
  // A file with no header can only be read by the position of its columns
  if (!value.hasHeader && Object.values(value.columns).some(ref => typeof ref === 'string')) {
    return 'a file with no header is mapped by column position'
  }
  // Each value has a column of its own: a guide and an amount read from the same column would be a number twice
  const refs = Object.values(value.columns).filter(ref => ref !== undefined)
  const keys = refs.map(ref => (typeof ref === 'string' ? `h:${headerKey(ref)}` : `i:${ref}`))
  if (new Set(keys).size !== keys.length) return 'each value must be read from a column of its own'
  // A comma that separates the cells cannot also be the decimal comma: "12,50" would be two cells
  if (value.delimiter === value.decimalSeparator) {
    return 'the delimiter and the decimal separator must differ'
  }
  return null
}
const profileIsValid = (value: Parameters<typeof remittanceProfileProblem>[0]): boolean =>
  remittanceProfileProblem(value) === null
const PROFILE_MESSAGE = { message: 'the profile breaks a rule of the import profiles' }

export const remittanceImportProfileBodySchema = z.strictObject({
  delimiter: delimiterSchema.default(RemittanceDelimiters.COMMA),
  hasHeader: z.boolean().default(true),
  decimalSeparator: decimalSchema.default(RemittanceDecimalSeparators.DOT),
  dateFormat: dateFormatSchema.default(RemittanceDateFormats.ISO),
  columns: remittanceImportMappingSchema
})
export type RemittanceImportProfileBody = z.output<typeof remittanceImportProfileBodySchema>

export const createRemittanceImportProfileSchema = z
  .strictObject({
    connectionId: uuidSchema,
    name: singleLineText(80, 1),
    delimiter: delimiterSchema.default(RemittanceDelimiters.COMMA),
    hasHeader: z.boolean().default(true),
    decimalSeparator: decimalSchema.default(RemittanceDecimalSeparators.DOT),
    dateFormat: dateFormatSchema.default(RemittanceDateFormats.ISO),
    columns: remittanceImportMappingSchema
  })
  .refine(profileIsValid, PROFILE_MESSAGE)
export type CreateRemittanceImportProfileBody = z.output<typeof createRemittanceImportProfileSchema>

export const updateRemittanceImportProfileSchema = z
  .strictObject({
    name: singleLineText(80, 1).optional(),
    delimiter: delimiterSchema.optional(),
    hasHeader: z.boolean().optional(),
    decimalSeparator: decimalSchema.optional(),
    dateFormat: dateFormatSchema.optional(),
    columns: remittanceImportMappingSchema.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })
export type UpdateRemittanceImportProfileBody = z.output<typeof updateRemittanceImportProfileSchema>

// The mapper's preview: a sample of the file and the mapping being tried, before anything is saved
export const remittanceImportPreviewSchema = z.strictObject({
  // In bytes, not characters: a sample of accents takes up to four bytes a character
  text: z
    .string()
    .min(1)
    .refine(
      value => new TextEncoder().encode(value).length <= RemittanceImportLimits.PREVIEW_MAX_BYTES,
      {
        message: 'the sample is larger than a preview takes'
      }
    ),
  profile: remittanceImportProfileBodySchema.refine(profileIsValid, PROFILE_MESSAGE)
})
export type RemittanceImportPreviewBody = z.output<typeof remittanceImportPreviewSchema>

// The query of the import of a file: the connection it came from and the saved profile that reads it. The file is the body.
export const remittanceImportQuerySchema = z.strictObject({
  connectionId: uuidSchema,
  profileId: uuidSchema
})
export type RemittanceImportQuery = z.output<typeof remittanceImportQuerySchema>

export const remittanceImportProfilesQuerySchema = z.strictObject({
  connectionId: uuidSchema.optional()
})
export type RemittanceImportProfilesQuery = z.output<typeof remittanceImportProfilesQuerySchema>
