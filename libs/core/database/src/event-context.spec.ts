import { EventContext } from './event-context'
import type { JobContext } from './job-context'
import type { PrismaService } from './prisma.service'
import type { TenantContext } from './tenant-context'

// The listeners of a domain event run AFTER the transaction that announced it, so the context of the request is gone (Step 7.1, RLS
// phase 6, F6-3). EventContext gives them their own, from what the event carries, and does nothing while RLS_CONTEXT is off.

interface Calls {
  forStore: string[]
  forOrganization: string[]
  forUser: string[]
  detached: TenantContext[]
}

function build(options: {
  enabled: boolean
  current?: TenantContext
  stores?: Record<string, string>
}): { events: EventContext; calls: Calls } {
  const calls: Calls = { forStore: [], forOrganization: [], forUser: [], detached: [] }
  const jobs = {
    forStore: <T>(id: string, work: () => Promise<T>): Promise<T> => {
      calls.forStore.push(id)
      return work()
    },
    forOrganization: <T>(id: string, work: () => Promise<T>): Promise<T> => {
      calls.forOrganization.push(id)
      return work()
    },
    forUser: <T>(id: string, work: () => Promise<T>): Promise<T> => {
      calls.forUser.push(id)
      return work()
    }
  } as unknown as JobContext
  const stores = options.stores ?? { 'store-1': 'org-1' }
  const prisma = {
    hasTenantContext: (): boolean => options.current !== undefined,
    currentTenantContext: (): TenantContext | undefined => options.current,
    detachedTenantTransaction: <T>(context: TenantContext, work: () => Promise<T>): Promise<T> => {
      calls.detached.push(context)
      return work()
    },
    client: {
      store: {
        findUnique: ({ where }: { where: { id: string } }): Promise<unknown> => {
          const organizationId = stores[where.id]
          return Promise.resolve(organizationId === undefined ? null : { organizationId })
        },
        findMany: ({ where }: { where: { organizationId: string } }): Promise<unknown[]> =>
          Promise.resolve(
            Object.entries(stores)
              .filter(([, organizationId]) => organizationId === where.organizationId)
              .map(([id]) => ({ id }))
          )
      }
    }
  } as unknown as PrismaService
  return { events: new EventContext(prisma, jobs, options.enabled), calls }
}

describe('EventContext', () => {
  it('runs the work as it is while RLS_CONTEXT is off', async () => {
    const { events, calls } = build({ enabled: false })
    await expect(events.inStore('store-1', () => Promise.resolve('done'))).resolves.toBe('done')
    await expect(
      events.inOrganizationOfStore('store-1', () => Promise.resolve('done'))
    ).resolves.toBe('done')
    await expect(events.inUser('user-1', () => Promise.resolve('done'))).resolves.toBe('done')
    expect(calls).toEqual({ forStore: [], forOrganization: [], forUser: [], detached: [] })
  })

  it('opens the context of the store of the event when none is open', async () => {
    const { events, calls } = build({ enabled: true })
    await events.inStore('store-1', () => Promise.resolve('done'))
    expect(calls.forStore).toEqual(['store-1'])
    expect(calls.detached).toEqual([])
  })

  it('joins the context of a request that is already open for that store', async () => {
    const current = { storeIds: ['store-1'], organizationIds: ['org-1'] }
    const { events, calls } = build({ enabled: true, current })
    await expect(events.inStore('store-1', () => Promise.resolve('joined'))).resolves.toBe('joined')
    expect(calls).toEqual({ forStore: [], forOrganization: [], forUser: [], detached: [] })
  })

  it('opens a detached context when the open one is for another store', async () => {
    const current = { storeIds: ['store-2'], organizationIds: ['org-1'] }
    const { events, calls } = build({
      enabled: true,
      current,
      stores: { 'store-1': 'org-1', 'store-2': 'org-1' }
    })
    await events.inStore('store-1', () => Promise.resolve('other'))
    expect(calls.detached).toEqual([{ storeIds: ['store-1'], organizationIds: ['org-1'] }])
  })

  it('gives the organization of the store every store of it', async () => {
    const { events, calls } = build({
      enabled: true,
      stores: { 'store-1': 'org-1', 'store-2': 'org-1', 'store-3': 'org-2' }
    })
    await events.inOrganizationOfStore('store-1', () => Promise.resolve('books'))
    expect(calls.forOrganization).toEqual(['org-1'])
  })

  it('opens a detached context with every store of the organization inside a request of one store', async () => {
    const current = { storeIds: ['store-1'], organizationIds: ['org-1'] }
    const { events, calls } = build({
      enabled: true,
      current,
      stores: { 'store-1': 'org-1', 'store-2': 'org-1', 'store-3': 'org-2' }
    })
    await events.inOrganizationOfStore('store-1', () => Promise.resolve('books'))
    expect(calls.detached).toEqual([
      { storeIds: ['store-1', 'store-2'], organizationIds: ['org-1'] }
    ])
  })

  it('does not run the work when the store of the event is gone, and says so', async () => {
    const { events } = build({ enabled: true, stores: {} })
    const work = jest.fn()
    await expect(events.inOrganizationOfStore('store-9', work)).resolves.toBeUndefined()
    expect(work).not.toHaveBeenCalled()
  })

  it('opens the context of the person for a notification of several stores', async () => {
    const { events, calls } = build({ enabled: true })
    await events.inUser('user-1', () => Promise.resolve('sent'))
    expect(calls.forUser).toEqual(['user-1'])
  })
})
