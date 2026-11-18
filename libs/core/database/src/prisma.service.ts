import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { readReplicas } from '@prisma/extension-read-replicas'

import { PrismaClient } from '../generated/client/client'

import type { TenantContext } from './tenant-context'

export interface PrismaServiceOptions {
  databaseUrl: string
  // Without a replica, replica() answers from the primary
  replicaUrl?: string | undefined
  poolSize?: number
}

function createClient({ databaseUrl, replicaUrl, poolSize = 20 }: PrismaServiceOptions) {
  const primary = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: poolSize })
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
  private readonly units = new WeakMap<object, UnitOfWork>()
  private readonly logger = new Logger(PrismaService.name)

  constructor(options: PrismaServiceOptions) {
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
  // refuses it, which is a debt of Step 7.1 (the plan): never call it in a path that writes (or that reads what it is about to write, or what
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
    return this.base.$replica().$transaction(
      async tx => {
        await applyTenantContext(tx, context)
        return fn(tx)
      },
      { ...TENANT_TRANSACTION, ...options }
    )
  }

  // Whether the code that is running is inside a tenant transaction (and so inside a context): a job or a helper that may be
  // called from both sides asks this before it opens its own, because tenantTransaction refuses to nest
  hasTenantContext(): boolean {
    return tenantScope.getStore() !== undefined
  }

  currentTenantContext(): TenantContext | undefined {
    return tenantScope.getStore()?.context
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
  // joins it without a savepoint, so there is no partial rollback to wait for. A hook that throws is
  // logged and the others still run: the data is committed. Outside any transaction (the base
  // client) there is nothing to wait for and the hook runs at once; a transaction this service did
  // not open is refused, because the hook could not be held until its commit.
  afterCommit(db: PrismaService['client'], hook: () => void): void {
    if (db === this.primary) {
      this.runHook(hook)
      return
    }
    const unit = this.units.get(db)
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
        this.units.set(tx, unit)
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
        return tenantScope.run({ tx, context }, fn)
      },
      { ...TENANT_TRANSACTION, ...options }
    )
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect()
  }
}
