import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { readReplicas } from '@prisma/extension-read-replicas'

import { RlsGlobalModels, RlsPolicyTables } from '@platform/core/domain'

import { Prisma, PrismaClient } from '../generated/client/client'

import { policyTablesOfRawSql, sqlTextOfRawArgs } from './raw-sql-tables'
import { REPLICA_ROLE_FACTS_SQL, replicaRoleProblem, type ReplicaRoleFacts } from './replica-role'
import type { TenantContext } from './tenant-context'

export interface PrismaServiceOptions {
  databaseUrl: string
  // Without a replica, replica() answers from the primary
  replicaUrl?: string | undefined
  // The service refuses to start when the role of the replica could write on a server that is not a standby, or skips row level
  // security (replica-role.ts). Off for the suites that build their own replica database with the role of the api
  verifyReplicaRole?: boolean
  poolSize?: number
  // Row-Level Security (Step 7.1): a query on a model that is not global (RlsGlobalModels), made outside a tenant transaction, a
  // read of the replica or a withoutTenantContext call, throws TenantContextRequiredError instead of answering no rows. The api
  // turns it on with RLS_CONTEXT; the worker has its own contexts in a later phase and leaves it off.
  requireContext?: boolean
}

// The guard covers the model operations (findMany, create, ...) and the raw statements ($queryRaw, $executeRaw and their Unsafe forms):
// a raw statement that names a table with a policy (RlsPolicyTables) outside a context throws too, because the database would answer
// it with no row. The tables of a raw statement are read from its text (raw-sql-tables.ts), which is a net and not a parser. Inside
// replicaTenantRead and withoutTenantContext the guard is off for the whole callback, so use the handle you were given and nothing
// else of this service in there.
// What the guard throws: a query that the database would answer with no row (RLS fails closed) is a bug in the code that
// made it, and it is better to see it than to get an empty list or a write that matched nothing
export class TenantContextRequiredError extends Error {
  constructor(model: string, operation: string) {
    super(
      `${model}.${operation} was queried with no tenant context: run it inside tenantTransaction, replicaTenantRead or withoutTenantContext`
    )
    this.name = 'TenantContextRequiredError'
  }
}

// What a raw statement outside a context throws: the tables it names are the ones that would answer no row
export class RawSqlContextRequiredError extends Error {
  constructor(operation: string, tables: readonly string[]) {
    super(
      `${operation} on ${tables.join(', ')} was run with no tenant context: run it inside tenantTransaction, replicaTenantRead, a JobContext or withoutTenantContext`
    )
    this.name = 'RawSqlContextRequiredError'
  }
}

function createClient({
  databaseUrl,
  replicaUrl,
  poolSize = 20,
  requireContext = false
}: PrismaServiceOptions) {
  const unguarded = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: poolSize })
  })
  // The guard of the context: it runs before every operation of every model (the ones inside a transaction too, which inherit it)
  const refuseRaw = (operation: string, args: unknown): void => {
    if (!requireContext || hasQueryScope()) return
    const tables = policyTablesOfRawSql(sqlTextOfRawArgs(args), RlsPolicyTables)
    if (tables.length > 0) throw new RawSqlContextRequiredError(operation, tables)
  }
  const primary = unguarded.$extends({
    query: {
      $queryRaw({ args, query }) {
        refuseRaw('$queryRaw', args)
        return query(args)
      },
      $executeRaw({ args, query }) {
        refuseRaw('$executeRaw', args)
        return query(args)
      },
      $queryRawUnsafe({ args, query }) {
        refuseRaw('$queryRawUnsafe', args)
        return query(args)
      },
      $executeRawUnsafe({ args, query }) {
        refuseRaw('$executeRawUnsafe', args)
        return query(args)
      },
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (requireContext && !RlsGlobalModels.includes(model) && !hasQueryScope()) {
            throw new TenantContextRequiredError(model, operation)
          }
          return query(args)
        }
      }
    }
  })
  // With a driver adapter the extension takes client instances, not URLs
  const replica =
    replicaUrl === undefined
      ? primary
      : new PrismaClient({ adapter: new PrismaPg({ connectionString: replicaUrl, max: poolSize }) })
  return primary.$extends(readReplicas({ replicas: [replica] }))
}

