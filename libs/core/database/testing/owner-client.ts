import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../generated/client/client'

// A client that connects as the owner of the database (DIRECT_DATABASE_URL), the role that can do
// what platform_app cannot: write what a test needs before any user exists, and read rows no tenant
// context would let through (from Step 7.1). The seed and the suites use it; the api and the worker
// never do, and this entry point is not imported by either.
export type OwnerClient = PrismaClient

export function createOwnerClient(connectionString: string): OwnerClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}
