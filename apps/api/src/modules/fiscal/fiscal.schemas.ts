import { z } from 'zod'

import {
  type ConfirmFiscalIssuerChangeBody,
  confirmFiscalIssuerChangeSchema,
  FiscalEvidenceKind,
  fiscalIdSchema,
  type FiscalReceiverPatchBody,
  fiscalReceiverPatchSchema,
  type ListFiscalDocumentsQuery,
  listFiscalDocumentsQuerySchema,
  type PutFiscalIssuerBody,
  putFiscalIssuerSchema,
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

export const confirmIssuerChangeSchema = confirmFiscalIssuerChangeSchema
export type ConfirmIssuerChangeBody = ConfirmFiscalIssuerChangeBody
