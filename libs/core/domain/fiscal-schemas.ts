import { z } from 'zod'

import { FiscalDocumentStatus } from './finance-constants'
import {
  FiscalCustomerDataLimits,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalContingencyLimits,
  FiscalLimits,
  FiscalVoidKind
} from './fiscal-constants'
import { lowercasedUuidSchema, singleLineText } from './validation'

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

export const fiscalIdSchema = lowercasedUuidSchema

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
    // The registration, the activity and the establishment code, the kind of establishment, the point of sale and the contact of the issuer:
    // a field left out keeps the stored one, a field sent as null clears it, so a client that does not send them never wipes them
    registrationId: text(FiscalFieldLimits.REGISTRATION_ID).nullable().optional(),
    address: fiscalAddressSchema,
    activityCode: text(FiscalFieldLimits.CODE).nullable().optional(),
    establishmentCode: text(FiscalFieldLimits.CODE).nullable().optional(),
    establishmentType: text(FiscalFieldLimits.CODE).nullable().optional(),
    pointOfSaleCode: text(FiscalFieldLimits.CODE).nullable().optional(),
    phone: text(FiscalFieldLimits.PHONE).nullable().optional(),
    email: text(FiscalFieldLimits.EMAIL).nullable().optional(),
    environment: z.enum(FiscalEnvironment),
    // Absent keeps the one stored (a new issuer starts at delivered): a change that does not name it must not change when the documents are made
    issueOn: z.enum(FiscalIssueOn).optional(),
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

export const listFiscalDocumentsQuerySchema = z
  .object({
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
      .default(FiscalLimits.LIST_PAGE_SIZE),
    // The period of the creation of the document, both ends included, as ISO instants (the screen sends the start and the end of the day
    // of the person's own time zone)
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional()
  })
  .refine(
    value =>
      value.from === undefined ||
      value.to === undefined ||
      new Date(value.from).getTime() <= new Date(value.to).getTime(),
    { message: 'the period ends before it starts', path: ['to'] }
  )
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
    // The kind of identity document of `taxId`, in the words of the provider's own manifest
    documentType: text(FiscalCustomerDataLimits.ID_MAX_LENGTH).nullable(),
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

// A person of an invalidation: who makes it and who asks for it (a provider whose authority wants them declares it in its manifest)
const voidPartySchema = z
  .object({
    name: text(FiscalLimits.VOID_PARTY_NAME_MAX_LENGTH),
    // The kind of identity document, in the words of the provider's own catalog
    idType: text(FiscalFieldLimits.CODE),
    idNumber: text(FiscalLimits.VOID_PARTY_ID_MAX_LENGTH)
  })
  .strict()
export type VoidPartyBody = z.output<typeof voidPartySchema>

export const voidFiscalDocumentSchema = z
  .object({
    reason: text(FiscalLimits.VOID_REASON_MAX_LENGTH),
    // Absent: the provider's default (a document with no kind is the free reason alone)
    kind: z.enum(FiscalVoidKind).optional(),
    responsible: voidPartySchema.optional(),
    requester: voidPartySchema.optional(),
    // The accepted document that takes the place of this one (the authority wants it first for a correction)
    replacementDocumentId: fiscalIdSchema.optional()
  })
  .strict()
export type VoidFiscalDocumentBody = z.output<typeof voidFiscalDocumentSchema>

// A person starts a contingency of the issuer (Step 4B.7c-7): one of the reasons the provider's manifest declares, and what they say of it
export const enterFiscalContingencySchema = z
  .object({
    reason: text(FiscalFieldLimits.CODE),
    motive: text(FiscalContingencyLimits.MOTIVE_MAX_LENGTH).nullable().optional()
  })
  .strict()
export type EnterFiscalContingencyBody = z.output<typeof enterFiscalContingencySchema>

// A person ends it: who answers for the establishment, when the provider's authority asks
export const endFiscalContingencySchema = z
  .object({ responsible: voidPartySchema.optional() })
  .strict()
export type EndFiscalContingencyBody = z.output<typeof endFiscalContingencySchema>

// What the person checked with the authority of the first issuer: that the document is not there
export const confirmFiscalIssuerChangeSchema = fiscalReasonBodySchema
export type ConfirmFiscalIssuerChangeBody = z.output<typeof confirmFiscalIssuerChangeSchema>
