import { Inject, Injectable, Logger, Optional } from '@nestjs/common'

import { JobContext, JobContextGoneError } from './job-context'
import { PrismaService } from './prisma.service'
import { RLS_CONTEXT_ENABLED, type TenantContext } from './tenant-context'

// The tenant context of a LISTENER of a domain event (Step 7.1, RLS phase 6). An event is announced after the transaction that made it
// true has committed (PrismaService.afterCommit), so the listener runs outside that transaction and, with RLS_CONTEXT on, outside
// any context: its queries would read no row, in silence. Every event already carries the store (and the organization) it belongs to;
// the listener wraps its database work here, in a context of its own:
//  - Off (RLS_CONTEXT false): the work runs as it is, so nothing changes until the switch is turned on.
//  - A context is already open for that store (the listener was called inside the request): the work joins it.
//  - Otherwise: the context is opened from the id of the event, with the same rules as a job of the worker (JobContext).
// Keep the work to the database: the context holds a connection and a transaction (15 s), so a call to a carrier, a channel, the
// bucket, the mailer or a push service goes outside of it, before or after.
@Injectable()
export class EventContext {
  private readonly logger = new Logger(EventContext.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobContext,
    // Optional: a test app that does not import the platform module has no switch, and no switch is off
    @Optional() @Inject(RLS_CONTEXT_ENABLED) private readonly enabled?: boolean
  ) {}

  // The work of one store (a conversation, a message, an order, a shipment)
  async inStore<T>(storeId: string, work: () => Promise<T>): Promise<T> {
    if (this.enabled !== true) return work()
    const open = this.prisma.currentTenantContext()
    if (open !== undefined) {
      if (open.storeIds.includes(storeId)) return work()
      return this.prisma.detachedTenantTransaction(await this.contextOfStore(storeId), work)
    }
    return this.jobs.forStore(storeId, work)
  }

  // The work of the organization a store belongs to (the books and the fiscal documents), which also reads every store of it.
  // Resolves to undefined, with a warning, when the store of the event no longer exists: there is nothing left to do.
  async inOrganizationOfStore<T>(storeId: string, work: () => Promise<T>): Promise<T | undefined> {
    if (this.enabled !== true) return work()
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: { organizationId: true }
    })
    if (store === null) {
      this.logger.warn('the store of an event does not exist: its listener did nothing')
      return undefined
    }
    return this.inOrganization(store.organizationId, work)
  }

  // The same, when the event or the job names the organization itself (the books)
  async inOrganization<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    if (this.enabled !== true) return work()
    const open = this.prisma.currentTenantContext()
    if (open === undefined) return this.jobs.forOrganization(organizationId, work)
    const stores = await this.prisma.client.store.findMany({
      where: { organizationId },
      select: { id: true }
    })
    return this.prisma.detachedTenantTransaction(
      { storeIds: stores.map(row => row.id), organizationIds: [organizationId] },
      work
    )
  }

  // The work of one person across the stores they belong to (a notification that names the person and not a store)
  async inUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
    if (this.enabled !== true) return work()
    return this.jobs.forUser(userId, work)
  }

  private async contextOfStore(storeId: string): Promise<TenantContext> {
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: { organizationId: true }
    })
    if (store === null) throw new Error('the store of the event does not exist')
    return { storeIds: [storeId], organizationIds: [store.organizationId] }
  }
}

// What a listener is given by the framework: it reaches `events` through the instance, because a decorator has no injector
interface HasEvents {
  readonly events: EventContext
}

// The whole handler of a listener, in the context of the store its event carries. It goes BELOW @OnEvent (decorators apply bottom up,
// and @OnEvent must mark the function that is finally on the prototype). The class names an `events: EventContext` in its constructor.
// A payload with no `storeId` does not compile, so a listener of an event of an organization cannot take it by mistake. A store that
// was deleted after the event is not an error: there is nothing left to do.
export function InEventStore<P extends { storeId: string }>() {
  return (
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<(payload: P) => Promise<void>>
  ): void => {
    const original = descriptor.value
    if (original === undefined) return
    descriptor.value = async function (this: unknown, payload: P): Promise<void> {
      try {
        await (this as HasEvents).events.inStore(payload.storeId, () =>
          original.call(this, payload)
        )
      } catch (error) {
        if (error instanceof JobContextGoneError) return
        throw error
      }
    }
  }
}

// The same for an event that names only an organization (the books, the fiscal documents, a transfer between stores): the context of
// the organization, with every store of it
export function InEventOrganization<P extends { organizationId: string }>() {
  return (
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<(payload: P) => Promise<void>>
  ): void => {
    const original = descriptor.value
    if (original === undefined) return
    descriptor.value = async function (this: unknown, payload: P): Promise<void> {
      try {
        await (this as HasEvents).events.inOrganization(payload.organizationId, () =>
          original.call(this, payload)
        )
      } catch (error) {
        if (error instanceof JobContextGoneError) return
        throw error
      }
    }
  }
}
