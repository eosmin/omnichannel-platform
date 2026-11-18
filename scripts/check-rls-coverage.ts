// Every table of the schema has its Row-Level Security decision (TDD_01 section 3.2, layer 3): a policy, a reason to have none,
// or a phase of the RLS step that will give it one. Also: no migration makes platform_app a bypass role, and no code sets a
// session-level setting that PgBouncer would carry to the next request. Pure files, no database: the catalog of a real database
// is checked by tests/security/rls-isolation.spec.ts.
// Usage: tsx scripts/check-rls-coverage.ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { exit } from 'node:process'

import { RlsGlobalModels, RlsPolicyTables } from '@platform/core/domain'

import {
  checkRlsCoverage,
  coveredTables,
  implicitJoinTables,
  roleViolations,
  scopeMismatches,
  schemaTables,
  sessionSettingViolations
} from './lib/rls'
import { RLS_EXEMPTIONS, RLS_PHASES } from './rls-exceptions'

const SCHEMA = 'libs/core/database/prisma/schema.prisma'
const MIGRATIONS = 'libs/core/database/prisma/migrations'
const SOURCE_ROOTS = ['apps', 'libs', 'tests', 'scripts']
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'generated', 'dist', '.next', '.nx'])
// They quote the forbidden form on purpose
const SELF = new Set(['scripts/lib/rls.ts', 'scripts/lib/rls.spec.ts'])

function* sourceFiles(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue
    const path = `${directory}/${name}`
    const stats = statSync(path)
    if (stats.isDirectory()) yield* sourceFiles(path)
    else if (/\.(ts|tsx|cts|mts)$/.test(name) && !SELF.has(path)) yield path
  }
}

const schemaText = readFileSync(SCHEMA, 'utf8')
const tables = schemaTables(schemaText)
// No table at all means the schema was not read as expected, which is not a pass
if (tables.length === 0) {
  console.error(`no model found in ${SCHEMA}: the schema convention changed?`)
  exit(1)
}

const migrations = readdirSync(MIGRATIONS)
  .filter(name => statSync(`${MIGRATIONS}/${name}`).isDirectory())
  .map(name => ({ name, sql: readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8') }))
const covered = coveredTables(migrations)

const report = checkRlsCoverage(
  tables,
  covered,
  RLS_EXEMPTIONS,
  RLS_PHASES,
  implicitJoinTables(schemaText)
)
const globalModels = tables
  .filter(({ table }) => RLS_EXEMPTIONS[table]?.kind === 'global')
  .map(({ model }) => model)
const globalMismatch = [
  ...globalModels
    .filter(model => !RlsGlobalModels.includes(model))
    .map(model => `${model}: global in scripts/rls-exceptions.ts but not in RlsGlobalModels`),
  ...RlsGlobalModels.filter(model => !globalModels.includes(model)).map(
    model => `${model}: in RlsGlobalModels but not a global table of scripts/rls-exceptions.ts`
  )
]
// The raw SQL guard of PrismaService reads RlsPolicyTables: it must be every table that is not global, and the join tables of the tags
const expectedPolicyTables = [
  ...tables
    .filter(({ table }) => RLS_EXEMPTIONS[table]?.kind !== 'global')
    .map(({ table }) => table),
  ...implicitJoinTables(schemaText)
]
const policyTablesMismatch = [
  ...expectedPolicyTables
    .filter(table => !RlsPolicyTables.includes(table))
    .map(
      table =>
        `${table}: has a policy but is not in RlsPolicyTables (libs/core/domain/rls-policy-tables.ts)`
    ),
  ...RlsPolicyTables.filter(table => !expectedPolicyTables.includes(table)).map(
    table => `${table}: in RlsPolicyTables but not a table with a policy`
  )
]
const roles = [
  ...roleViolations(migrations),
  ...scopeMismatches(tables, migrations),
  ...globalMismatch,
  ...policyTablesMismatch
]
const sessions = sessionSettingViolations(
  SOURCE_ROOTS.flatMap(root => [...sourceFiles(root)]).map(path => ({
    path,
    text: readFileSync(path, 'utf8')
  }))
)

if (report.unclassified.length > 0) {
  console.error(
    `Tables with no Row-Level Security decision (give them a policy with rls_apply_policy in a migration, or list them in scripts/rls-exceptions.ts with a reason):\n  ${report.unclassified.join('\n  ')}`
  )
}
if (report.stale.length > 0) {
  console.error(`Entries of scripts/rls-exceptions.ts to fix:\n  ${report.stale.join('\n  ')}`)
}
if (report.orphanPolicies.length > 0) {
  console.error(
    `Policies on tables that are not in the schema:\n  ${report.orphanPolicies.join('\n  ')}`
  )
}
if (roles.length > 0) console.error(roles.join('\n'))
if (sessions.length > 0) console.error(sessions.join('\n'))

if (
  report.unclassified.length > 0 ||
  report.stale.length > 0 ||
  report.orphanPolicies.length > 0 ||
  roles.length > 0 ||
  sessions.length > 0
) {
  exit(1)
}
const pendingCount = Object.values(RLS_EXEMPTIONS).filter(entry => entry.kind === 'pending').length
console.log(
  `${tables.length} tables: ${covered.size} with a policy, ${pendingCount} pending a phase, ${Object.keys(RLS_EXEMPTIONS).length - pendingCount} global`
)
