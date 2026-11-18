import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { TestingModuleBuilder } from '@nestjs/testing'
import { PinoLogger } from 'nestjs-pino'

import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { DomainEvents, EventsBridge } from '@platform/core/event-bus'

// What the worker runs on. In production the worker connects as platform_worker, which skips Row-Level Security (BYPASSRLS), and
// the api connects as platform_app, which does not. A suite that builds a class of the worker (a processor, a sweep, a status
// writer) by hand must give it the connection the worker has: given the api's, it would see no row once the policies are enforced,
// and the suite would be testing a state that does not exist.
//
// createWorkerPrisma is for the piece of a suite that stands in for the worker. The app under test keeps platform_app, so that
// what the suite asks of the api over HTTP is still checked by the database. It is closed when the file ends (worker-db-teardown.ts).
export function createWorkerPrisma(poolSize = 4): PrismaService {
  const prisma = new PrismaService({ databaseUrl: connectionUrls().worker, poolSize })
  opened.add(prisma)
  return prisma
}

// Every one the suite made, closed by the file the jest config lists in setupFilesAfterEnv (worker-db-teardown.ts): a suite does not
// have to remember to
const opened = new Set<PrismaService>()

export async function closeWorkerPrisma(): Promise<void> {
  const all = [...opened]
  opened.clear()
  await Promise.all(all.map(prisma => prisma.onModuleDestroy()))
}

// For a suite whose whole subject is the worker side: the whole app runs on the connection of the worker, so that every class the
// suite takes from the container (app.get) has it, and the helpers that need it from outside (`app.get(PrismaService)`) get it
// too. Nest connects and closes it with the app. Use it as the `override` argument of createTestApp, or compose it with one:
//   createTestApp([], onWorkerDatabase(builder => builder.overrideProvider(...)))
export function onWorkerDatabase(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = builder => builder
): (builder: TestingModuleBuilder) => TestingModuleBuilder {
  return builder =>
    override(builder).overrideProvider(PrismaService).useValue(createWorkerPrisma(8))
}

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
