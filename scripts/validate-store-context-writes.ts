// Fails when a callback of PrismaService.inStoreContext writes (inStoreContext opens {storeIds: [x], organizationIds: []}, a read-only
// organ: a write that fires a trigger reading an organization table fails with the empty organization context).
// Usage: tsx scripts/validate-store-context-writes.ts
import { exit } from 'node:process'

import { checkStoreContextWrites } from './lib/static-guards'

const { scanned, failures } = checkStoreContextWrites(process.cwd())
if (failures.length > 0) {
  console.error('Writes inside inStoreContext (a read-only context):')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    'Write in inStore / inOrganization / inOrganizationOfStore, or read with inStoreContext.'
  )
  exit(1)
}
console.log(`store-context-writes: ${scanned} files scanned, no write inside inStoreContext`)
