import {
  JobContext,
  JobContextError,
  JobContextGoneError,
  TenantContextRequiredError
} from '@platform/core/database'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { ChannelConnectionStatus } from '@platform/core/domain'

import { allStoreIds, readInEachStore } from '../../apps/worker/src/schedulers/store-sweep'
import { createChannelConnection } from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { createGuardedWorkerPrisma } from '../helpers/worker-db'

// Row-Level Security, phase 5 (worker, schedulers): a sweep that goes store by store. The worker connects as platform_worker, which still
// skips row security until the last PR of the phase, so what proves that no access escaped its context is the guard of PrismaService
// (requireContext, the state the worker is in once it is on): a model operation on a table with a policy outside a context throws instead
// of answering no row. The stores are listed from `stores`, a table that row security never hides.
describe('row-level security, phase 5: the schedulers that go store by store', () => {
  const prefix = newRunPrefix()
  const owner: OwnerClient = ownerClient()
  const prisma = createGuardedWorkerPrisma()
  const jobContext = new JobContext(prisma)
  const stores: string[] = []
  const connections: string[] = []

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    for (const side of ['a', 'b']) {
      const store = await ensureStore(owner, org.id, `${prefix}-store-${side}`)
      stores.push(store.id)
      const connection = await createChannelConnection(owner, {
        storeId: store.id,
        channelType: 'sweep-probe',
        status: ChannelConnectionStatus.ACTIVE
      })
      connections.push(connection.id)
    }
  })

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.$disconnect()
  })

  const connectionsOf = (storeId: string) =>
    prisma.client.channelConnection.findMany({
      where: { storeId, id: { in: connections } },
      select: { id: true }
    })

  it('lists every store, whatever the context', async () => {
    expect(await allStoreIds(prisma)).toEqual(expect.arrayContaining(stores))
  })

  it('refuses a read of a table with a policy outside of a context, instead of answering no rows', async () => {
    await expect(connectionsOf(stores[0] ?? '')).rejects.toBeInstanceOf(TenantContextRequiredError)
  })

  it('reads each store in its own context, and the rows of a store are the ones of that store', async () => {
    const seen = new Map<string, string[]>()
    const rows = await readInEachStore(
      prisma,
      jobContext,
      async storeId => {
        const own = await connectionsOf(storeId)
        seen.set(
          storeId,
          own.map(row => row.id)
        )
        return own
      },
      () => undefined
    )
    expect(seen.get(stores[0] ?? '')).toEqual([connections[0]])
    expect(seen.get(stores[1] ?? '')).toEqual([connections[1]])
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining(connections))
  })

  it('skips a store that is deleted between the list and its turn, and reports one that fails without stopping the others', async () => {
    const forStore = jest
      .spyOn(jobContext, 'forStore')
      .mockRejectedValueOnce(new JobContextGoneError('gone'))
      .mockRejectedValueOnce(new Error('database down'))
    const failed: string[] = []
    const rows = await readInEachStore(
      prisma,
      jobContext,
      () => Promise.resolve([1]),
      storeId => failed.push(storeId)
    )
    // The first store was gone (skipped silently), the second failed (reported), every other store was still read
    expect(failed).toHaveLength(1)
    expect(rows).toEqual(expect.any(Array))
    // The first store was gone, the second failed, and the rest were still read
    expect(forStore.mock.calls.length).toBeGreaterThan(2)
    forStore.mockRestore()
  })

  it('throws instead of answering an empty list when every store fails', async () => {
    const forStore = jest.spyOn(jobContext, 'forStore').mockRejectedValue(new Error('pool down'))
    const failed: string[] = []
    await expect(
      readInEachStore(
        prisma,
        jobContext,
        () => Promise.resolve([1]),
        id => failed.push(id)
      )
    ).rejects.toBeInstanceOf(JobContextError)
    expect(failed.length).toBeGreaterThanOrEqual(2)
    forStore.mockRestore()
  })
})
