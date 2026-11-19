import {
  assertSeesEveryRow,
  JobContext,
  JobContextError,
  JobContextGoneError,
  forgetOrganizationsOfStores
} from './job-context'
import type { PrismaService } from './prisma.service'

const STORE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'

type Context = { storeIds: readonly string[]; organizationIds: readonly string[] }

interface Fakes {
  prisma: PrismaService
  contexts: Context[]
  queryRaw: jest.Mock
}

function fakePrisma(
  rows: {
    store?: { organizationId: string } | null
    stores?: Array<{ id: string }>
    organization?: { id: string } | null
    user?: { id: string } | null
    memberships?: Array<{ storeId: string; store: { organizationId: string } }>
  } = {}
): Fakes {
  const contexts: Context[] = []
  const queryRaw = jest.fn()
  const client = {
    store: {
      findUnique: jest.fn().mockResolvedValue(rows.store ?? null),
      findMany: jest.fn().mockResolvedValue(rows.stores ?? [])
    },
    organization: { findUnique: jest.fn().mockResolvedValue(rows.organization ?? null) },
    user: { findUnique: jest.fn().mockResolvedValue(rows.user ?? null) },
    membership: { findMany: jest.fn().mockResolvedValue(rows.memberships ?? []) },
    $queryRaw: queryRaw
  }
  const prisma = {
    client,
    hasTenantContext: () => false,
    tenantTransaction: jest.fn((context: Context, work: () => Promise<unknown>) => {
      contexts.push(context)
      return work()
    })
  } as unknown as PrismaService
  return { prisma, contexts, queryRaw }
}

