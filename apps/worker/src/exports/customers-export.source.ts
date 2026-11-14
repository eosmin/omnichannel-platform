import type { PrismaService } from '@platform/core/database'
import { CustomerFigureOrderStatuses, customerOrderFigures } from '@platform/core/domain'
import { ExportLimits } from '@platform/core/exports'
import {
  customerSearchWhere,
  type CustomersExportFilters,
  foldInDatabase
} from '@platform/core/messaging'

import type { CsvSource } from './csv-export-writer'

// MVP_TRIM_CHECKLIST.md §10 item 25. The notes stay out (their text is internal). The order columns are
// the figures of the profile (`customerOrderFigures`: only the orders the store has taken on), `total_spent`
// and `average_order` in integer cents of the order currency (0 and an empty average and dates for a customer
// with no counted order).
export const CUSTOMER_COLUMNS = [
  'id',
  'name',
  'email',
  'phone',
  'phone_digits',
  'locale',
  'created_at',
  'updated_at',
  'channels',
  'tags',
  'caution',
  'caution_reason',
  'addresses',
  'default_address_line',
  'default_address_city',
  'default_address_state',
  'default_address_postal_code',
  'default_address_country',
  'notes',
  'conversations',
  'first_conversation_at',
  'last_conversation_at',
  'orders',
  'total_spent',
  'average_order',
  'first_order_at',
  'last_order_at'
] as const

export function customersExportSource(
  prisma: PrismaService,
  storeId: string,
  filters: CustomersExportFilters
): CsvSource {
  // The text is folded once, by the database, as the names it is compared with are
  let folded: Promise<string> | undefined
  const foldedText = (): Promise<string> =>
    (folded ??=
      filters.q === undefined ? Promise.resolve('') : foldInDatabase(prisma.client, filters.q))
  return {
    columns: CUSTOMER_COLUMNS,
    count: async () =>
      prisma.client.customer.count({
        where: customerSearchWhere(storeId, filters.q, await foldedText())
      }),
    rows: async function* () {
      let after: string | undefined
      for (;;) {
        const customers = await prisma.client.customer.findMany({
          // Keyset: a row deleted meanwhile cannot end the file early, as a cursor on it would
          where: {
            ...customerSearchWhere(storeId, filters.q, await foldedText()),
            ...(after === undefined ? {} : { id: { gt: after } })
          },
          orderBy: { id: 'asc' },
          take: ExportLimits.ROW_PAGE_SIZE,
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            phoneNormalized: true,
            locale: true,
            createdAt: true,
            updatedAt: true,
            isCaution: true,
            cautionReason: true,
            identities: {
              orderBy: { createdAt: 'asc' },
              select: { channelType: true, channelIdentity: true }
            },
            tags: { orderBy: { name: 'asc' }, select: { name: true } },
            addresses: {
              select: {
                line1: true,
                line2: true,
                city: true,
                state: true,
                postalCode: true,
                country: true,
                isDefault: true
              }
            },
            _count: { select: { notes: true, conversations: true } }
          }
        })
        const last = customers.at(-1)
        if (last === undefined) return
        after = last.id

        const spans = await prisma.client.conversation.groupBy({
          by: ['customerId'],
          where: { storeId, customerId: { in: customers.map(customer => customer.id) } },
          _min: { createdAt: true },
          _max: { createdAt: true }
        })
        const spanOf = new Map(spans.map(span => [span.customerId, span]))
        // The orders of the whole page in ONE grouped read, as the conversation dates are
        const sums = await prisma.client.order.groupBy({
          by: ['customerId'],
          where: {
            storeId,
            customerId: { in: customers.map(customer => customer.id) },
            status: { in: [...CustomerFigureOrderStatuses] }
          },
          _count: { _all: true },
          _sum: { totalCents: true },
          _min: { createdAt: true },
          _max: { createdAt: true }
        })
        const sumOf = new Map(sums.map(sum => [sum.customerId, sum]))

        for (const customer of customers) {
          const home = customer.addresses.find(address => address.isDefault)
          const span = spanOf.get(customer.id)
          const sum = sumOf.get(customer.id)
          const figures = customerOrderFigures(
            sum === undefined
              ? undefined
              : {
                  orders: sum._count._all,
                  totalSpentCents: sum._sum.totalCents ?? 0,
                  firstOrderAt: sum._min.createdAt,
                  lastOrderAt: sum._max.createdAt
                }
          )
          yield [
            customer.id,
            customer.name,
            customer.email,
            customer.phone,
            customer.phoneNormalized,
            customer.locale,
            customer.createdAt,
            customer.updatedAt,
            customer.identities.map(i => `${i.channelType}:${i.channelIdentity}`).join(' | '),
            customer.tags.map(tag => tag.name).join(' | '),
            customer.isCaution,
            customer.cautionReason,
            customer.addresses.length,
            home === undefined ? null : [home.line1, home.line2].filter(Boolean).join(', '),
            home?.city,
            home?.state,
            home?.postalCode,
            home?.country,
            customer._count.notes,
            customer._count.conversations,
            span?._min.createdAt,
            span?._max.createdAt,
            figures.orders,
            figures.totalSpentCents,
            figures.averageOrderCents,
            figures.firstOrderAt,
            figures.lastOrderAt
          ]
        }
      }
    }
  }
}
