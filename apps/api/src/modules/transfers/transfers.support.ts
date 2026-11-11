import { Permissions } from '@platform/core/auth'
import {
  type PrismaService,
  type PrismaTransaction,
  type StockTransferWhereInput
} from '@platform/core/database'
import { MembershipStatus, type TransferStatus, TransferLockScopes } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  formatTransferNumber,
  productNotTracked,
  transferSequence,
  variantRequired,
  warehouseInactive,
  warehouseNotLinked
} from '@platform/core/inventory'

export interface LockedTransfer {
  id: string
  number: string
  status: TransferStatus
  fromWarehouseId: string
  toWarehouseId: string
}

// The transfer of the organization, locked until the transaction ends: whoever dispatches, receives, closes, cancels or
// edits it takes turns, and what a request reads next is what the last one left. A transfer of another organization is
// a transfer that does not exist.
export async function lockTransfer(
  tx: PrismaTransaction,
  organizationId: string,
  transferId: string
): Promise<LockedTransfer> {
  const rows = await tx.$queryRaw<
    {
      id: string
      number: string
      status: string
      from_warehouse_id: string
      to_warehouse_id: string
    }[]
  >`
    SELECT id, number, status, from_warehouse_id, to_warehouse_id FROM stock_transfers
    WHERE id = ${transferId} AND organization_id = ${organizationId} FOR UPDATE`
  const row = rows[0]
  if (row === undefined) throw resourceNotFound('transfer')
  return {
    id: row.id,
    number: row.number,
    // Written by the service only, and the database checks it
    status: row.status as TransferStatus,
    fromWarehouseId: row.from_warehouse_id,
    toWarehouseId: row.to_warehouse_id
  }
}

