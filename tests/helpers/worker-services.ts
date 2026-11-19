import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import {
  ChannelContextFactory,
  ChannelHealthService,
  ChannelTokenExpiryService
} from '@platform/channels/connections'
import { AuditService } from '@platform/core/audit-module'
import { JobContext, type PrismaService, WorkerLists } from '@platform/core/database'
import { DomainEvents, EventsBridge } from '@platform/core/event-bus'

import { createGuardedWorkerPrisma } from './worker-db'

// The two services a class of the worker gets with its database: the events (a hook after the commit only runs for a transaction
// that the same PrismaService opened, so a DomainEvents of the api cannot serve a transaction of the worker) and the audit trail.
// They publish to the bridge and the emitter of the app, so a suite still hears what the worker would announce.
export async function workerServices(
  app: INestApplication,
  prisma: PrismaService
): Promise<{ events: DomainEvents; audit: AuditService }> {
  // The logger of the container and the one the constructors name differ only in a generic: the same object
  const logger = (await app.resolve(PinoLogger)) as unknown as ConstructorParameters<
    typeof DomainEvents
  >[2]
  return {
    events: new DomainEvents(
      prisma,
      app.get(EventEmitter2),
      logger,
      app.get(EventsBridge, { strict: false })
    ),
    audit: new AuditService(prisma, logger)
  }
}

// The rounds of the scheduler are the worker's: they read the lists of the database, which only the worker role may call, and work in a
// context for each store. They are built on the guarded worker connection (requireContext ON), as the worker has them, from the pieces
// the app already holds.
export async function workerChannelHealth(app: INestApplication): Promise<ChannelHealthService> {
  const prisma = createGuardedWorkerPrisma()
  const { events } = await workerServices(app, prisma)
  return new ChannelHealthService(
    prisma,
    app.get(ChannelContextFactory, { strict: false }),
    events,
    await app.resolve(PinoLogger),
    new JobContext(prisma),
    new WorkerLists(prisma)
  )
}

export async function workerTokenExpiry(app: INestApplication): Promise<ChannelTokenExpiryService> {
  const prisma = createGuardedWorkerPrisma()
  const { events } = await workerServices(app, prisma)
  return new ChannelTokenExpiryService(
    prisma,
    app.get(ChannelContextFactory, { strict: false }),
    events,
    await app.resolve(PinoLogger),
    new JobContext(prisma),
    new WorkerLists(prisma)
  )
}
