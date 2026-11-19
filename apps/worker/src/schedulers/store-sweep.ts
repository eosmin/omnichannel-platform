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
export async function readInEachStore<T>(
  prisma: PrismaService,
  jobContext: JobContext,
  read: (storeId: string) => Promise<T[]>
): Promise<T[]> {
  const rows: T[] = []
  for (const storeId of await allStoreIds(prisma)) {
    try {
      rows.push(...(await jobContext.forStore(storeId, () => read(storeId))))
    } catch (error) {
      if (!(error instanceof JobContextGoneError)) throw error
    }
  }
  return rows
}
