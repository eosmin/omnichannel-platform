import {
  type JobContext,
  JobContextError,
  JobContextGoneError,
  type PrismaService
} from '@platform/core/database'

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

const STORES_PAGE_SIZE = 500

// The stores of a sweep that acts store by store (RLS phase 5): they are listed from `stores`, a table that row security never hides, and
// the rows of each store are read in the context of that store (JobContext.forStore), because the worker has no way past the
// policies. A store that is deleted between the list and its turn has nothing left to sweep and is skipped; any other failure of a
// store fails the sweep, which the caller handles as it does any database error.
export async function allStoreIds(prisma: PrismaService): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await prisma.client.store.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
      take: STORES_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
    })
    ids.push(...page.map(store => store.id))
    if (page.length < STORES_PAGE_SIZE) return ids
    cursor = page.at(-1)?.id
  }
}

// Reads from every store, one context at a time, and joins the answers.
// ONLY FOR ADDITIVE WORK (queueing, dispatching, polling, waking): a store whose read fails (a timeout, a full pool) is reported to
// `onFailure`, which must log at error level, and the sweep goes on with the others; what that store lacks is swept in the next run.
// NEVER for a sweep that decides by what it does not find or that deletes (orphan files, retention, purges): there a store that cannot
// be read must abort the whole sweep. When every store fails, or more than half, it throws instead of answering an empty list: a pool
// that is down must not look like "nothing to do".
export async function readInEachStore<T>(
  prisma: PrismaService,
  jobContext: JobContext,
  read: (storeId: string) => Promise<T[]>,
  onFailure: (storeId: string, error: unknown) => void
): Promise<T[]> {
  const rows: T[] = []
  const storeIds = await allStoreIds(prisma)
  let failed = 0
  for (const storeId of storeIds) {
    try {
      rows.push(...(await jobContext.forStore(storeId, () => read(storeId))))
    } catch (error) {
      if (error instanceof JobContextGoneError) continue
      failed += 1
      onFailure(storeId, error)
    }
  }
  if (failed > 0 && failed * 2 > storeIds.length) {
    throw new JobContextError(`the sweep could not read ${failed} of ${storeIds.length} stores`)
  }
  return rows
}

// The sweep that DELETES or decides by what it does not find (retention, purges, orphan files): every store, one context at a time, and ANY
// failure of a store aborts the whole sweep (a store that could not be read is not "a store with nothing to do"). Only a store that was
// deleted between the list and its turn is skipped: there is nothing of it left. `work` opens its own contexts (forStore) and keeps its tallies.
export async function inEachStoreStrict(
  prisma: PrismaService,
  work: (storeId: string) => Promise<void>
): Promise<void> {
  for (const storeId of await allStoreIds(prisma)) {
    try {
      await work(storeId)
    } catch (error) {
      if (error instanceof JobContextGoneError) continue
      throw error
    }
  }
}

// A store or an organization that is deleted between a list and its turn has nothing left to do: its answer is "none"
export async function unlessGone<T>(work: Promise<T | null>): Promise<T | null> {
  try {
    return await work
  } catch (error) {
    if (error instanceof JobContextGoneError) return null
    throw error
  }
}
