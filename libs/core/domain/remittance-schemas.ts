import { z } from 'zod'

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
