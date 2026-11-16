import { z } from 'zod'

import {
  FiscalEvidenceKind,
  fiscalIdSchema,
  type FiscalReceiverPatchBody,
  fiscalReceiverPatchSchema,
  FiscalLimits,
  FiscalSweepKind,
  FiscalSweepLimits,
  type ListFiscalDocumentsQuery,
  listFiscalDocumentsQuerySchema,
  type PutFiscalIssuerBody,
  putFiscalIssuerSchema,
  singleLineText,
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

export const evidenceKindSchema = z.enum(FiscalEvidenceKind)

// The dry run of the daily check: one kind of finding, a page at a time (the cursor is the id the last page ended at)
export const reconciliationQuerySchema = z.object({
  kind: z.enum(FiscalSweepKind),
  cursor: z.uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(FiscalSweepLimits.PAGE_SIZE_MAX)
    .default(FiscalSweepLimits.PAGE_SIZE_DEFAULT)
})
export type ReconciliationQuery = z.output<typeof reconciliationQuerySchema>

// What the person checked with the authority of the first issuer: that the document is not there
export const confirmIssuerChangeSchema = z
  .object({ reason: singleLineText(FiscalLimits.VOID_REASON_MAX_LENGTH, 1) })
  .strict()
export type ConfirmIssuerChangeBody = z.output<typeof confirmIssuerChangeSchema>
