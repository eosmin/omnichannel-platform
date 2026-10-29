import { parseEncryptionKey } from '@platform/core/crypto'
import { createOwnerClient, loadDevFixtures } from '@platform/core/database-testing'

import { credentialsEncryptionKey, databaseUrls } from './env'

// The people and stores the specs sign in as (admin@test.com, viewer@test.com, two stores...). Idempotent, so a laptop and a clean CI database end up the same.
export default async function globalSetup(): Promise<void> {
  const owner = createOwnerClient(databaseUrls.owner)
  try {
    await loadDevFixtures(owner, parseEncryptionKey(credentialsEncryptionKey))
  } finally {
    await owner.$disconnect()
  }
}
