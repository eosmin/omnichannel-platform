import type { PrismaService } from '@platform/core/database'

import { reachableTransfer, visibleStoresOf } from './transfers.reach'

const person = { userId: 'user-1', storeId: 'store-a' }
const plugin = { userId: 'plugin:inst-1', storeId: 'store-a', pluginInstallationId: 'inst-1' }

describe('reachableTransfer', () => {
  it('lets a person reach what they made, what has no line yet and what has a line of their stores', () => {
    expect(reachableTransfer(person, ['store-a', 'store-b'])).toEqual({
      OR: [
        { createdBy: 'user-1' },
        { lines: { none: {} } },
        { lines: { some: { storeId: { in: ['store-a', 'store-b'] } } } }
      ]
    })
  })

  it('lets a plugin reach only a transfer with a line of its store: not one with no line, not one it "made"', () => {
    const where = reachableTransfer(plugin, ['store-a'])

    expect(where).toEqual({ OR: [{ lines: { some: { storeId: { in: ['store-a'] } } } }] })
    expect(JSON.stringify(where)).not.toContain('createdBy')
    expect(JSON.stringify(where)).not.toContain('none')
  })
})

describe('visibleStoresOf', () => {
  const findMany = jest.fn()
  const prisma = { client: { membership: { findMany } } } as unknown as PrismaService
  beforeEach(() => findMany.mockReset())

  it('gives a plugin the one store of its key without asking for memberships', async () => {
    await expect(visibleStoresOf(prisma, 'org-1', plugin)).resolves.toEqual(['store-a'])
    expect(findMany).not.toHaveBeenCalled()
  })

  it('gives a person the stores where they hold a transfer permission', async () => {
    findMany.mockResolvedValue([{ storeId: 'store-a' }, { storeId: 'store-c' }])

    await expect(visibleStoresOf(prisma, 'org-1', person)).resolves.toEqual(['store-a', 'store-c'])
    expect(findMany).toHaveBeenCalledTimes(1)
  })
})
