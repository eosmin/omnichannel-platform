import type { Permission } from '@platform/core/auth'
import type { PrismaTransaction } from '@platform/core/database'
import {
  CountLockScopes,
  CountStatus,
  CountStatusTransitions,
  MembershipStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'

export interface LockedCount {
  id: string
  organizationId: string
  warehouseId: string
  number: string
  status: CountStatus
  storeId: string | null
}

// The count of the organization, locked until the transaction ends: whoever changes it takes turns, so two applies of
// the same count (or an apply and a cancel) never run together. A count of another organization does not exist.
export async function lockCount(
  tx: PrismaTransaction,
  organizationId: string,
  countId: string
): Promise<LockedCount> {
  const rows = await tx.$queryRaw<
    {
      id: string
      organization_id: string
      warehouse_id: string
      number: string
      status: string
      store_id: string | null
    }[]
  >`
    SELECT id, organization_id, warehouse_id, number, status, store_id FROM stock_counts
    WHERE id = ${countId} AND organization_id = ${organizationId} FOR UPDATE`
  const row = rows[0]
  if (row === undefined) throw resourceNotFound('count')
  return {
    id: row.id,
    organizationId: row.organization_id,
    warehouseId: row.warehouse_id,
    number: row.number,
    status: row.status as CountStatus,
    storeId: row.store_id
  }
}

// One creator at a time per organization, so the number of a new sheet follows the last one with no gap or repeat
export async function lockCountNumbers(
  tx: PrismaTransaction,
  organizationId: string
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${CountLockScopes.NUMBER}`}, 0))) AS lock`
}

export function invalidTransition(from: CountStatus, to: CountStatus): PlatformException {
  return new PlatformException(
    ErrorCodes.INVENTORY_COUNT_INVALID_STATUS_TRANSITION,
    `a count that is ${from} cannot become ${to}`,
    HttpStatusCodes.CONFLICT,
    { from, to }
  )
}

// The state machine of TDD_16 §4.6: what the count is now decides what it may become
export function assertTransition(from: CountStatus, to: CountStatus): void {
  if (!CountStatusTransitions[from].includes(to)) throw invalidTransition(from, to)
}

// Entering quantities is only for a count that is being counted
export function assertCounting(count: LockedCount): void {
  if (count.status !== CountStatus.COUNTING) {
    throw new PlatformException(
      ErrorCodes.INVENTORY_COUNT_INVALID_STATUS_TRANSITION,
      `quantities are entered while a count is counting, this one is ${count.status}`,
      HttpStatusCodes.CONFLICT,
      { from: count.status, to: CountStatus.COUNTING }
    )
  }
}

// The stores of the organization where the person is an active member, and holds the permission when one is named.
// The lines of a count belong to the store of their product: this is what a person sees and what they may touch.
export async function storesOf(
  db: Pick<PrismaTransaction, 'membership'>,
  organizationId: string,
  userId: string,
  permission?: Permission
): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: {
      userId,
      organizationId,
      status: MembershipStatus.ACTIVE,
      revokedAt: null,
      ...(permission === undefined ? {} : { role: { permissions: { some: { name: permission } } } })
    },
    select: { storeId: true }
  })
  return rows.map(row => row.storeId)
}
