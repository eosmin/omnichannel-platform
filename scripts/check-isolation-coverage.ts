// Every model with a store_id must have a case in the tenant isolation suite (TDD_13 §6).
// Usage: tsx scripts/check-isolation-coverage.ts
import { existsSync, readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { ISOLATION_EXEMPTIONS } from './isolation-exemptions'
import { checkIsolationCoverage, storeScopedModels, suiteResources } from './lib/isolation'

const SCHEMA = 'libs/core/database/prisma/schema.prisma'
const SUITE = 'tests/security/tenant-isolation.spec.ts'

const models = storeScopedModels(readFileSync(SCHEMA, 'utf8'))
// No model at all means that the schema was not read as expected, not that nothing needs a case
if (models.length === 0) {
  console.error(`no model with a store_id found in ${SCHEMA}: the schema convention changed?`)
  exit(1)
}
const unjustified = Object.entries(ISOLATION_EXEMPTIONS)
  .filter(([, reason]) => reason.trim() === '')
  .map(([model]) => model)
if (unjustified.length > 0) {
  console.error(
    `Exemptions with no reason (scripts/isolation-exemptions.ts):\n  ${unjustified.join('\n  ')}`
  )
  exit(1)
}

// The suite is built in Step 1.3. Until then this lists what it will have to cover.
if (!existsSync(SUITE)) {
  console.log(
    `${SUITE} does not exist yet (Step 1.3). The suite must cover ${models.length} models:\n  ${models.join('\n  ')}`
  )
  exit(0)
}

const { uncovered, stale } = checkIsolationCoverage(
  models,
  suiteResources(readFileSync(SUITE, 'utf8')),
  ISOLATION_EXEMPTIONS
)

if (uncovered.length > 0) {
  console.error(
    `Models with a store_id and no case in ${SUITE} (add one, or exempt the model with a reason):\n  ${uncovered.join('\n  ')}`
  )
}
if (stale.length > 0) {
  console.error(`Entries that match no model with a store_id:\n  ${stale.join('\n  ')}`)
}
if (uncovered.length > 0 || stale.length > 0) exit(1)
console.log(`${models.length} models with a store_id, all covered`)
