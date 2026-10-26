import type { PrismaTransaction } from '@platform/core/database'

// A customer has a default address as long as they have an address. If the customer has none, the
// oldest takes over. `demoted` is the address that was just told it is not the default: another one
// takes over if there is another, and it stays the default if it is their only address.
export async function ensureDefaultAddress(
  tx: PrismaTransaction,
  customerId: string,
  demoted?: string
): Promise<void> {
  if ((await tx.address.count({ where: { customerId, isDefault: true } })) > 0) return
  const oldest = await tx.address.findFirst({
    where: { customerId, ...(demoted === undefined ? {} : { id: { not: demoted } }) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true }
  })
  const next = oldest?.id ?? demoted
  if (next !== undefined) {
    await tx.address.update({ where: { id: next }, data: { isDefault: true } })
  }
}
