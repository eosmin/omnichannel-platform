// Every model with a store_id must have a case in the tenant isolation suite (TDD_13 §6).
// Usage: tsx scripts/check-isolation-coverage.ts
import { existsSync, readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { ISOLATION_EXEMPTIONS } from './isolation-exemptions'
import {
  checkExemptions,
  checkIsolationCoverage,
  planSteps,
  storeScopedModels,
  suiteResources
} from './lib/isolation'

const SCHEMA = 'libs/core/database/prisma/schema.prisma'
const SUITE = 'tests/security/tenant-isolation.spec.ts'
const PLAN = 'docs/IMPLEMENTATION_PLAN.md'

const models = storeScopedModels(readFileSync(SCHEMA, 'utf8'))
// No model at all means that the schema was not read as expected, not that nothing needs a case
if (models.length === 0) {
  console.error(`no model with a store_id found in ${SCHEMA}: the schema convention changed?`)
  exit(1)
}
const exemptionProblems = checkExemptions(
  ISOLATION_EXEMPTIONS,
  planSteps(readFileSync(PLAN, 'utf8'))
)
if (exemptionProblems.invalid.length > 0) {
  console.error(
    `Exemptions with no reason, or for a step the plan does not have (scripts/isolation-exemptions.ts):\n  ${exemptionProblems.invalid.join('\n  ')}`
  )
}
if (exemptionProblems.due.length > 0) {
  console.error(
    `Exempt until a step that is done: the resource exists, so add its case to ${SUITE} and remove the exemption:\n  ${exemptionProblems.due.join('\n  ')}`
  )
}
if (exemptionProblems.invalid.length > 0 || exemptionProblems.due.length > 0) exit(1)

// The suite is a required file: without it nothing is being checked, which is not a pass
if (!existsSync(SUITE)) {
  console.error(`${SUITE} does not exist: the tenant isolation suite is a gate of the platform`)
  exit(1)
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
