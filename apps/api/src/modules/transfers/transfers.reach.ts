import { Permissions } from '@platform/core/auth'
import type { PrismaService, StockTransferWhereInput } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'

// Which transfers and which lines a caller reaches. Apart from the rest of the support so that a unit spec can load it: the support
// imports the stock engine, a Nest module.

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
// A plugin is bound to ONE store and has no person: it reaches only a transfer with a line of its store (a transfer with no
// line yet belongs to no store, so a key of another store has no claim to it), never one "it made".
export const reachableTransfer = (
  actor: { userId: string; pluginInstallationId?: string | undefined },
  visible: readonly string[]
): { OR: StockTransferWhereInput[] } => ({
  OR:
    actor.pluginInstallationId === undefined
      ? [
          { createdBy: actor.userId },
          { lines: { none: {} } },
          { lines: { some: { storeId: { in: [...visible] } } } }
        ]
      : [{ lines: { some: { storeId: { in: [...visible] } } } }]
})

// The stores whose lines the caller sees: the ones of their memberships with a transfer permission, or for a plugin the one
// store of its key (it holds no membership; the permission it holds is the scope's)
export function visibleStoresOf(
  prisma: PrismaService,
  organizationId: string,
  actor: { userId: string; storeId: string; pluginInstallationId?: string | undefined }
): Promise<string[]> {
  return actor.pluginInstallationId === undefined
    ? visibleStoreIds(prisma, organizationId, actor.userId)
    : Promise.resolve([actor.storeId])
}
