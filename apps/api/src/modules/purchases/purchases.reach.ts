import { Permissions } from '@platform/core/auth'
import type { PrismaService, PrismaTransaction } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'

// Which lines of a purchase a caller reaches (TDD_18 §2.1): the lines carry the store of their product, and only the members of
// that store see them, like the lines of a transfer. Apart from the services so that a unit spec can load it.

// The stores of the organization the caller is an active member of AND holds the purchases permission in (the permission is the one
// of the role they have in EACH store, not only in the store of the header): the ones whose lines they see and may write.
export async function visibleStoreIds(
  prisma: PrismaService,
  organizationId: string,
  userId: string
): Promise<string[]> {
  return visibleStoreIdsIn(prisma.client, organizationId, userId)
}

// The same read through a transaction: a write that moves stock reads it AFTER the lock of its order, in the transaction that writes, so
// a permission revoked a moment ago is not honored on a membership read before the lock
export async function visibleStoreIdsIn(
  db: Pick<PrismaTransaction, 'membership'>,
  organizationId: string,
  userId: string
): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: {
      userId,
      organizationId,
      status: MembershipStatus.ACTIVE,
      revokedAt: null,
      role: { permissions: { some: { name: Permissions.FINANCE_MANAGE_PURCHASES } } }
    },
    select: { storeId: true }
  })
  return rows.map(row => row.storeId)
}

export const onlyVisible = <T extends { storeId: string }>(
  lines: readonly T[],
  visible: readonly string[]
): T[] => lines.filter(line => visible.includes(line.storeId))

// True when every line is of a store the caller sees: what a person writes (an edit of the lines, a receipt of them) must be wholly
// theirs, so a request never touches a line it cannot read
export const seesEveryLine = (
  lines: readonly { storeId: string }[],
  visible: readonly string[]
): boolean => lines.every(line => visible.includes(line.storeId))
