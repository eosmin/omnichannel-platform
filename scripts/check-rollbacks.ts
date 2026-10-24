import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Every migration ships with a rollback script (TDD_03 §5.4), kept outside migrations/ because
// Prisma treats each subdirectory there as a migration.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATIONS = `${ROOT}libs/core/database/prisma/migrations`
const ROLLBACKS = `${ROOT}libs/core/database/rollbacks`
const SUFFIX = '.rollback.sql'

const migrations = readdirSync(MIGRATIONS).filter(name =>
  statSync(`${MIGRATIONS}/${name}`).isDirectory()
)
const rollbacks = existsSync(ROLLBACKS)
  ? readdirSync(ROLLBACKS)
      .filter(name => name.endsWith(SUFFIX))
      .map(name => name.slice(0, -SUFFIX.length))
  : []

const problems = [
  ...migrations
    .filter(name => !rollbacks.includes(name))
    .map(name => `migration ${name} has no rollbacks/${name}${SUFFIX}`),
  ...rollbacks
    .filter(name => !migrations.includes(name))
    .map(name => `rollbacks/${name}${SUFFIX} matches no migration`)
]

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`${migrations.length} migrations, each with a rollback`)
