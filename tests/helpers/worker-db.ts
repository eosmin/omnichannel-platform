import type { TestingModuleBuilder } from '@nestjs/testing'

import { PrismaService } from '@platform/core/database'
import {
  connectionUrls,
  createOwnerClient,
  type OwnerClient
} from '@platform/core/database-testing'

// What the worker runs on. In production the worker connects as platform_worker, which skips Row-Level Security (BYPASSRLS), and
// the api connects as platform_app, which does not. A suite that builds a class of the worker (a processor, a sweep, a status
// writer) by hand must give it the connection the worker has: given the api's, it would see no row once the policies are enforced,
// and the suite would be testing a state that does not exist.
//
// createWorkerPrisma is for the piece of a suite that stands in for the worker. The app under test keeps platform_app, so that
// what the suite asks of the api over HTTP is still checked by the database. It is closed when the file ends (worker-db-teardown.ts).
//
// One per pool size in a file: a helper that a suite calls in every case does not open a pool each time.
export function createWorkerPrisma(poolSize = 4): PrismaService {
  const known = shared.get(poolSize)
  if (known !== undefined) return known
  const prisma = new PrismaService({ databaseUrl: connectionUrls().worker, poolSize })
  shared.set(poolSize, prisma)
  return prisma
}

// The worker as it is once it has lost BYPASSRLS: the guard of PrismaService throws on a model operation or a raw statement on a table with a
// policy outside a context (a JobContext, tenantTransaction or withoutTenantContext), instead of answering no row. A suite of a scheduler
// or a service that has adopted a context builds the class with this one, so that an access that escaped its context fails the suite.
export function createGuardedWorkerPrisma(poolSize = 4): PrismaService {
  guarded ??= new Map()
  const known = guarded.get(poolSize)
  if (known !== undefined) return known
  const prisma = new PrismaService({
    databaseUrl: connectionUrls().worker,
    poolSize,
    requireContext: true
  })
  guarded.set(poolSize, prisma)
  return prisma
}
let guarded: Map<number, PrismaService> | undefined

// A plain client on the connection of the worker, for what must NOT see the tenant context of the request that is running: the
// transaction of a request is kept in a store that every PrismaService shares, so `.client` of a second service would join it.
// One per file, closed with the others.
let workerClient: OwnerClient | undefined
export function createWorkerClient(): OwnerClient {
  workerClient ??= createOwnerClient(connectionUrls().worker)
  return workerClient
}

// Every one the suite made, closed by the file the jest config lists in setupFilesAfterEnv (worker-db-teardown.ts): a suite does not
// have to remember to
const shared = new Map<number, PrismaService>()

export async function closeWorkerPrisma(): Promise<void> {
  const all = [...shared.values(), ...(guarded?.values() ?? [])]
  shared.clear()
  guarded = undefined
  const client = workerClient
  workerClient = undefined
  await Promise.all([
    ...all.map(prisma => prisma.onModuleDestroy()),
    ...(client === undefined ? [] : [client.$disconnect()])
  ])
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
