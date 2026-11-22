// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one page or count; the file is written to the bucket outside of it
import type { JobContext, PrismaService } from '@platform/core/database'
import { CustomerFigureOrderStatuses, customerOrderFigures } from '@platform/core/domain'
import { ExportLimits } from '@platform/core/exports'
import {
  countCustomerSearch,
  CustomerSearchOrders,
  customerSearchPatterns,
  customerSearchWhere,
  type CustomersExportFilters,
  type CustomerSearchPatterns,
  foldInDatabase,
  searchCustomerIds
} from '@platform/core/messaging'

import type { CsvSource } from './csv-export-writer'

// MVP_TRIM_CHECKLIST.md §10 item 25. The notes stay out (their text is internal). The order columns are
// the figures of the profile (`customerOrderFigures`: only the orders the store has taken on), `total_spent`
// and `average_order` in integer cents of the order currency (0 and an empty average and dates for a customer
// with no counted order). A customer with counted orders in two currencies has both columns empty (a sum across currencies is no
// figure) and `totals_by_currency` ("USD 12000 | EUR 8000") with each currency apart.
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
  'last_order_at',
  'totals_by_currency'
] as const

export function customersExportSource(
  prisma: PrismaService,
  jobContext: JobContext,
  storeId: string,
  filters: CustomersExportFilters
): CsvSource {
  // The patterns of the text are made once: the text is folded by the database, as the names it is compared with are
  let patterns: Promise<CustomerSearchPatterns | undefined> | undefined
  const patternsOfText = (): Promise<CustomerSearchPatterns | undefined> =>
    (patterns ??= (async () => {
      const { q } = filters
      return q === undefined
        ? undefined
        : customerSearchPatterns(
            q,
            await jobContext.forStore(storeId, () => foldInDatabase(prisma.client, q))
          )
    })())
  return {
    columns: CUSTOMER_COLUMNS,
    count: async () => {
      const found = await patternsOfText()
      // The functions of the database read the store from the context of the job, which the search joins
      return jobContext.forStore(storeId, () =>
        found === undefined
          ? prisma.client.customer.count({ where: customerSearchWhere(storeId) })
          : countCustomerSearch(prisma, storeId, found)
      )
    },
    rows: async function* () {
      let after: string | undefined
      let finished = false
      const found = await patternsOfText()
      while (!finished) {
        // With a search text, the ids of the page come from the function of the database (one page after the last id: a row
        // deleted meanwhile cannot end the file early); without one, the keyset is a condition of the read
        const { ids, customers } = await jobContext.forStore(storeId, async () => {
          const chosen =
            found === undefined
              ? undefined
              : await searchCustomerIds(prisma, storeId, found, {
                  order: CustomerSearchOrders.ID,
                  after,
                  limit: ExportLimits.ROW_PAGE_SIZE
                })
          const rows = await prisma.client.customer.findMany({
            where: {
              ...customerSearchWhere(storeId),
              ...(chosen === undefined
                ? after === undefined
                  ? {}
                  : { id: { gt: after } }
                : { id: { in: chosen } })
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
          return { ids: chosen, customers: rows }
        })
        if (ids === undefined) {
          const last = customers.at(-1)
          if (last === undefined) return
          after = last.id
        } else {
          // The keyset is the last id the database chose, not the last row that came back: rows merged or deleted between the two
          // statements must not end the file while later pages exist. A page shorter than the size is the last one.
          const lastId = ids.at(-1)
          if (lastId === undefined) return
          after = lastId
          finished = ids.length < ExportLimits.ROW_PAGE_SIZE
        }

        const spans = await jobContext.forStore(storeId, () =>
          prisma.client.conversation.groupBy({
            by: ['customerId'],
            where: { storeId, customerId: { in: customers.map(customer => customer.id) } },
            _min: { createdAt: true },
            _max: { createdAt: true }
          })
        )
        const spanOf = new Map(spans.map(span => [span.customerId, span]))
        // The orders of the whole page in ONE grouped read, as the conversation dates are
        const sums = await jobContext.forStore(storeId, () =>
          prisma.client.order.groupBy({
            by: ['customerId', 'currency'],
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
        )
        const sumsOf = new Map<string, typeof sums>()
        for (const sum of sums)
          sumsOf.set(sum.customerId, [...(sumsOf.get(sum.customerId) ?? []), sum])

        for (const customer of customers) {
          const home = customer.addresses.find(address => address.isDefault)
          const span = spanOf.get(customer.id)
          const figures = customerOrderFigures(
            (sumsOf.get(customer.id) ?? []).map(sum => ({
              currency: sum.currency,
              orders: sum._count._all,
              totalSpentCents: sum._sum.totalCents ?? 0,
              firstOrderAt: sum._min.createdAt,
              lastOrderAt: sum._max.createdAt
            }))
          )
          // The money is cents of ONE currency: a customer with orders in two has the figures in `totals_by_currency` and
          // the two plain columns empty, never a sum across currencies
          const single = figures.byCurrency.length === 1 ? figures.byCurrency[0] : undefined
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
            figures.orders === 0 ? 0 : (single?.totalSpentCents ?? null),
            single?.averageOrderCents ?? null,
            figures.firstOrderAt,
            figures.lastOrderAt,
            figures.byCurrency.map(line => `${line.currency} ${line.totalSpentCents}`).join(' | ')
          ]
        }
      }
    }
  }
}
