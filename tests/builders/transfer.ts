import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import { TransferStatus } from '@platform/core/domain'

import { createProduct } from './product'
import { createWarehouse } from './warehouse'

// A number that reads like the ones of the service ("TR-" and digits) and that no other fixture of the run takes
export const uniqueTransferNumber = (): string =>
  `TR-${randomUUID().replace(/\D/g, '').slice(0, 8).padEnd(4, '0')}`

// A draft transfer of an organization between two warehouses of its own, written as the owner (the api cannot say
// another organization's: it is the very thing the isolation suite is about). With `storeId` it carries one line of a
// new product of that store.
export async function createTransfer(
  owner: OwnerClient,
  input: { organizationId: string; storeId?: string; status?: TransferStatus }
): Promise<{ id: string; number: string; lineId: string | null }> {
  const from = await createWarehouse(owner, { organizationId: input.organizationId })
  const to = await createWarehouse(owner, { organizationId: input.organizationId })
  const product =
    input.storeId === undefined ? null : await createProduct(owner, { storeId: input.storeId })
  const status = input.status ?? TransferStatus.DRAFT
  const number = uniqueTransferNumber()
  const created = await owner.stockTransfer.create({
    data: {
      organizationId: input.organizationId,
      number,
      fromWarehouseId: from.id,
      toWarehouseId: to.id,
      status,
      createdBy: 'test',
      // What the database requires of a transfer that left, or ended
      ...(status === TransferStatus.DRAFT
        ? {}
        : { dispatchedAt: new Date(), dispatchedBy: 'test' }),
      ...(status === TransferStatus.RECEIVED || status === TransferStatus.CANCELLED
        ? { closedAt: new Date() }
        : {}),
      ...(input.storeId === undefined || product === null
        ? {}
        : {
            lines: {
              create: [
                {
                  storeId: input.storeId,
                  productId: product.id,
                  quantity: 3,
                  // What a transfer that ended in full holds: everything arrived
                  receivedQuantity: status === TransferStatus.RECEIVED ? 3 : 0
                }
              ]
            }
          })
    },
    select: { id: true, number: true, lines: { select: { id: true } } }
  })
  return { id: created.id, number: created.number, lineId: created.lines[0]?.id ?? null }
}
