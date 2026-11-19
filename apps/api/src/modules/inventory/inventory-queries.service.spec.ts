import { ProductMatchKinds, ProductSearchConfig } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { InventoryQueriesService } from './inventory-queries.service'

// The text filter of the stock levels asks the database for the products and the variants that match (a function that keeps the trigram
// indexes in use under Row-Level Security). What this service owns is what it does with the answer: it hands the ids to the query
// of the levels, and it refuses a text that matches more than the list can carry, instead of truncating the list.
describe('InventoryQueriesService, the text filter of the stock levels', () => {
  const cap = ProductSearchConfig.MAX_FILTER_MATCHES
  const rowsOf = (kind: string, count: number): Array<{ kind: string; id: string }> =>
    Array.from({ length: count }, (_, i) => ({ kind, id: `${kind}-${i}` }))

  function serviceWith(matches: unknown[]): {
    service: InventoryQueriesService
    findMany: jest.Mock
  } {
    const findMany = jest.fn().mockResolvedValue([])
    const prisma = {
      inStoreContext: jest.fn(async (_storeId: string, work: () => Promise<unknown>) => work()),
      client: { $queryRaw: jest.fn().mockResolvedValue(matches), inventoryLevel: { findMany } }
    }
    return { service: new InventoryQueriesService(prisma as never), findMany }
  }

  const listing = (service: InventoryQueriesService) =>
    service.listLevels('store-1', { q: 'camisa', limit: 20, sort: 'name' } as never, false)

  it('hands the ids of the products and of the variants that match to the query of the levels', async () => {
    const { service, findMany } = serviceWith([
      ...rowsOf(ProductMatchKinds.PRODUCT, 2),
      ...rowsOf(ProductMatchKinds.VARIANT, 1)
    ])
    await listing(service)
    const where = (findMany.mock.calls[0] as [{ where: { AND: unknown[] } }])[0].where
    expect(where.AND).toContainEqual({
      OR: [{ productId: { in: ['product-0', 'product-1'] } }, { variantId: { in: ['variant-0'] } }]
    })
  })

  it('answers a text that matches nothing with an empty list, not with every level', async () => {
    const { service, findMany } = serviceWith([])
    await listing(service)
    const where = (findMany.mock.calls[0] as [{ where: { AND: unknown[] } }])[0].where
    expect(where.AND).toContainEqual({
      OR: [{ productId: { in: [] } }, { variantId: { in: [] } }]
    })
  })

  it.each([
    ['products', ProductMatchKinds.PRODUCT],
    ['variants', ProductMatchKinds.VARIANT]
  ])(
    'refuses with a 400 a text that matches more %s than the list can carry',
    async (_name, kind) => {
      const { service, findMany } = serviceWith(rowsOf(kind, cap + 1))
      const failure = await listing(service).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PlatformException)
      expect((failure as PlatformException).code).toBe(ErrorCodes.SEARCH_TOO_BROAD)
      expect((failure as PlatformException).statusCode).toBe(HttpStatusCodes.BAD_REQUEST)
      expect(findMany).not.toHaveBeenCalled()
    }
  )

  it('accepts a text that matches exactly the most the list can carry', async () => {
    const { service, findMany } = serviceWith(rowsOf(ProductMatchKinds.PRODUCT, cap))
    await listing(service)
    expect(findMany).toHaveBeenCalledTimes(1)
  })
})