// The number of the next transfer of the organization: one creator at a time, so two requests never take the same one
// (the unique index is the last word)
export async function nextTransferNumber(
  tx: PrismaTransaction,
  organizationId: string
): Promise<string> {
  await tx.$queryRaw`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${TransferLockScopes.NUMBERS}`}, 0))) AS lock`
  const rows = await tx.$queryRaw<{ number: string }[]>`
    SELECT number FROM stock_transfers WHERE organization_id = ${organizationId}
    ORDER BY length(number) DESC, number DESC LIMIT 1`
  const highest = rows[0] === undefined ? 0 : (transferSequence(rows[0].number) ?? 0)
  return formatTransferNumber(highest + 1)
}

// The stores of the organization the caller is an active member of AND holds a transfer permission in (the permission is
// the one of the role they have in EACH store, not only in the store of the header): the ones whose lines they see and
// may write. A member of a store whose role has no part in transfers sees nothing of it here.
export async function visibleStoreIds(
  prisma: PrismaService,
  organizationId: string,
  userId: string
): Promise<string[]> {
  const rows = await prisma.client.membership.findMany({
    where: {
      userId,
      organizationId,
      status: MembershipStatus.ACTIVE,
      revokedAt: null,
      role: {
        permissions: {
          some: {
            name: {
              in: [Permissions.INVENTORY_MANAGE_TRANSFERS, Permissions.INVENTORY_RECEIVE_TRANSFERS]
            }
          }
        }
      }
    },
    select: { storeId: true }
  })
  return rows.map(row => row.storeId)
}

// A transfer the caller may know exists: one they made, one with no line yet, or one with a line of a store they see.
// What is made only of other stores' lines is not theirs: not even its header (number, note, warehouses) is shown.
export const reachableTransfer = (
  userId: string,
  visible: readonly string[]
): { OR: StockTransferWhereInput[] } => ({
  OR: [
    { createdBy: userId },
    { lines: { none: {} } },
    { lines: { some: { storeId: { in: [...visible] } } } }
  ]
})

// Dispatching and cancelling move the stock of EVERY line, so the caller must see every line: they cannot write the
// stock of a store they do not belong to (or hold no transfer permission in).
export function assertSeesEveryLine(
  lines: readonly { storeId: string }[],
  visible: readonly string[]
): void {
  if (lines.some(line => !visible.includes(line.storeId))) {
    throw new PlatformException(
      ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH,
      'the transfer has lines of stores the caller does not belong to',
      HttpStatusCodes.CONFLICT
    )
  }
}

// The two warehouses of a transfer: both of the organization (another organization's is a warehouse that does not
// exist), different (a database check says it too), and on. They are held FOR KEY SHARE until the end of the
// transaction, so that switching one off waits for the request and the request does not move stock to a warehouse that
// was switched off a moment earlier.
export async function checkWarehouses(
  tx: PrismaTransaction,
  organizationId: string,
  fromWarehouseId: string,
  toWarehouseId: string
): Promise<void> {
  if (fromWarehouseId === toWarehouseId) {
    throw new PlatformException(
      ErrorCodes.INVENTORY_TRANSFER_SAME_WAREHOUSE,
      'a transfer goes between two different warehouses',
      HttpStatusCodes.CONFLICT
    )
  }
  const rows = await tx.$queryRaw<{ id: string; active: boolean }[]>`
    SELECT id, active FROM warehouses
    WHERE organization_id = ${organizationId} AND id IN (${fromWarehouseId}, ${toWarehouseId})
    ORDER BY id FOR KEY SHARE`
  for (const id of [fromWarehouseId, toWarehouseId]) {
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) throw resourceNotFound('warehouse')
    if (!row.active) throw warehouseInactive(id)
  }
}

export interface TransferItem {
  storeId: string
  productId: string
  variantId: string | null
}

// What a line may name: a product (and a variant of it, when it has them) that tracks stock, and whose store sells
// from BOTH warehouses, "otherwise stock would land where the store cannot sell it" (TDD_16 §4.5). The links are read
// FOR KEY SHARE: unlinking a store from a warehouse waits for the request.
export async function checkItems(
  tx: PrismaTransaction,
  items: readonly TransferItem[],
  warehouseIds: readonly [string, string]
): Promise<void> {
  if (items.length === 0) return
  const productIds = [...new Set(items.map(item => item.productId))]
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      storeId: true,
      trackInventory: true,
      variants: { where: { active: true }, select: { id: true } }
    }
  })
  const byId = new Map(products.map(product => [product.id, product]))
  for (const item of items) {
    const product = byId.get(item.productId)
    // The store of the line is the one of the product, and the caller named both through what they may see
    if (product === undefined || product.storeId !== item.storeId) throw resourceNotFound('product')
    if (!product.trackInventory) throw productNotTracked(product.id)
    if (item.variantId === null) {
      if (product.variants.length > 0) throw variantRequired(product.id)
    } else if (!product.variants.some(variant => variant.id === item.variantId)) {
      throw resourceNotFound('variant')
    }
  }
  const storeIds = [...new Set(items.map(item => item.storeId))]
  const links = await tx.$queryRaw<{ store_id: string; warehouse_id: string }[]>`
    SELECT store_id, warehouse_id FROM store_warehouses
    WHERE store_id = ANY(${storeIds}) AND warehouse_id IN (${warehouseIds[0]}, ${warehouseIds[1]})
    ORDER BY id FOR KEY SHARE`
  const linked = new Set(links.map(link => `${link.store_id}:${link.warehouse_id}`))
  for (const storeId of storeIds) {
    for (const warehouseId of warehouseIds) {
      if (!linked.has(`${storeId}:${warehouseId}`)) throw warehouseNotLinked(warehouseId)
    }
  }
}

export const invalidTransition = (from: TransferStatus, to: TransferStatus): PlatformException =>
  new PlatformException(
    ErrorCodes.INVENTORY_TRANSFER_INVALID_STATUS_TRANSITION,
    `a transfer that is ${from} cannot become ${to}`,
    HttpStatusCodes.CONFLICT,
    { from, to }
  )
