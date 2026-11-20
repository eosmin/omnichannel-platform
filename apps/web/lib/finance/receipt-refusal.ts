import { ApiError } from '@platform/api-client'
import { FinanceConflicts } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

// The key of the sentence for a file the scan gave up on (a refused PDF among them): it is not a conflict of the finance module but a
// 410 `FILE_UNSCANNABLE` that the wait for the verdict throws before the file is attached
const FILE_UNSCANNABLE_KIND = 'file_unscannable'

// Why a receipt was not attached, each with its own sentence under `finance.transactions.receipt.refusals.<kind>`. The three conflicts of
// attaching name their kind in `metadata.conflict` (a 409 `RESOURCE_CONFLICT`, which has no sentence of its own). Null when the error is
// none of them: the caller then shows the message of its code.
export const RECEIPT_REFUSALS = [
  FinanceConflicts.TRANSACTION_DOCUMENT_REFUSED,
  FinanceConflicts.TRANSACTION_DOCUMENT_NOT_CLEAN,
  FinanceConflicts.TRANSACTION_DOCUMENT_ALREADY_SET,
  FILE_UNSCANNABLE_KIND
] as const

export type ReceiptRefusal = (typeof RECEIPT_REFUSALS)[number]

export function receiptRefusalOf(error: unknown): ReceiptRefusal | null {
  if (!(error instanceof ApiError)) return null
  if (error.is(ClientErrorCodes.FILE_UNSCANNABLE)) return FILE_UNSCANNABLE_KIND
  const conflict: unknown = error.metadata['conflict']
  return RECEIPT_REFUSALS.find(known => known === conflict) ?? null
}
