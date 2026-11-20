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
  console.error(
    'If it is a read the validator cannot follow (an imported callback, a dynamic key, a transaction, SQL with the words insert/update/delete/merge/truncate/copy, an alias of inStoreContext), write it inline and literal in the same file, or add the file to STORE_CONTEXT_WRITES_ALLOWED (scripts/lib/static-guards.ts) with the reviewed reason in the PR.'
  )
  exit(1)
}
console.log(`store-context-writes: ${scanned} files scanned, no write inside inStoreContext`)
