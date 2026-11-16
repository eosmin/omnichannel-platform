import { z } from 'zod'

import { FiscalDocumentStatus } from './finance-constants'
import {
  FiscalCustomerDataLimits,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalLimits
} from './fiscal-constants'
import { singleLineText } from './validation'

// The bodies and the query of the fiscal routes (TDD_18 §8, §12). They live here, not in the api, so the web form that sends one is
// tested against the very schema that reads it (the purchases do the same).

// The longest text each field of the issuer and of a receiver takes: the forms count with them and the schemas below enforce them
export const FiscalFieldLimits = {
  NAME: 200,
  TAX_ID: 40,
  REGISTRATION_ID: 40,
  EMAIL: 200,
  PHONE: 40,
  CODE: 40,
  PROVIDER_ID: 64,
  ADDRESS_KEY: 40,
  ADDRESS_VALUE: 200,
  ADDRESS_MAX_FIELDS: 12,
  CREDENTIAL_KEY: 64,
  CREDENTIAL_VALUE: 8000
} as const

const text = (max: number) => singleLineText(max, 1)

export const fiscalIdSchema = z.uuid()

// What a provider reads from an address: short lines of text keyed by the provider's own field names
export const fiscalAddressSchema = z
  .record(
    z.string().min(1).max(FiscalFieldLimits.ADDRESS_KEY),
    text(FiscalFieldLimits.ADDRESS_VALUE)
  )
  .refine(value => Object.keys(value).length <= FiscalFieldLimits.ADDRESS_MAX_FIELDS, {
    message: 'too many address fields'
  })

export const putFiscalIssuerSchema = z
  .object({
    providerId: text(FiscalFieldLimits.PROVIDER_ID),
    legalName: text(FiscalFieldLimits.NAME),
    taxId: text(FiscalFieldLimits.TAX_ID),
    registrationId: text(FiscalFieldLimits.REGISTRATION_ID).nullable().default(null),
    address: fiscalAddressSchema,
    activityCode: text(FiscalFieldLimits.CODE).nullable().default(null),
    establishmentCode: text(FiscalFieldLimits.CODE).nullable().default(null),
    environment: z.enum(FiscalEnvironment),
    issueOn: z.enum(FiscalIssueOn).default(FiscalIssueOn.DELIVERED),
    // The correlative of the next document; it only moves forward
    nextSequence: z.number().int().min(1).max(FiscalLimits.MAX_SEQUENCE).optional(),
    // Written, never read back
    credentials: z
      .record(
        z.string().min(1).max(FiscalFieldLimits.CREDENTIAL_KEY),
        z.string().min(1).max(FiscalFieldLimits.CREDENTIAL_VALUE)
      )
      .optional()
  })
  .strict()
export type PutFiscalIssuerBody = z.output<typeof putFiscalIssuerSchema>

export const listFiscalDocumentsQuerySchema = z.object({
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
export type ListFiscalDocumentsQuery = z.output<typeof listFiscalDocumentsQuerySchema>

// Fields sent as null are removed from the receiver; a field left out stays
export const fiscalReceiverPatchSchema = z
  .object({
    name: text(FiscalFieldLimits.NAME).nullable(),
    taxId: text(FiscalFieldLimits.TAX_ID).nullable(),
    registrationId: text(FiscalFieldLimits.REGISTRATION_ID).nullable(),
    email: text(FiscalFieldLimits.EMAIL).nullable(),
    phone: text(FiscalFieldLimits.PHONE).nullable(),
    // The kind of taxpayer and the economic activity, in the words of the provider's own manifest
    taxpayerType: text(FiscalCustomerDataLimits.ID_MAX_LENGTH).nullable(),
    economicActivity: text(FiscalCustomerDataLimits.VALUE_MAX_LENGTH).nullable(),
    address: fiscalAddressSchema.nullable()
  })
  .partial()
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'nothing to change' })
export type FiscalReceiverPatchBody = z.output<typeof fiscalReceiverPatchSchema>

// A person's reason for a decision they sign (a void, an issuer change): one line, the same rule and the same limit for both
const fiscalReasonBodySchema = z
  .object({ reason: text(FiscalLimits.VOID_REASON_MAX_LENGTH) })
  .strict()

export const voidFiscalDocumentSchema = fiscalReasonBodySchema
export type VoidFiscalDocumentBody = z.output<typeof voidFiscalDocumentSchema>

// What the person checked with the authority of the first issuer: that the document is not there
export const confirmFiscalIssuerChangeSchema = fiscalReasonBodySchema
export type ConfirmFiscalIssuerChangeBody = z.output<typeof confirmFiscalIssuerChangeSchema>