type ExtendedClient = ReturnType<typeof createClient>
// What $primary() and $replica() answer with: the client of one database, with no routing of its own
type ReplicaClient = Omit<ExtendedClient, '$primary' | '$replica'>
type PrimaryClient = ReplicaClient
// What a read needs: raw SQL on the primary, a transaction or the replica. foldInDatabase and readMetricBuckets take this, so
// the caller picks the source and the helper stays the same.
export type SqlReader = Pick<ReplicaClient, '$queryRaw'>
export type PrismaTransaction = Parameters<Parameters<ExtendedClient['$transaction']>[0]>[0]
// What a read of the replica gets: the transaction of the replica client, which has no routing of its own
export type ReplicaTransaction = Parameters<Parameters<ReplicaClient['$transaction']>[0]>[0]

// The context is set in ONE statement (a round trip fewer through PgBouncer), with set_config(..., true): transaction-local, so
// it cannot reach the next client of a pooled connection. A session-level setting is refused by `pnpm validate:rls`.
async function applyTenantContext(
  tx: Pick<PrismaTransaction, '$executeRaw'>,
  context: TenantContext
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.store_ids', ${context.storeIds.join(',')}, true), set_config('app.organization_ids', ${context.organizationIds.join(',')}, true), set_config('app.user_id', ${context.userId ?? ''}, true)`
}

interface TransactionOptions {
  maxWait?: number
  timeout?: number
}

// What afterCommit holds for a real transaction: its hooks, and whether they are still waiting
interface UnitOfWork {
  state: 'open' | 'committed' | 'rolledBack'
  hooks: Array<() => void>
}

// The transaction that a unit of work runs in, once there is one. Prisma queries are lazy: they run
// when awaited, so every await must happen inside the scope of run().
const tenantScope = new AsyncLocalStorage<{ tx: PrismaTransaction; context: TenantContext }>()
// The other two ways to be inside a context: a read of the replica (it opens its own transaction with the context) and a call
// that says why it has none (withoutTenantContext)
const querySource = new AsyncLocalStorage<string>()

function hasQueryScope(): boolean {
  return tenantScope.getStore() !== undefined || querySource.getStore() !== undefined
}

// The unit of work of each transaction this module opened: afterCommit queues its hooks here, and inSavepoint drops the ones of an
// attempt it rolls back
const units = new WeakMap<object, UnitOfWork>()
let savepointCounter = 0

// Asks the database to run, now, the check of a constraint trigger that is DEFERRABLE INITIALLY DEFERRED (it would run at the COMMIT),
// and puts it back to deferred. Under RLS_CONTEXT the commit of a request is the interceptor's, outside the try/catch of the service
// that knows what the refusal means: with this call at the end of the attempt (inside inSavepoint) the refusal is raised where the
// service can map it. Deferred again right after, because the rows of what comes next are written one by one. The name is a
// constant of ours, never an input: only a plain identifier is accepted. It always leaves the constraint DEFERRED, whatever the mode was.
export async function settleDeferred(constraint: string, tx?: PrismaTransaction): Promise<void> {
  const target = tx ?? tenantScope.getStore()?.tx
  // With no transaction open there is nothing deferred to settle
  if (target === undefined) return
  // `all` is a plain word too, and it would fire every deferred check of the transaction
  if (constraint === 'all' || !/^[a-z_][a-z0-9_]*$/.test(constraint)) {
    throw new Error('settleDeferred needs the plain name of one constraint')
  }
  const name = Prisma.raw(constraint)
  await target.$executeRaw(Prisma.sql`SET CONSTRAINTS ${name} IMMEDIATE`)
  await target.$executeRaw(Prisma.sql`SET CONSTRAINTS ${name} DEFERRED`)
}

