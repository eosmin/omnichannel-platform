import { PrismaPg } from '@prisma/adapter-pg'

import { parseEncryptionKey } from '@platform/core/crypto'

import { PrismaClient } from '../generated/client/client'
import { loadDevFixtures } from '../src/dev-fixtures'

import { fixturesEnvSchema, loadEnv } from './seed-env'

// NODE_ENV must be development or test, set explicitly: anything else fails the schema
const env = loadEnv(fixturesEnvSchema)

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DIRECT_DATABASE_URL })
})
try {
  await loadDevFixtures(prisma, parseEncryptionKey(env.CREDENTIALS_ENCRYPTION_KEY))
  console.log('development fixtures loaded')
} finally {
  await prisma.$disconnect()
}
