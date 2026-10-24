import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../generated/client/client'
import { bootstrapOwner } from '../src/bootstrap-owner'

import { bootstrapEnvSchema, loadEnv } from './seed-env'

// The owner bootstrap (closed signup): production-safe and idempotent. It creates the system roles,
// the owner, the organization, the first store with its settings and the owner's membership.
// Development data lives in dev-fixtures.ts and never runs in production.
const env = loadEnv(bootstrapEnvSchema)
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DIRECT_DATABASE_URL })
})

try {
  const result = await bootstrapOwner(prisma, {
    ownerEmail: env.SEED_OWNER_EMAIL,
    ownerName: env.SEED_OWNER_NAME ?? env.SEED_OWNER_EMAIL,
    organizationName: env.SEED_ORGANIZATION_NAME,
    storeName: env.SEED_STORE_NAME
  })
  console.log(`bootstrap done: organization ${result.organizationId}, store ${result.storeId}`)
} finally {
  await prisma.$disconnect()
}
