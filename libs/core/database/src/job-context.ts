import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable } from '@nestjs/common'

import { PrismaService } from './prisma.service'

// The two limits of an interactive transaction (the same names as PrismaService's own, which it does not export)
export interface TransactionOptions {
  maxWait?: number
  timeout?: number
}

// The tenant context of a unit of work that is not an HTTP request: a job of a queue, a step of a schedule (Step 7.1, RLS phase 0b).
// The api sets it from the TenantGuard; here the worker sets it from what the job names. Three rules:
//  - Fail closed. With row security on, a query with no context reads no row, and that must never be read as "already done". The
//    store, the organization and the person are looked up in tables that row security never hides (stores, organizations, users,
//    memberships), so "not there" is real: JobContextGoneError, which a processor treats as a job whose subject was deleted (done,
//    with a warning). Any other JobContextError (a store that does not match its row, a row hidden from its own context, a sweep
//    that cannot see every row) is a failure that the queue retries and that the handler's last-attempt cleanup still sees.
//  - The context is as short as the database work: it holds a connection and a transaction (maxWait 5 s, timeout 15 s), so the
//    call to a carrier, a channel, the storage, a scanner or the mailer goes outside of it, before or after.
//  - One context at a time. Inside one, a second call for the same store joins it; a call for another store is refused, because
//    a unit of work that touches two stores opens one context for each.
export class JobContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobContextError'
  }
}

// The store, organization or person of the job was deleted after the job was queued: nothing is left to do
export class JobContextGoneError extends JobContextError {
  constructor(message: string) {
    super(message)
    this.name = 'JobContextGoneError'
  }
}

export type AnchorKind = 'media' | 'export' | 'scheduled_report'

interface ActiveContext {
  storeIds: readonly string[]
  organizationIds: readonly string[]
  userId?: string
}

const active = new AsyncLocalStorage<ActiveContext>()

// The organization of a store never changes, and the busiest job (a raw analytics event) would otherwise look it up every time
const ORGANIZATION_OF_STORE_MAX = 10_000
const organizationOfStore = new Map<string, string>()

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(id => b.includes(id))
}

@Injectable()
export class JobContext {
  constructor(private readonly prisma: PrismaService) {}

  // The work of one store (the usual job: its payload carries a storeId)
  async forStore<T>(
    storeId: string,
    work: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const open = active.getStore()
    if (open !== undefined) {
      if (sameSet(open.storeIds, [storeId])) return work()
      throw new JobContextError('a context of another store is already open')
    }
    let organizationId = organizationOfStore.get(storeId)
    if (organizationId === undefined) {
      const store = await this.prisma.client.store.findUnique({
        where: { id: storeId },
        select: { organizationId: true }
      })
      if (store === null) throw new JobContextGoneError('the store of the job does not exist')
      organizationId = store.organizationId
      if (organizationOfStore.size >= ORGANIZATION_OF_STORE_MAX) organizationOfStore.clear()
      organizationOfStore.set(storeId, organizationId)
    }
    return this.open({ storeIds: [storeId], organizationIds: [organizationId] }, work, options)
  }

  // The work of one organization: the books and the fiscal documents (organization scope), which also read the rows of every store
  // of the organization (orders, returns, shipments, stock). Page long runs: one context per page.
  async forOrganization<T>(
    organizationId: string,
    work: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const open = active.getStore()
    if (open !== undefined) {
      if (open.organizationIds.length === 1 && open.organizationIds[0] === organizationId) {
        return work()
      }
      throw new JobContextError('a context of another organization is already open')
    }
    const organization = await this.prisma.client.organization.findUnique({
      where: { id: organizationId },
      select: { id: true }
    })
    if (organization === null)
      throw new JobContextGoneError('the organization of the job does not exist')
    const stores = await this.prisma.client.store.findMany({
      where: { organizationId },
      select: { id: true }
    })
    return this.open(
      { storeIds: stores.map(store => store.id), organizationIds: [organizationId] },
      work,
      options
    )
  }

