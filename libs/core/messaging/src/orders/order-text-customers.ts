import type { PrismaService } from '@platform/core/database'
import { OrderSearchConfig } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { orderTextCustomerPatterns } from './order-list-where'

// The customers of the store that the text of the orders list names, by name, e-mail or phone (empty when the text is an order number
// only). It runs inside the context of ONE store: the function of the database (migration rls_search_order_customers) reads the store
// from it and raises without one. A text that names more customers than the list can carry is refused, never truncated.
export async function orderTextCustomerIds(
  prisma: PrismaService,
  storeId: string,
  q: string | undefined
): Promise<string[]> {
  const patterns = q === undefined ? null : orderTextCustomerPatterns(q)
  if (patterns === null) return []
  const cap = OrderSearchConfig.MAX_CUSTOMER_MATCHES
  const rows = await prisma.inStoreContext(
    storeId,
    () =>
      prisma.client.$queryRaw<{ id: string }[]>`
      SELECT f.id FROM public.rls_search_order_customers(
        ${patterns.name}::text, ${patterns.email}::text, ${patterns.phone}::text, ${cap + 1}::integer
      ) AS f`
  )
  if (rows.length > cap) {
    throw new PlatformException(
      ErrorCodes.SEARCH_TOO_BROAD,
      'the text matches too many customers: type more of it',
      HttpStatusCodes.BAD_REQUEST
    )
  }
  return rows.map(row => row.id)
}
