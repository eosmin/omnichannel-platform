import { z } from 'zod'

import {
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalLimits,
  singleLineText
} from '@platform/core/domain'

export const idSchema = z.uuid()

const text = (max: number) => singleLineText(max, 1)
// What a provider reads from an address: short lines of text keyed by the provider's own field names
const addressSchema = z
  .record(z.string().min(1).max(40), text(200))
  .refine(value => Object.keys(value).length <= 12, { message: 'too many address fields' })

export const putIssuerSchema = z
  .object({
    providerId: text(64),
    legalName: text(200),
    taxId: text(40),
    registrationId: text(40).nullable().default(null),
    address: addressSchema,
    activityCode: text(40).nullable().default(null),
    establishmentCode: text(40).nullable().default(null),
    environment: z.enum(FiscalEnvironment),
    issueOn: z.enum(FiscalIssueOn).default(FiscalIssueOn.DELIVERED),
    // The correlative of the next document; it only moves forward
    nextSequence: z.number().int().min(1).max(FiscalLimits.MAX_SEQUENCE).optional(),
    // Written, never read back
    credentials: z.record(z.string().min(1).max(64), z.string().min(1).max(8000)).optional()
  })
  .strict()
export type PutIssuerBody = z.output<typeof putIssuerSchema>

export const listDocumentsQuerySchema = z.object({
  status: z.enum(FiscalDocumentStatus).optional(),
  orderId: z.uuid().optional(),
  // The correlative of the last document of the previous page
  cursor: z
    .string()
    .regex(/^\d{1,10}$/)
    .refine(value => Number(value) <= FiscalLimits.MAX_SEQUENCE, { message: 'not a correlative' })
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(FiscalLimits.LIST_MAX_PAGE_SIZE)
    .default(FiscalLimits.LIST_PAGE_SIZE)
})
export type ListDocumentsQuery = z.output<typeof listDocumentsQuerySchema>

// Fields sent as null are removed from the receiver; a field left out stays
export const receiverPatchSchema = z
  .object({
    name: text(200).nullable(),
    taxId: text(40).nullable(),
    registrationId: text(40).nullable(),
    email: text(200).nullable(),
    phone: text(40).nullable(),
    address: addressSchema.nullable()
  })
  .partial()
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'nothing to change' })
export type ReceiverPatchBody = z.output<typeof receiverPatchSchema>

export const voidDocumentSchema = z
  .object({ reason: text(FiscalLimits.VOID_REASON_MAX_LENGTH) })
  .strict()
export type VoidDocumentBody = z.output<typeof voidDocumentSchema>
