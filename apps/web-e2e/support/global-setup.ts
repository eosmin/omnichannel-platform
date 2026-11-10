import { join } from 'node:path'

import { parseEncryptionKey } from '@platform/core/crypto'
import { createOwnerClient, loadDevFixtures, loadE2ePeople } from '@platform/core/database-testing'

import { credentialsEncryptionKey, databaseUrls } from './env'
import { resetLinkBudget } from './link-budget'
import { peopleAskedIn } from './people'

// The people and stores the specs sign in as (admin@test.com, viewer@test.com, two stores...). Idempotent, so a laptop and a clean CI database end up the same.
export default async function globalSetup(): Promise<void> {
  resetLinkBudget()
  const owner = createOwnerClient(databaseUrls.owner)
  try {
    await loadDevFixtures(owner, parseEncryptionKey(credentialsEncryptionKey))
    // The people each spec file asks for with `personOf`, made for the suite alone (never by the fixtures)
    await loadE2ePeople(owner, peopleAskedIn(join(import.meta.dirname, '..', 'specs')))
    // A new store resolves at once (the default of the column), and the specs written before that expect the
    // dialog of the options when they press Resolve: their stores keep asking, as a store that chose it does.
    // The cases of the quick resolve set the way they need themselves (`setResolveBehavior`).
    await owner.storeSettings.updateMany({ data: { resolveShowOptions: true } })
  } finally {
    await owner.$disconnect()
  }
}