describe('JobContext', () => {
  beforeEach(() => forgetOrganizationsOfStores())

  it('opens the context of the store and of its organization', async () => {
    const { prisma, contexts } = fakePrisma({ store: { organizationId: ORG } })
    const result = await new JobContext(prisma).forStore(STORE, () => Promise.resolve('done'))
    expect(result).toBe('done')
    expect(contexts).toEqual([{ storeIds: [STORE], organizationIds: [ORG] }])
  })

  it('says gone for a store that does not exist, and opens no context', async () => {
    const { prisma, contexts } = fakePrisma({ store: null })
    const work = jest.fn()
    // Another id than the other cases: the organization of a store is remembered for the life of the process
    await expect(
      new JobContext(prisma).forStore('99999999-9999-4999-8999-999999999999', work)
    ).rejects.toBeInstanceOf(JobContextGoneError)
    expect(work).not.toHaveBeenCalled()
    expect(contexts).toEqual([])
  })

  it('joins an open context of the same store and refuses another store', async () => {
    const { prisma, contexts } = fakePrisma({ store: { organizationId: ORG } })
    const jobs = new JobContext(prisma)
    await jobs.forStore(STORE, async () => {
      await jobs.forStore(STORE, () => Promise.resolve(undefined))
      await expect(jobs.forStore(OTHER, () => Promise.resolve(undefined))).rejects.toBeInstanceOf(
        JobContextError
      )
      expect(jobs.isOpen()).toBe(true)
    })
    expect(contexts).toHaveLength(1)
    expect(jobs.isOpen()).toBe(false)
  })

  it('does not join the context of a store when an organization is asked for', async () => {
    const { prisma } = fakePrisma({
      store: { organizationId: ORG },
      organization: { id: ORG },
      stores: [{ id: STORE }, { id: OTHER }]
    })
    const jobs = new JobContext(prisma)
    await jobs.forStore(STORE, async () => {
      await expect(jobs.forOrganization(ORG, () => Promise.resolve(1))).rejects.toBeInstanceOf(
        JobContextError
      )
    })
  })

  it('keeps no context after the work fails', async () => {
    const { prisma } = fakePrisma({ store: { organizationId: ORG } })
    const jobs = new JobContext(prisma)
    await expect(jobs.forStore(STORE, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    )
    expect(jobs.isOpen()).toBe(false)
  })

  it('runs as it is inside the transaction of a request, and opens the context of the store anywhere else', async () => {
    const inRequest = fakePrisma({ store: { organizationId: ORG } })
    const requestPrisma = inRequest.prisma as unknown as {
      hasTenantContext: () => boolean
      currentTenantContext: () => Context
    }
    requestPrisma.hasTenantContext = () => true
    requestPrisma.currentTenantContext = () => ({ storeIds: [STORE], organizationIds: [ORG] })
    await expect(
      new JobContext(inRequest.prisma).forStoreOrJoin(STORE, () => Promise.resolve('joined'))
    ).resolves.toBe('joined')
    // The request's own context counts: nothing of ours is opened
    expect(inRequest.contexts).toEqual([])
    // A request of another store must not run this store's work under its own context
    await expect(
      new JobContext(inRequest.prisma).forStoreOrJoin(OTHER, () => Promise.resolve('wrong'))
    ).rejects.toBeInstanceOf(JobContextError)

    const inJob = fakePrisma({ store: { organizationId: ORG } })
    await expect(
      new JobContext(inJob.prisma).forStoreOrJoin(STORE, () => Promise.resolve('opened'))
    ).resolves.toBe('opened')
    expect(inJob.contexts).toEqual([{ storeIds: [STORE], organizationIds: [ORG] }])
  })

  it('opens an organization with every store of it, and fails closed for one that is not there', async () => {
    const found = fakePrisma({ organization: { id: ORG }, stores: [{ id: STORE }, { id: OTHER }] })
    await new JobContext(found.prisma).forOrganization(ORG, () => Promise.resolve(undefined))
    expect(found.contexts).toEqual([{ storeIds: [STORE, OTHER], organizationIds: [ORG] }])

    const missing = fakePrisma({ organization: null })
    await expect(
      new JobContext(missing.prisma).forOrganization(ORG, () => Promise.resolve(undefined))
    ).rejects.toBeInstanceOf(JobContextError)
  })

  it('inOrganization opens the context of a job, joins one of the same organization and never nests inside a request', async () => {
    const job = fakePrisma({ organization: { id: ORG }, stores: [{ id: STORE }] })
    const jobs = new JobContext(job.prisma)
    await jobs.inOrganization(ORG, async () => {
      await jobs.inOrganization(ORG, () => Promise.resolve(undefined))
      await expect(
        jobs.inOrganization(OTHER, () => Promise.resolve(undefined))
      ).rejects.toBeInstanceOf(JobContextError)
    })
    expect(job.contexts).toHaveLength(1)
  })

  it('inOrganization joins a request context only when it is as wide as the organization, and refuses a narrower one', async () => {
    const stores = [{ id: STORE }, { id: OTHER }]
    const inRequest = (context: Context): Fakes => {
      const fakes = fakePrisma({ organization: { id: ORG }, stores })
      Object.assign(fakes.prisma, {
        hasTenantContext: () => true,
        currentTenantContext: () => context
      })
      return fakes
    }
    const foreign = inRequest({ storeIds: [STORE, OTHER], organizationIds: [OTHER] })
    const wide = inRequest({ storeIds: [STORE, OTHER], organizationIds: [ORG] })
    const work = jest.fn().mockResolvedValue('joined')
    await expect(new JobContext(wide.prisma).inOrganization(ORG, work)).resolves.toBe('joined')
    expect(wide.contexts).toHaveLength(0)

    // The active store only: the books would see the organization tables and none of the rows of the sibling store
    const narrow = inRequest({ storeIds: [STORE], organizationIds: [ORG] })
    const refused = jest.fn()
    await expect(new JobContext(narrow.prisma).inOrganization(ORG, refused)).rejects.toBeInstanceOf(
      JobContextError
    )
    expect(refused).not.toHaveBeenCalled()

    // The transitional method of the shared services joins the narrow request context as they did before (debt F6-3), and opens in a job
    const lenient = jest.fn().mockResolvedValue('as-before')
    await expect(new JobContext(narrow.prisma).inOrganizationOrRequest(ORG, lenient)).resolves.toBe(
      'as-before'
    )
    expect(narrow.contexts).toHaveLength(0)
    // ... but never the context of another organization: that would read the books as missing
    await expect(
      new JobContext(foreign.prisma).inOrganizationOrRequest(ORG, refused)
    ).rejects.toBeInstanceOf(JobContextError)
    const job = fakePrisma({ organization: { id: ORG }, stores })
    await new JobContext(job.prisma).inOrganizationOrRequest(ORG, () => Promise.resolve(1))
    expect(job.contexts).toEqual([{ storeIds: [STORE, OTHER], organizationIds: [ORG] }])

    await expect(
      new JobContext(foreign.prisma).inOrganization(ORG, refused)
    ).rejects.toBeInstanceOf(JobContextError)
  })

  it('opens a person with the stores they belong to, and fails closed for one that is not there', async () => {
    const found = fakePrisma({
      user: { id: 'u' },
      memberships: [
        { storeId: STORE, store: { organizationId: ORG } },
        { storeId: OTHER, store: { organizationId: ORG } }
      ]
    })
    await new JobContext(found.prisma).forUser('u', () => Promise.resolve(undefined))
    expect(found.prisma.client.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u', status: 'ACTIVE', revokedAt: null } })
    )
    expect(found.contexts).toEqual([
      { storeIds: [STORE, OTHER], organizationIds: [ORG], userId: 'u' }
    ])

    const missing = fakePrisma({ user: null })
    await expect(
      new JobContext(missing.prisma).forUser('u', () => Promise.resolve(undefined))
    ).rejects.toBeInstanceOf(JobContextError)
  })
})

describe('assertSeesEveryRow', () => {
  it('passes when row security does not apply and refuses when it does', async () => {
    const open = fakePrisma()
    open.queryRaw.mockResolvedValue([{ active: false }])
    await expect(assertSeesEveryRow(open.prisma, ['media', 'users'])).resolves.toBeUndefined()

    const hidden = fakePrisma()
    hidden.queryRaw.mockResolvedValue([{ active: true }])
    await expect(assertSeesEveryRow(hidden.prisma, ['media'])).rejects.toBeInstanceOf(
      JobContextError
    )
  })

  it('refuses an answer that is not a plain false, and a name that is not a table', async () => {
    const odd = fakePrisma()
    odd.queryRaw.mockResolvedValue([])
    await expect(assertSeesEveryRow(odd.prisma, ['media'])).rejects.toBeInstanceOf(JobContextError)
    await expect(assertSeesEveryRow(odd.prisma, ['media; DROP'])).rejects.toBeInstanceOf(
      JobContextError
    )
  })

  it('refuses to run inside a tenant context', async () => {
    const { prisma, queryRaw } = fakePrisma({ store: { organizationId: ORG } })
    queryRaw.mockResolvedValue([{ active: false }])
    await new JobContext(prisma).forStore(STORE, async () => {
      await expect(assertSeesEveryRow(prisma, ['media'])).rejects.toBeInstanceOf(JobContextError)
    })
  })
})
