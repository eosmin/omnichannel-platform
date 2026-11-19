import type { TenantContext } from '@platform/core/database'

import { WidgetTenant, widgetContextOf } from './widget-tenant'

const SITE = { storeId: 'store-a', organizationId: 'org-a' }

function build(current: TenantContext | undefined) {
  const prisma = {
    currentTenantContext: jest.fn(() => current),
    tenantTransaction: jest.fn((_context: TenantContext, work: () => Promise<unknown>) => work())
  }
  return { prisma, tenant: new WidgetTenant(prisma as never) }
}

describe('WidgetTenant', () => {
  it('builds the context of the store of the site and its organization, and nothing else', () => {
    expect(widgetContextOf(SITE)).toEqual({ storeIds: ['store-a'], organizationIds: ['org-a'] })
  })

  it('opens a transaction in that context when none is open, and returns what the work returns', async () => {
    const { prisma, tenant } = build(undefined)
    await expect(tenant.run(SITE, () => Promise.resolve('answer'))).resolves.toBe('answer')
    expect(prisma.tenantTransaction).toHaveBeenCalledWith(
      { storeIds: ['store-a'], organizationIds: ['org-a'] },
      expect.any(Function)
    )
  })

  it('joins the context that is open for the same store, without a second transaction', async () => {
    const { prisma, tenant } = build({ storeIds: ['store-a'], organizationIds: ['org-a'] })
    await expect(tenant.run(SITE, () => Promise.resolve(1))).resolves.toBe(1)
    expect(prisma.tenantTransaction).not.toHaveBeenCalled()
  })

  it('refuses to run in a context of another store, or of several, and never runs the work', () => {
    const work = jest.fn(() => Promise.resolve(1))
    for (const open of [
      { storeIds: ['store-b'], organizationIds: ['org-a'] },
      { storeIds: ['store-a', 'store-b'], organizationIds: ['org-a'] },
      { storeIds: [], organizationIds: [] }
    ]) {
      const { tenant } = build(open)
      expect(() => tenant.run(SITE, work)).toThrow('of that store alone')
    }
    expect(work).not.toHaveBeenCalled()
  })
})