// Runs `attempt` (a write that may break a unique rule the caller means to catch) inside a SAVEPOINT of the transaction that is
// open: tenantScope's, or `tx` for code that opened its own. In Postgres a failed statement aborts the whole transaction (25P02)
// even when the code caught the error, and under RLS_CONTEXT a request is one transaction: the next query of the same request
// would fail. When `attempt` throws, the savepoint is rolled back (the transaction is usable again, what was written before stays)
// and the SAME error is rethrown for the caller to catch. With no transaction open there is nothing to protect and `attempt`
// runs as it is.
export async function inSavepoint<T>(
  attempt: () => Promise<T>,
  tx?: PrismaTransaction
): Promise<T> {
  const target = tx ?? tenantScope.getStore()?.tx
  if (target === undefined) return attempt()
  savepointCounter = (savepointCounter + 1) % 1_000_000_000
  // A name made of a counter: nothing from outside reaches the statement
  const name = Prisma.raw(`attempt_${savepointCounter}`)
  const unit = units.get(target)
  const hooksBefore = unit?.hooks.length ?? 0
  await target.$executeRaw(Prisma.sql`SAVEPOINT ${name}`)
  try {
    const result = await attempt()
    await target.$executeRaw(Prisma.sql`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    // If this fails too the connection is gone: the error that matters is the first one
    // What the attempt asked to announce after the commit did not happen: its hooks go
    if (unit !== undefined && unit.hooks.length > hooksBefore) unit.hooks.length = hooksBefore
    // Released too: a rolled-back savepoint stays open until the transaction ends, and a loop of caught violations would pile them up
    await target
      .$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT ${name}`)
      .then(() => target.$executeRaw(Prisma.sql`RELEASE SAVEPOINT ${name}`))
      .catch(() => undefined)
    throw error
  }
}

// A tenant transaction holds a connection for its whole duration, so its limits are set above
// Prisma's defaults on purpose and no external I/O (carriers, channels, S3, e-mail) runs inside it.
const TENANT_TRANSACTION: Required<TransactionOptions> = { maxWait: 5_000, timeout: 15_000 }

