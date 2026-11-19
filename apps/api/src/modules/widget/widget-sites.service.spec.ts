import { newSiteKey } from '@platform/channels/web-widget'

import { WidgetSites } from './widget-sites.service'

const SITE_KEY = newSiteKey()

function build(options: { resolves: boolean; status: string }) {
  const rows = options.resolves
    ? [{ id: 'cc-1', store_id: 'store-a', organization_id: 'org-a' }]
    : []
  const prisma = {
    client: {
      $queryRaw: jest.fn(() => Promise.resolve(rows)),
      channelConnection: {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: 'cc-1',
            storeId: 'store-a',
            status: options.status,
            metadata: {},
            store: { name: 'Shop', defaultLocale: 'es' }
          })
        )
      }
    },
    tenantTransaction: jest.fn((_context: unknown, work: () => Promise<unknown>) => work())
  }
  return { prisma, sites: new WidgetSites(prisma as never) }
}

describe('WidgetSites', () => {
  it('reads the connection inside the context the lookup returned, and gives the organization of the store', async () => {
    const { prisma, sites } = build({ resolves: true, status: 'active' })
    const site = await sites.find(SITE_KEY)
    expect(site).toMatchObject({
      storeId: 'store-a',
      organizationId: 'org-a',
      connectionId: 'cc-1'
    })
    expect(prisma.tenantTransaction).toHaveBeenCalledWith(
      { storeIds: ['store-a'], organizationIds: ['org-a'] },
      expect.any(Function)
    )
  })

  it('opens nothing for a value that is not a site key, and nothing for a key the database does not know', async () => {
    const { prisma, sites } = build({ resolves: false, status: 'active' })
    expect(await sites.find('nope')).toBeNull()
    expect(await sites.find(SITE_KEY)).toBeNull()
    expect(prisma.tenantTransaction).not.toHaveBeenCalled()
  })

  it('keeps only the ids of a resolved key for a moment: the row is read again on every call', async () => {
    const { prisma, sites } = build({ resolves: true, status: 'active' })
    await sites.find(SITE_KEY)
    await sites.find(SITE_KEY)
    expect(prisma.client.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prisma.client.channelConnection.findFirst).toHaveBeenCalledTimes(2)
  })

  it('forgets a key whose connection is no longer active, so the next call asks the database again', async () => {
    const { prisma, sites } = build({ resolves: true, status: 'disconnected' })
    expect(await sites.find(SITE_KEY)).toBeNull()
    expect(await sites.find(SITE_KEY)).toBeNull()
    expect(prisma.client.$queryRaw).toHaveBeenCalledTimes(2)
  })
})
