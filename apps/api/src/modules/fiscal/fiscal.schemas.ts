import { z } from 'zod'

import {
  confirmFiscalIssuerChangeSchema,
  FiscalAnnexLimits,
  FiscalEvidenceKind,
  fiscalIdSchema,
  fiscalReceiverPatchSchema,
  fiscalDeliveryQuerySchema,
  handOverFiscalDeliverySchema,
  FiscalSweepKind,
  FiscalSweepLimits,
  listFiscalDocumentsQuerySchema,
  lowercasedUuidSchema,
  queryIntSchema,
  putFiscalIssuerSchema,
  type ConfirmFiscalIssuerChangeBody,
  type FiscalReceiverPatchBody,
  type FiscalDeliveryQuery,
  type HandOverFiscalDeliveryBody,
  type ListFiscalDocumentsQuery,
  type PutFiscalIssuerBody,
  type VoidFiscalDocumentBody,
  voidFiscalDocumentSchema
} from '@platform/core/domain'

// The schemas of the fiscal routes the web also sends are in the shared domain lib (`fiscal-schemas.ts`), so a web form is tested against
// the same schema that reads it. The controller keeps its own names for them.
export const idSchema = fiscalIdSchema
export const putIssuerSchema = putFiscalIssuerSchema
export type PutIssuerBody = PutFiscalIssuerBody
export const listDocumentsQuerySchema = listFiscalDocumentsQuerySchema
export type ListDocumentsQuery = ListFiscalDocumentsQuery
export const receiverPatchSchema = fiscalReceiverPatchSchema
export type ReceiverPatchBody = FiscalReceiverPatchBody
export const voidDocumentSchema = voidFiscalDocumentSchema
export type VoidDocumentBody = VoidFiscalDocumentBody

export const deliveryQuerySchema = fiscalDeliveryQuerySchema
export type DeliveryQuery = FiscalDeliveryQuery
export const handOverSchema = handOverFiscalDeliverySchema
export type HandOverBody = HandOverFiscalDeliveryBody

export const evidenceKindSchema = z.enum(FiscalEvidenceKind)

// The dry run of the daily check: one kind of finding, a page at a time (the cursor is the id the last page ended at)
export const reconciliationQuerySchema = z.object({
  kind: z.enum(FiscalSweepKind),
  cursor: lowercasedUuidSchema.optional(),
  limit: queryIntSchema(1, FiscalSweepLimits.PAGE_SIZE_MAX).default(
    FiscalSweepLimits.PAGE_SIZE_DEFAULT
  )
})
export type ReconciliationQuery = z.output<typeof reconciliationQuerySchema>

export const confirmIssuerChangeSchema = confirmFiscalIssuerChangeSchema
export type ConfirmIssuerChangeBody = ConfirmFiscalIssuerChangeBody

// One annex of the periodic return of a month: the id is the provider's own (checked by the runtime against the annexes of the issuer's
// provider, a 404 for one it does not make); the month is a calendar month
export const annexIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const annexQuerySchema = z.strictObject({
  year: queryIntSchema(FiscalAnnexLimits.FIRST_YEAR, FiscalAnnexLimits.LAST_YEAR),
  month: queryIntSchema(1, 12)
})
export type AnnexQuery = z.output<typeof annexQuerySchema>
