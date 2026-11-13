import type { PrismaTransaction } from '@platform/core/database'
import { formatLocalGuideNumber } from '@platform/core/domain'

// The next guide number of a connection whose carrier has `CarrierCapability.INTERNAL_GUIDE` (TDD_17 §4.2): `{prefix}-{sequence}`, unique per connection. It is taken
// inside the transaction that inserts the Shipment, with one UPDATE on the row of the sequence: the row stays locked
// until that transaction ends, so two guides never get the same number and a rollback gives the number back. A
// connection with no sequence (any other carrier) is not one this is called for, and the caller's bug is loud.
export async function takeLocalGuideNumber(
  tx: PrismaTransaction,
  storeId: string,
  connectionId: string
): Promise<string> {
  const row = await tx.guideSequence.update({
    where: { storeId_connectionId: { storeId, connectionId } },
    data: { nextValue: { increment: 1 } },
    select: { prefix: true, nextValue: true }
  })
  // The update returns the row after the increment: the number taken is the one before it
  return formatLocalGuideNumber(row.prefix, row.nextValue - 1)
}
