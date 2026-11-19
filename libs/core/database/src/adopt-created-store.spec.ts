import { PrismaService } from './prisma.service'
import type { TenantContext } from './tenant-context'

// adoptCreatedStore widens the context of the open transaction by the store it just created, and by nothing else: it needs the
// transaction, the organization in the context, and a store of that organization.
describe('PrismaService.adoptCreatedStore', () => {
  function serviceWith(owned: boolean): {
    service: PrismaService
    settings: string[]
    findFirst: jest.Mock
  } {
    const service = Object.create(PrismaService.prototype) as PrismaService
    const settings: string[] = []
    const findFirst = jest.fn(() => Promise.resolve(owned ? { id: 'new' } : null))
    const tx = {
      store: { findFirst },
      $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
        settings.push(String(values[0]))
        return Promise.resolve(1)
      }
    }
    ;(service as unknown as { open: unknown }).open = (fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx)
    return { service, settings, findFirst }
  }
  const context = (): TenantContext => ({ storeIds: ['store-1'], organizationIds: ['org-1'] })

  it('does nothing outside a tenant transaction: there is no context to widen', async () => {
    const { service, findFirst } = serviceWith(true)
    await expect(service.adoptCreatedStore('new')).resolves.toBeUndefined()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('adds the new store to the settings of the transaction, after proving it is of the organization', async () => {
    const { service, settings, findFirst } = serviceWith(true)
    await service.tenantTransaction(context(), async () => {
      await service.adoptCreatedStore('new')
      expect(service.currentTenantContext()?.storeIds).toEqual(['store-1', 'new'])
    })
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'new', organizationId: { in: ['org-1'] } },
      select: { id: true }
    })
    // First the context of the request, then the widened one
    expect(settings).toEqual(['store-1', 'store-1,new'])
  })

  it('refuses a store that is not one of the organization of the context, and changes nothing', async () => {
    const { service, settings } = serviceWith(false)
    await service.tenantTransaction(context(), async () => {
      await expect(service.adoptCreatedStore('other')).rejects.toThrow(
        /not one of the organization/
      )
      expect(service.currentTenantContext()?.storeIds).toEqual(['store-1'])
    })
    expect(settings).toEqual(['store-1'])
  })

  it('refuses a context with no organization', async () => {
    const { service } = serviceWith(true)
    await service.tenantTransaction({ storeIds: ['store-1'], organizationIds: [] }, async () => {
      await expect(service.adoptCreatedStore('new')).rejects.toThrow(/organization of the store/)
    })
  })
})
