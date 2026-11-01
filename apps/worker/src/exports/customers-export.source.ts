import type { PrismaService } from '@platform/core/database'
import { ExportLimits } from '@platform/core/exports'
import { customerSearchWhere, type CustomersExportFilters } from '@platform/core/messaging'

import type { CsvSource } from './csv-export-writer'

// MVP_TRIM_CHECKLIST.md §10 item 25. The notes stay out (their text is internal). The order columns
// are empty until Milestone 4 gives the customer orders to count.
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
  return {
    columns: CUSTOMER_COLUMNS,
    rows: async function* () {
      let after: string | undefined
      for (;;) {
        const customers = await prisma.client.customer.findMany({
          // Keyset: a row deleted meanwhile cannot end the file early, as a cursor on it would
          where: {
            ...customerSearchWhere(storeId, filters.q),
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

        for (const customer of customers) {
          const home = customer.addresses.find(address => address.isDefault)
          const span = spanOf.get(customer.id)
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
            null,
            null,
            null,
            null,
            null
          ]
        }
      }
    }
  }
}
