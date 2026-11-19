import type { PrismaService } from '@platform/core/database'
import { OrderSearchConfig } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import { orderTextCustomerIds } from './order-text-customers'

const STORE = 'store-1'

// A PrismaService that answers the function with `count` customers and records the limit it was asked for
function prismaAnswering(count: number): { prisma: PrismaService; queryRaw: jest.Mock } {
  const rows = Array.from({ length: count }, (_, i) => ({ id: `c${i}` }))
  const queryRaw = jest.fn().mockResolvedValue(rows)
  const prisma = {
    inStoreContext: (_store: string, work: () => Promise<unknown>) => work(),
    client: { $queryRaw: queryRaw }
  } as unknown as PrismaService
  return { prisma, queryRaw }
}

describe('orderTextCustomerIds', () => {
  const cap = OrderSearchConfig.MAX_CUSTOMER_MATCHES

  it('asks the database for nothing when the text is an order number or there is no text', async () => {
    const { prisma, queryRaw } = prismaAnswering(1)
    expect(await orderTextCustomerIds(prisma, STORE, undefined)).toEqual([])
    expect(await orderTextCustomerIds(prisma, STORE, '#12')).toEqual([])
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('answers the ids when the text names exactly as many customers as the list can carry', async () => {
    const { prisma } = prismaAnswering(cap)
    expect(await orderTextCustomerIds(prisma, STORE, 'ana')).toHaveLength(cap)
  })

  it('refuses with a 400 a text that names one customer more than the list can carry, never truncates', async () => {
    const { prisma } = prismaAnswering(cap + 1)
    const failure = await orderTextCustomerIds(prisma, STORE, 'ana').catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(PlatformException)
    expect((failure as PlatformException).code).toBe(ErrorCodes.SEARCH_TOO_BROAD)
    expect((failure as PlatformException).statusCode).toBe(400)
  })
})
