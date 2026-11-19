import { PrismaService } from './prisma.service'
import type { TenantContext } from './tenant-context'

// inStoreContext is what keeps a search function of the database (which answers for EVERY store of the context) from answering for
// more than the store of the request: it joins the context of the request only when that context is that store alone.
describe('PrismaService.inStoreContext', () => {
  function serviceWith(current: TenantContext | undefined): {
    service: PrismaService
    tenantTransaction: jest.Mock
  } {
    const service = Object.create(PrismaService.prototype) as PrismaService
    const tenantTransaction = jest.fn(
      async (_context: TenantContext, work: () => Promise<unknown>) => work()
    )
    jest.spyOn(service, 'currentTenantContext').mockReturnValue(current)
    ;(service as unknown as { tenantTransaction: jest.Mock }).tenantTransaction = tenantTransaction
    return { service, tenantTransaction }
  }

  it('opens its own context of that store alone when the request has none', async () => {
    const { service, tenantTransaction } = serviceWith(undefined)
    await expect(
      service.inStoreContext('store-1', () => Promise.resolve('ok'), 'user-1')
    ).resolves.toBe('ok')
    expect(tenantTransaction).toHaveBeenCalledWith(
      { storeIds: ['store-1'], organizationIds: [], userId: 'user-1' },
      expect.any(Function)
    )
  })

  it('joins the context of the request when it is that store alone, without opening another', async () => {
    const { service, tenantTransaction } = serviceWith({
      storeIds: ['store-1'],
      organizationIds: ['org-1']
    })
    await expect(service.inStoreContext('store-1', () => Promise.resolve('ok'))).resolves.toBe('ok')
    expect(tenantTransaction).not.toHaveBeenCalled()
  })

  it('joins the context of the request when it is that store and the person who asks for it', async () => {
    const { service, tenantTransaction } = serviceWith({
      storeIds: ['store-1'],
      organizationIds: [],
      userId: 'user-1'
    })
    await expect(
      service.inStoreContext('store-1', () => Promise.resolve('ok'), 'user-1')
    ).resolves.toBe('ok')
    expect(tenantTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['another person', { storeIds: ['store-1'], organizationIds: [], userId: 'user-2' }],
    ['no person at all', { storeIds: ['store-1'], organizationIds: [] }]
  ])(
    'refuses, and runs nothing, when the person is asked for and the context of the request has %s',
    async (_name, current) => {
      const { service, tenantTransaction } = serviceWith(current)
      const work = jest.fn(() => Promise.resolve('never'))
      await expect(service.inStoreContext('store-1', work, 'user-1')).rejects.toThrow(
        /another person/
      )
      expect(work).not.toHaveBeenCalled()
      expect(tenantTransaction).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['another store', { storeIds: ['store-2'], organizationIds: [] }],
    ['several stores', { storeIds: ['store-1', 'store-2'], organizationIds: [] }],
    ['no store at all', { storeIds: [], organizationIds: ['org-1'] }]
  ])('refuses, and runs nothing, when the context of the request is %s', async (_name, current) => {
    const { service, tenantTransaction } = serviceWith(current)
    const work = jest.fn(() => Promise.resolve('never'))
    await expect(service.inStoreContext('store-1', work)).rejects.toThrow(/of that store alone/)
    expect(work).not.toHaveBeenCalled()
    expect(tenantTransaction).not.toHaveBeenCalled()
  })
})
