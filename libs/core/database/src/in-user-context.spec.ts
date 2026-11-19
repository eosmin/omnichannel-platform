import { PrismaService } from './prisma.service'
import type { TenantContext } from './tenant-context'

// inUserContext is the context of the work that belongs to a person and to no store (their avatar): the person alone, which is what
// the policy of those rows reads. It joins the context of the request only when that context is the same person's.
describe('PrismaService.inUserContext', () => {
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

  it('opens a context of the person alone, with no store, when none is open', async () => {
    const { service, tenantTransaction } = serviceWith(undefined)
    await expect(service.inUserContext('user-1', () => Promise.resolve('ok'))).resolves.toBe('ok')
    expect(tenantTransaction).toHaveBeenCalledWith(
      { storeIds: [], organizationIds: [], userId: 'user-1' },
      expect.any(Function)
    )
  })

  it('joins the context of the same person without opening another', async () => {
    const { service, tenantTransaction } = serviceWith({
      storeIds: [],
      organizationIds: [],
      userId: 'user-1'
    })
    await expect(service.inUserContext('user-1', () => Promise.resolve('ok'))).resolves.toBe('ok')
    expect(tenantTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['another person', { storeIds: [], organizationIds: [], userId: 'user-2' }],
    ['no person', { storeIds: [], organizationIds: [] }],
    ['the person and a store', { storeIds: ['store-1'], organizationIds: [], userId: 'user-1' }]
  ])('refuses, and runs nothing, when the open context is of %s', async (_name, current) => {
    const { service, tenantTransaction } = serviceWith(current)
    const work = jest.fn(() => Promise.resolve('never'))
    await expect(service.inUserContext('user-1', work)).rejects.toThrow(
      /another person, or of a store/
    )
    expect(work).not.toHaveBeenCalled()
    expect(tenantTransaction).not.toHaveBeenCalled()
  })

  it('refuses an empty person', async () => {
    const { service } = serviceWith(undefined)
    await expect(service.inUserContext(' ', () => Promise.resolve('x'))).rejects.toThrow(
      /needs the person/
    )
  })
})