  // The work of one person across the stores they belong to (notifications, digests, web push). A person with no membership
  // gets an empty context, which sees nothing: that is the answer, not an error.
  async forUser<T>(
    userId: string,
    work: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const open = active.getStore()
    if (open !== undefined) throw new JobContextError('a context is already open')
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true }
    })
    if (user === null) throw new JobContextGoneError('the user of the job does not exist')
    const memberships = await this.prisma.client.membership.findMany({
      where: { userId },
      select: { storeId: true, store: { select: { organizationId: true } } }
    })
    return this.open(
      {
        storeIds: [...new Set(memberships.map(row => row.storeId))],
        organizationIds: [...new Set(memberships.map(row => row.store.organizationId))],
        userId
      },
      work,
      options
    )
  }

  // The first thing a job that carries only the id of a row does (a file, an export, a report): learn the store of the row, with a
  // function of the database that sees every row, and prove that the row is visible from the context of that store. It proves the
  // row and not the rest of the job: the work that follows runs with no context until its service adopts one (see the baseline of
  // scripts/validate-rls-worker.ts). Answers
  // 'gone' when the row does not exist (the job then takes its usual way for a missing row), 'unowned' for a row with no store (the
  // avatar of a person) and 'visible' otherwise. A row that exists but cannot be read from its own context is an error: the job
  // would otherwise read "no row" and call it done. A `storeId` in the payload must be the one of the row.
  async anchor(
    kind: AnchorKind,
    id: string,
    payloadStoreId?: string
  ): Promise<'gone' | 'unowned' | 'visible'> {
    const found = await this.storeOfRow(kind, id)
    if (found === null) return 'gone'
    if (found.storeId === null) return 'unowned'
    if (payloadStoreId !== undefined && payloadStoreId !== found.storeId) {
      throw new JobContextError(`the store of the job is not the store of its ${kind}`)
    }
    const storeId = found.storeId
    const seen = await this.forStore(storeId, () => this.visible(kind, id))
    if (!seen) throw new JobContextError(`the ${kind} of the job is hidden from its own store`)
    return 'visible'
  }

  private async storeOfRow(
    kind: AnchorKind,
    id: string
  ): Promise<{ storeId: string | null } | null> {
    const rows = await (kind === 'media'
      ? this.prisma.client.$queryRaw<{ store_id: string | null }[]>`
          SELECT store_id FROM rls_store_of_media(${id})`
      : kind === 'export'
        ? this.prisma.client.$queryRaw<{ store_id: string | null }[]>`
            SELECT store_id FROM rls_store_of_export(${id})`
        : this.prisma.client.$queryRaw<{ store_id: string | null }[]>`
            SELECT store_id FROM rls_store_of_scheduled_report(${id})`)
    const [row] = rows
    return row === undefined ? null : { storeId: row.store_id }
  }

  private async visible(kind: AnchorKind, id: string): Promise<boolean> {
    const rows =
      kind === 'media'
        ? await this.prisma.client.$queryRaw<unknown[]>`SELECT 1 FROM media WHERE id = ${id}`
        : kind === 'export'
          ? await this.prisma.client.$queryRaw<unknown[]>`SELECT 1 FROM exports WHERE id = ${id}`
          : await this.prisma.client.$queryRaw<
              unknown[]
            >`SELECT 1 FROM scheduled_reports WHERE id = ${id}`
    return rows.length > 0
  }

  // True when the code runs inside a context of this class: for a service that is called by both a job and a request
  isOpen(): boolean {
    return active.getStore() !== undefined
  }

  private open<T>(
    context: ActiveContext,
    work: () => Promise<T>,
    options: TransactionOptions | undefined
  ): Promise<T> {
    return this.prisma.tenantTransaction(context, () => active.run(context, work), options)
  }
}

// For a sweep that deletes by what it does not find (a file with no row, an expired row, a month of the audit log): it must see
// every row of the tables it judges, or "no row" would mean "a row I may not see". It refuses to start when row security applies to
// its connection with no context for any of the tables (the worker role skips it until the last phase; platform_app never does).
export async function assertSeesEveryRow(
  prisma: PrismaService,
  tables: readonly string[]
): Promise<void> {
  if (active.getStore() !== undefined) {
    throw new JobContextError('a sweep over every row cannot run inside a tenant context')
  }
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new JobContextError('not a table name')
    const [row] = await prisma.client.$queryRaw<{ active: boolean }[]>`
      SELECT row_security_active(${table}::text::regclass) AS active`
    if (row?.active !== false) {
      throw new JobContextError(`row security hides the rows of ${table} from this sweep`)
    }
  }
}
