import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { AuditService } from '@platform/core/audit-module'
import type { PrismaService } from '@platform/core/database'
import { DomainEvents, EventsBridge } from '@platform/core/event-bus'

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
