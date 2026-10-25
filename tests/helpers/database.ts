import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'

import {
  connectionUrls,
  createOwnerClient,
  type OwnerClient
} from '@platform/core/database-testing'

import { REDIS_URL } from '../../apps/api/src/testing/test-env'

// Everything a run creates carries this prefix, and cleanUp removes exactly that. Nothing here
// truncates a table or touches a row it did not create, so the suites are safe to run against any
// database (the one of development included) and beside other suites.
export function newRunPrefix(): string {
  return `it-iso-${randomUUID().slice(0, 8)}`
}

// The owner of the database, not platform_app: it sets data up before any user exists and looks at
// rows that, from Step 7.1, no tenant context lets the api see
export function ownerClient(): OwnerClient {
  return createOwnerClient(connectionUrls().owner)
}

// The api caches what it knows about a member and a store, and the generation counters that keep
// those entries honest live for days: a run removes the keys of the ids it created
async function forgetCached(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const redis = new Redis(REDIS_URL)
  try {
    for (const id of ids) {
      for await (const keys of redis.scanStream({ match: `cache:v1:*${id}*`, count: 200 })) {
        if ((keys as string[]).length > 0) await redis.del(...(keys as string[]))
      }
    }
  } finally {
    await redis.quit()
  }
}

export async function cleanUp(owner: OwnerClient, prefix: string): Promise<void> {
  const [users, stores] = await Promise.all([
    owner.user.findMany({ where: { email: { startsWith: prefix } }, select: { id: true } }),
    owner.store.findMany({
      where: { organization: { slug: { startsWith: prefix } } },
      select: { id: true }
    })
  ])
  await forgetCached([...users, ...stores].map(row => row.id))
  // The audit log keeps its rows for the users; the owner may clear them, the api never can
  await owner.auditLog.deleteMany({ where: { user: { email: { startsWith: prefix } } } })
  // Stores, memberships, roles and everything that hangs from an organization go with it (cascade)
  await owner.organization.deleteMany({ where: { slug: { startsWith: prefix } } })
  await owner.user.deleteMany({ where: { email: { startsWith: prefix } } })
}
