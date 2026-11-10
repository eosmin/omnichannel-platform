import {
  isUniqueViolation,
  type PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { WarehouseConflicts } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'

export const codeInUse = (): PlatformException =>
  new PlatformException(
    ErrorCodes.RESOURCE_ALREADY_EXISTS,
    'a warehouse of the organization already has that code',
    HttpStatusCodes.CONFLICT,
    { conflict: WarehouseConflicts.CODE_IN_USE }
  )

// The check of a service answers politely; the unique index (organization, lower(code)) is what holds when two
// requests ask for the same code at the same moment
export async function codeTransaction<T>(
  prisma: PrismaService,
  work: (tx: PrismaTransaction) => Promise<T>
): Promise<T> {
  try {
    return await prisma.transaction(work)
  } catch (error) {
    if (isUniqueViolation(error)) throw codeInUse()
    throw error
  }
}

export interface LockedWarehouse {
  id: string
  active: boolean
  code: string
  name: string
  address: unknown
}

// The warehouse of the organization, locked until the transaction ends: whoever changes it or its links takes turns,
// and the movements of stock (which lock it shared) wait for a deactivation to finish. A warehouse of another
// organization is a warehouse that does not exist.
export async function lockWarehouse(
  tx: PrismaTransaction,
  organizationId: string,
  warehouseId: string
): Promise<LockedWarehouse> {
  const rows = await tx.$queryRaw<LockedWarehouse[]>`
    SELECT id, active, code, name, address FROM warehouses
    WHERE id = ${warehouseId} AND organization_id = ${organizationId} FOR UPDATE`
  const row = rows[0]
  if (row === undefined) throw resourceNotFound('warehouse')
  return row
}

// One creator at a time per organization, so the count that holds the limit and the insert are one step
export async function lockOrganizationWarehouses(
  tx: PrismaTransaction,
  organizationId: string
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:warehouses`}, 0))) AS lock`
}
