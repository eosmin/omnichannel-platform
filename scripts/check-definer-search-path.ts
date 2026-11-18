// Fails when a migration creates a SECURITY DEFINER function whose search_path does not end in pg_temp (see
// scripts/lib/definer-search-path.ts). Pure files, no database. Usage: tsx scripts/check-definer-search-path.ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { exit } from 'node:process'

import { definerViolations } from './lib/definer-search-path'

const MIGRATIONS = 'libs/core/database/prisma/migrations'

const migrations = readdirSync(MIGRATIONS)
  .filter(name => statSync(`${MIGRATIONS}/${name}`).isDirectory())
  .map(name => ({ name, sql: readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8') }))
// No migration at all means the folder was not read as expected, which is not a pass
if (migrations.length === 0) {
  console.error(`no migration found in ${MIGRATIONS}: run it from the root of the repository`)
  exit(1)
}

const problems = definerViolations(migrations)
if (problems.length > 0) {
  console.error(`SECURITY DEFINER functions to fix:\n  ${problems.join('\n  ')}`)
  exit(1)
}
console.log(
  `definer search_path: ${migrations.length} migrations, every SECURITY DEFINER function ends its search_path in pg_temp`
)
