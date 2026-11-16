import { z } from 'zod'

import {
  LegalBookCorrelativeRestart,
  LegalBookField,
  LegalBookKind,
  LegalBookLimits,
  LegalBookSort,
  LegalBookUnissuedSales
} from '@platform/core/domain'

// The legal books (TDD_18 §7; Step 4B.8b-3). A layout is data the organization writes, so every field of it is a closed value or a
// bounded text; nothing in it can name a column that is not in the catalog of its kind (the service checks the kind, the pure
// `layoutProblem` the rest).
export const legalBookKindSchema = z.enum(LegalBookKind)

export const bookColumnSchema = z.strictObject({
  field: z.enum(LegalBookField),
  // The header of the column in the file: one line of the organization's own text
  label: z
    .string()
    .min(1)
    .max(LegalBookLimits.LABEL_MAX_LENGTH)
    .refine(value => !/[\r\n\t]/.test(value), { message: 'a label is one line of text' })
    .nullable()
})

export const bookLayoutBodySchema = z.strictObject({
  columns: z.array(bookColumnSchema).min(1).max(LegalBookLimits.MAX_COLUMNS),
  sort: z.enum(LegalBookSort),
  correlativeStart: z.number().int().min(1).max(LegalBookLimits.CORRELATIVE_START_MAX),
  correlativeRestart: z.enum(LegalBookCorrelativeRestart),
  unissuedSales: z.enum(LegalBookUnissuedSales),
  // Somebody with the accountant's word says this is the layout the law asks for. The proposal is never confirmed.
  accountantConfirmed: z.boolean()
})

// A book is read for a fiscal period; the version of the layout is the latest unless one is named (the proposal is version 0), so the
// book of a month can be asked for again with the layout it was written with
export const bookQuerySchema = z.strictObject({
  periodId: z.uuid(),
  // An empty value is no value (a bare `layoutVersion=` must not read as 0, the proposal)
  layoutVersion: z.preprocess(
    value => (value === '' ? undefined : value),
    z.coerce.number().int().min(0).max(1_000_000).optional()
  )
})

export const frozenBooksQuerySchema = z.strictObject({
  periodId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
})

export type BookLayoutBody = z.infer<typeof bookLayoutBodySchema>
export type BookQuery = z.infer<typeof bookQuerySchema>
export type FrozenBooksQuery = z.infer<typeof frozenBooksQuerySchema>
