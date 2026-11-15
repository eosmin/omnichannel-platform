import type { Permission } from '@platform/core/auth'
import type { PrismaTransaction, StockCountWhereInput } from '@platform/core/database'
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

// What a plugin writes is a count limited to the store of its key: starting one snapshots, and applying one moves, the stock of every
// store it covers, and cancelling, submitting or reopening one decides for the people who count it. A count of the whole warehouse
// that has a line of its store is read only to a plugin (403), as a transfer that spans a sibling store is (PR E4b-2); a count it
// cannot read (limited to another store, or of a warehouse with no line of its store) does not exist for it (404), the same as for
// a read. A person writes any count of the organization, as before.
export async function assertActorMayWrite(
  tx: Pick<PrismaTransaction, 'stockCountLine'>,
  count: { id: string; storeId: string | null },
  actor: { storeId: string; pluginInstallationId?: string | undefined }
): Promise<void> {
  if (actor.pluginInstallationId === undefined || count.storeId === actor.storeId) return
  const reads =
    count.storeId === null &&
    (await tx.stockCountLine.findFirst({
      where: { countId: count.id, storeId: actor.storeId },
      select: { id: true }
    })) !== null
  if (!reads) throw resourceNotFound('count')
  throw new PlatformException(
    ErrorCodes.INVENTORY_COUNT_STORES_NOT_ALLOWED,
    'a plugin changes only a count limited to the store of its key',
    HttpStatusCodes.FORBIDDEN
  )
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

// The stores a caller counts or applies in: a person's are the ones where they hold the permission, a plugin's is the one store of its
// key (it holds no membership; the permission is its scope's). One place, so that no write of a count forgets the plugin and asks the
// memberships for the synthetic id of an installation.
export async function storesOfActor(
  db: Pick<PrismaTransaction, 'membership'>,
  organizationId: string,
  actor: { userId: string; storeId: string; pluginInstallationId?: string | undefined },
  permission: Permission
): Promise<string[]> {
  return actor.pluginInstallationId === undefined
    ? storesOf(db, organizationId, actor.userId, permission)
    : [actor.storeId]
}

// The counts a caller reaches (Step 5.6 PR E4b). A plugin's key is bound to ONE store and holds no membership, so it reaches the
// counts limited to that store and the ones of every store of a warehouse that have a line of its store. A count limited to another
// store is not its to know: not even its header (number, note, store name) is shown. A person's reach is the whole organization and
// adds nothing to the query. It is an AND so that it does not replace the OR of the cursor. The reach comes from the ACTOR, so a
// caller cannot forget it: a plugin actor never reads as a person.
export const reachableCount = (actor: {
  storeId: string
  pluginInstallationId?: string | undefined
}): { AND: StockCountWhereInput[] } | undefined =>
  actor.pluginInstallationId === undefined
    ? undefined
    : {
        AND: [
          {
            OR: [
              { storeId: actor.storeId },
              { storeId: null, lines: { some: { storeId: actor.storeId } } }
            ]
          }
        ]
      }
