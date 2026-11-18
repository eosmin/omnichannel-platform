import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../generated/client/client'

import { poolerUrl } from './connection-urls'

// A client that connects as the owner of the database (DIRECT_DATABASE_URL), the role that can do
// what platform_app cannot: write what a test needs before any user exists, and read rows no tenant
// context would let through (from Step 7.1). The seed and the suites use it; the api and the worker
// never do, and this entry point is not imported by either.
export type OwnerClient = PrismaClient

export function createOwnerClient(connectionString: string): OwnerClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

const ID = /^[\w-]+$/

// What a connection of a suite may see once Row-Level Security is enforced (see tests/helpers/tenant-context.ts for a unit of work).
export interface AppClientContext {
  storeIds?: readonly string[]
  organizationIds?: readonly string[]
  userId?: string
}

// A client that connects as platform_app (DATABASE_URL, connectionUrls().app): the role of the api, subject to Row-Level Security.
// A schema suite opens it to see what that role may and may not do; the name says so, because createOwnerClient on that URL reads
// as if the suite wrote as the owner.
//
// With `context` the connection carries it for its whole life, as startup settings (`options=-c app.store_ids=...`), so every
// statement of the client runs in that context: what a suite that opens a client of its own needs, since it has no request to open
// the transaction. The settings are read by the policies like the transaction-local ones of PrismaService.tenantTransaction. It is
// for a direct connection: PgBouncer refuses startup options, so a context with TEST_POOLER_URL is an error and not a silent
// empty context.
export function createAppClient(connectionString: string, context?: AppClientContext): OwnerClient {
  if (context === undefined) return createOwnerClient(connectionString)
  const url = new URL(connectionString)
  const pooler = poolerUrl()
  if (pooler !== undefined && url.hostname === pooler.hostname && url.port === pooler.port) {
    throw new Error('createAppClient with a context needs a direct connection, not the pooler')
  }
  // The ids go into a startup option: a space or a comma would add a setting or split an id
  const checked = (values: readonly string[]): string => {
    for (const value of values) {
      if (!ID.test(value)) throw new Error(`createAppClient: "${value}" is not an id`)
    }
    return values.join(',')
  }
  if (url.searchParams.has('options')) {
    throw new Error('createAppClient with a context takes no options of its own')
  }
  const settings: string[] = []
  if (context.storeIds !== undefined) settings.push(`app.store_ids=${checked(context.storeIds)}`)
  if (context.organizationIds !== undefined) {
    settings.push(`app.organization_ids=${checked(context.organizationIds)}`)
  }
  if (context.userId !== undefined) settings.push(`app.user_id=${checked([context.userId])}`)
  url.searchParams.set('options', settings.map(setting => `-c ${setting}`).join(' '))
  return createOwnerClient(url.toString())
}
