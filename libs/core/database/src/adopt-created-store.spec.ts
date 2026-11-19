import { PrismaService } from './prisma.service'
import type { TenantContext } from './tenant-context'

// withCreatedStore widens the context of the open transaction by the store it just created, only while `work` runs, and only for a
// store of the organization of the context that this very transaction wrote.
describe('PrismaService.withCreatedStore', () => {
  function serviceWith(owned: boolean): { service: PrismaService; settings: string[] } {
    const service = Object.create(PrismaService.prototype) as PrismaService
    const settings: string[] = []
    const tx = {
      $queryRaw: () => Promise.resolve(owned ? [{ id: 'new' }] : []),
      $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
        settings.push(String(values[0]))
        return Promise.resolve(1)
      }
    }
    ;(service as unknown as { open: unknown }).open = (fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx)
    return { service, settings }
  }
  const context = (): TenantContext => ({ storeIds: ['store-1'], organizationIds: ['org-1'] })

  it('just runs the work outside a tenant transaction: there is no context to widen', async () => {
    const { service } = serviceWith(false)
    await expect(service.withCreatedStore('new', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('widens the context while the work runs and puts the request context back after', async () => {
    const { service, settings } = serviceWith(true)
    await service.tenantTransaction(context(), async () => {
      await service.withCreatedStore('new', () => {
        expect(service.currentTenantContext()?.storeIds).toEqual(['store-1', 'new'])
        return Promise.resolve()
      })
      expect(service.currentTenantContext()?.storeIds).toEqual(['store-1'])
    })
    expect(settings).toEqual(['store-1', 'store-1,new', 'store-1'])
  })

  it('puts the context back when the work throws, and rethrows its error', async () => {
    const { service } = serviceWith(true)
    await service.tenantTransaction(context(), async () => {
      await expect(
        service.withCreatedStore('new', () => Promise.reject(new Error('boom')))
      ).rejects.toThrow('boom')
      expect(service.currentTenantContext()?.storeIds).toEqual(['store-1'])
    })
  })

  it('refuses a store this transaction did not create in the organization, and runs nothing', async () => {
    const { service, settings } = serviceWith(false)
    const work = jest.fn(() => Promise.resolve())
    await service.tenantTransaction(context(), async () => {
      await expect(service.withCreatedStore('other', work)).rejects.toThrow(/was not created/)
    })
    expect(work).not.toHaveBeenCalled()
    expect(settings).toEqual(['store-1'])
  })

  it('refuses a context with no organization', async () => {
    const { service } = serviceWith(true)
    await service.tenantTransaction({ storeIds: ['store-1'], organizationIds: [] }, async () => {
      await expect(service.withCreatedStore('new', () => Promise.resolve())).rejects.toThrow(
        /organization of the store/
      )
    })
  })
})