// Its constructor takes plain options, which Nest cannot resolve as a token: register it with a
// factory provider (useFactory), as the api and the worker modules do.
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly base: ExtendedClient
  // The extension sends every read of `base` to the replica when there is one (not only what asks for $replica()), so
  // nothing outside this class touches `base` for a query: `client` is this, which is the primary for reads and writes alike.
  // One object for the whole life of the service, because afterCommit tells the base client apart by identity.
  private readonly primary: PrimaryClient
  private readonly logger = new Logger(PrismaService.name)

  constructor(private readonly options: PrismaServiceOptions) {
    this.base = createClient(options)
    this.primary = this.base.$primary()
  }

  // What services use: the current tenant transaction when there is one, the primary otherwise.
  // Composition, not inheritance: $extends returns a new type.
  get client(): PrimaryClient | PrismaTransaction {
    return tenantScope.getStore()?.tx ?? this.primary
  }

  // Reads that tolerate replication lag, in ONE transaction of the replica that carries the tenant context (the same
  // settings as tenantTransaction): with Row-Level Security on, a read with no context sees no row, so there is no way to read the
  // replica without one. Without DATABASE_REPLICA_URL this is the primary. It sits outside the tenant transaction, so a read here
  // never sees a row the request wrote in it. A write through it is refused by a real standby; with no replica (development, CI) nothing
  // refuses it unless DATABASE_REPLICA_URL names platform_replica_ro, a role that can only SELECT (the plan, Step 7.1, F6-1 and F6-5): never call it in a path that writes (or that reads what it is about to write, or what
  // the person just changed), and never from a guard. The same rule is enforced by `pnpm validate:replica`
  // (scripts/check-replica-routing.ts), which lists the only files that may call it.
  replicaTenantRead<T>(
    context: TenantContext,
    fn: (db: ReplicaTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    // Inside the tenant transaction of a request this would hold a second connection of the same pool (with no replica, the same
    // database) while the first waits: a route that reads the replica is marked @NoTenantTransaction
    if (this.hasTenantContext()) {
      throw new Error(
        'replicaTenantRead inside a tenant transaction: mark the route @NoTenantTransaction, or read from this.client'
      )
    }
    return querySource.run(
      'replica',
      async () =>
        await this.base.$replica().$transaction(
          async tx => {
            await applyTenantContext(tx, context)
            return fn(tx)
          },
          { ...TENANT_TRANSACTION, ...options }
        )
    )
  }

  // For the few flows that have no tenant to name before they run (a lookup that finds the store of an external id, a guard that
  // writes the audit of a refusal): they say why, in the code, and the guard of the context lets them through. Everything inside
  // `fn` is exempt, so keep it to one lookup. With RLS enforced the database still answers what the role may see: this does not
  // open a row, it only silences the guard that would have thrown. Needs a reason, as @NoTenantTransaction does.
  withoutTenantContext<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    if (reason.trim() === '') throw new Error('withoutTenantContext needs a reason')
    // `fn` is awaited INSIDE the scope: a Prisma query is lazy, and one that is only started after run() returns would find no scope
    return querySource.run(reason, async () => await fn())
  }

  // Whether the code that is running is inside a tenant transaction (and so inside a context): a job or a helper that may be
  // called from both sides asks this before it opens its own, because tenantTransaction refuses to nest
  hasTenantContext(): boolean {
    return tenantScope.getStore() !== undefined
  }

  currentTenantContext(): TenantContext | undefined {
    return tenantScope.getStore()?.context
  }

  // For a read that needs the context of ONE store (the search functions of the database read the store from it): the context of the
  // request when the interceptor opened it, which must then be the context of THIS store alone (the functions answer for every store
  // of the context), or its own, for the store the TenantGuard put in the request, when the interceptor is off.
  async inStoreContext<T>(storeId: string, work: () => Promise<T>, userId?: string): Promise<T> {
    const current = this.currentTenantContext()
    if (current !== undefined) {
      if (current.storeIds.length !== 1 || current.storeIds[0] !== storeId) {
        throw new Error(
          'this read runs in the context of the store of the request, and of that store alone'
        )
      }
      return work()
    }
    return this.tenantTransaction({ storeIds: [storeId], organizationIds: [], userId }, work)
  }

  // For the work of ONE person that has no store to name (their avatar, which belongs to them and to no store): the context holds the
  // person alone, which is what the policy of the rows of a person reads (`app.user_id`). The context of the request when the interceptor
  // opened it, which must then be this person's, or its own. It sees no store row: keep it to the person's own rows.
  async inUserContext<T>(userId: string, work: () => Promise<T>): Promise<T> {
    if (userId.trim() === '') throw new Error('inUserContext needs the person')
    const current = this.currentTenantContext()
    if (current !== undefined) {
      // Only a context of the person alone: one with stores would let the work read beyond the person's own rows
      if (
        current.userId !== userId ||
        current.storeIds.length > 0 ||
        current.organizationIds.length > 0
      ) {
        throw new Error('this work runs in the context of another person, or of a store')
      }
      return work()
    }
    return this.tenantTransaction({ storeIds: [], organizationIds: [], userId }, work)
  }

  // Services never call client.$transaction: they call this, which joins the tenant transaction
  // when there is one (a lint rule forbids the direct call).
  transaction<T>(
    fn: (tx: PrismaTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const scope = tenantScope.getStore()
    return scope ? fn(scope.tx) : this.open(fn, options)
  }

  // Runs `hook` once the transaction `tx` has committed, and never if it rolls back: what a
  // transaction announces (a domain event) must not be announced before it is true. With the
  // transaction of a unit of work, the hook waits for the outermost commit; a nested transaction()
  // joins it, and only inSavepoint rolls part of it back (it drops the hooks queued inside that part). A hook that throws is
  // logged and the others still run: the data is committed. Outside any transaction (the base
  // client) there is nothing to wait for and the hook runs at once; a transaction this service did
  // not open is refused, because the hook could not be held until its commit.
  afterCommit(db: PrismaService['client'], hook: () => void): void {
    if (db === this.primary) {
      this.runHook(hook)
      return
    }
    const unit = units.get(db)
    if (unit === undefined) {
      throw new Error('afterCommit was given a transaction that PrismaService did not open')
    }
    if (unit.state === 'open') unit.hooks.push(hook)
    // Added after the commit (work that outlived its callback): the data is there already
    else if (unit.state === 'committed') this.runHook(hook)
    // After a rollback it is dropped: what it would announce did not happen
  }

  // One real transaction, whose commit hooks run after it commits
  private async open<T>(
    fn: (tx: PrismaTransaction) => Promise<T>,
    options: TransactionOptions | undefined
  ): Promise<T> {
    const unit: UnitOfWork = { state: 'open', hooks: [] }
    let result: T
    try {
      result = await this.base.$transaction(async (tx: PrismaTransaction) => {
        units.set(tx, unit)
        return fn(tx)
      }, options)
    } catch (error) {
      unit.state = 'rolledBack'
      unit.hooks.length = 0
      throw error
    }
    unit.state = 'committed'
    for (const hook of unit.hooks.splice(0)) this.runHook(hook)
    return result
  }

  private runHook(hook: () => void): void {
    try {
      hook()
    } catch (error) {
      this.logger.error(
        'a commit hook failed',
        error instanceof Error ? error.stack : String(error)
      )
    }
  }

  // One interactive transaction per unit of work, with the tenant settings as its first statements.
  // set_config(..., true) is transaction-local; a session-level setting would stay on a pooled
  // PgBouncer connection and leak into unrelated queries. Step 7.1 calls this from an interceptor.
  tenantTransaction<T>(
    context: TenantContext,
    fn: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    // A second transaction would not share the first one's atomicity or its tenant settings
    if (tenantScope.getStore() !== undefined) {
      throw new Error(
        'a tenant transaction is already open: nest transaction(), not tenantTransaction()'
      )
    }
    return this.open(
      async tx => {
        await applyTenantContext(tx, context)
        // `fn` is awaited INSIDE the scope: a Prisma query is lazy, and one that is only started after run() returns (a callback that
        // returns `client.model.findMany()` as it is) would run its hooks with no scope
        return tenantScope.run({ tx, context }, async () => await fn())
      },
      { ...TENANT_TRANSACTION, ...options }
    )
  }

  // A tenant transaction of its own, OUTSIDE the one the caller may be running in (which stays as it is). For a write that must not
  // depend on the unit of work that triggered it: the audit trail of a request is kept when the request rolls back, and it never
  // runs on a transaction that has already committed. `fn` must await its queries inside this scope, like any tenant transaction.
  detachedTenantTransaction<T>(
    context: TenantContext,
    fn: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    return tenantScope.exit(() => this.tenantTransaction(context, fn, options))
  }

  // The one transaction that may write the rows of the catalog that belong to the platform (a plugin with no organization): it
  // sets app.platform_catalog, which the policies of `plugins` ask for, and no tenant context. Only the boot of the api uses it, so
  // inside a request (a tenant transaction) it refuses to open: a handler cannot reach the flag by calling it.
  catalogTransaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
    if (this.hasTenantContext()) {
      throw new Error('catalogTransaction cannot be opened inside a tenant transaction')
    }
    return this.open(
      async tx => {
        await tx.$executeRaw`SELECT set_config('app.platform_catalog', 'on', true)`
        // `fn` is awaited INSIDE the scope: a Prisma query is lazy, and one that fn only returns would start after run() ends
        return tenantScope.run(
          { tx, context: { storeIds: [], organizationIds: [] } },
          async () => await fn()
        )
      },
      { ...TENANT_TRANSACTION, ...options }
    )
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect()
    if (this.options.replicaUrl !== undefined && this.options.verifyReplicaRole === true) {
      // Nest does not call onModuleDestroy when the start fails: the pools opened above are closed here
      try {
        const [facts] = await this.base
          .$replica()
          .$queryRawUnsafe<ReplicaRoleFacts[]>(REPLICA_ROLE_FACTS_SQL)
        const problem =
          facts === undefined
            ? 'the role of DATABASE_REPLICA_URL is not in pg_roles'
            : replicaRoleProblem(facts)
        if (problem !== null) throw new Error(problem)
      } catch (error) {
        await this.base.$disconnect()
        throw error
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect()
  }
}
