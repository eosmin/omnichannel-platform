import type { PrismaService, PrismaTransaction } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'

// The context a unit of work runs in once Row-Level Security is enforced: the stores and organizations it may see, and the person
// (for the rows that belong to a person and not to a store, like an avatar upload).
export interface TestTenantContext {
  storeIds: readonly string[]
  organizationIds: readonly string[]
  userId?: string
}

// For a piece of the api that runs outside a request (a listener of the events bridge, the socket gateway, a service a suite calls
// by hand) and must see the rows of a store: the same transaction the interceptor opens, through the same method, so the settings
// are the real ones and not a copy.
export function withTenantContext<T>(
  prisma: PrismaService,
  context: TestTenantContext,
  work: () => Promise<T>
): Promise<T> {
  return prisma.tenantTransaction(
    { storeIds: context.storeIds, organizationIds: context.organizationIds },
    work
  )
}

// withTenantContext around prisma.transaction, for the suite that calls a service of the api by hand with a transaction (`service.method(tx, ...)`):
// the transaction is the one of the context, and the service sees the rows of the store
export function transactionInContext<T>(
  prisma: PrismaService,
  context: TestTenantContext,
  work: (tx: PrismaTransaction) => Promise<T>
): Promise<T> {
  return withTenantContext(prisma, context, () => prisma.transaction(work))
}

// For a client that is not a PrismaService: the one a schema suite opens as platform_app to see what the role may do. It repeats
// the two transaction-local settings of PrismaService.tenantTransaction (never the session form, which a pooled connection would
// keep for the next client).
export function inTenantContext<T>(
  client: OwnerClient,
  context: TestTenantContext,
  work: (tx: PrismaTransaction) => Promise<T>
): Promise<T> {
  // A client that is not a PrismaService has no tenant transaction of its own: this is the one the suite opens by hand
  // eslint-disable-next-line no-restricted-syntax -- a raw client of a schema suite, not a service of the api
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.store_ids', ${context.storeIds.join(',')}, true)`
    await tx.$executeRaw`SELECT set_config('app.organization_ids', ${context.organizationIds.join(',')}, true)`
    if (context.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${context.userId}, true)`
    }
    return work(tx as unknown as PrismaTransaction)
  })
}
