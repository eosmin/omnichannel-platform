import { type JobContext, JobContextGoneError, type PrismaService } from '@platform/core/database'

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

// Reads from every store, one context at a time, and joins the answers
// A store whose read fails (a timeout, a pool that is full) is reported to `onFailure` and the sweep goes on with the others: one
// tenant must not stop the work of every store after it in the order of the list. The store that failed is swept in the next run.
export async function readInEachStore<T>(
  prisma: PrismaService,
  jobContext: JobContext,
  read: (storeId: string) => Promise<T[]>,
  onFailure: (storeId: string, error: unknown) => void
): Promise<T[]> {
  const rows: T[] = []
  for (const storeId of await allStoreIds(prisma)) {
    try {
      rows.push(...(await jobContext.forStore(storeId, () => read(storeId))))
    } catch (error) {
      if (error instanceof JobContextGoneError) continue
      onFailure(storeId, error)
    }
  }
  return rows
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
