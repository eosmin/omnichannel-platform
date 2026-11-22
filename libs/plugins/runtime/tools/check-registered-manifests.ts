import { resolve } from 'node:path'
import { exit } from 'node:process'

import { config } from 'dotenv-flow'
import pg from 'pg'
import { z } from 'zod'

import { findInvalidManifests, type StoredManifestRow } from '../src/manifest-audit'

// Data check of PLG-008 (a), run by hand before the registry opens to third parties: every plugin an organization registered (not an official one, not a test fixture) has a
// manifest that today's parser still accepts. Read only: one SELECT in a READ ONLY transaction, over DIRECT_DATABASE_URL.
//
//   pnpm check:plugin-manifests    exit 0 when all pass; exit 1 and the list of those that do not
const env = z
  .object({ DIRECT_DATABASE_URL: z.url() })
  .safeParse(
    config({ path: resolve(import.meta.dirname, '../../../..'), silent: true }).parsed ?? {}
  )
if (!env.success) {
  process.stderr.write(
    'DIRECT_DATABASE_URL (the owner of the database) is required and must be a URL\n'
  )
  exit(2)
}
const url = env.data.DIRECT_DATABASE_URL

const client = new pg.Client({ connectionString: url })
await client.connect()
let rows: StoredManifestRow[]
try {
  await client.query('BEGIN READ ONLY')
  try {
    const result = await client.query<StoredManifestRow>(
      'SELECT id, manifest FROM plugins WHERE is_official = false AND organization_id IS NOT NULL ORDER BY id'
    )
    rows = result.rows
  } finally {
    await client.query('ROLLBACK')
  }
} finally {
  await client.end()
}
const problems = findInvalidManifests(rows)
process.stdout.write(`${rows.length} registered manifests checked\n`)
for (const problem of problems) {
  process.stderr.write(`${problem.pluginId}\n  ${problem.issues.join('\n  ')}\n`)
}
exit(problems.length > 0 ? 1 : 0)
