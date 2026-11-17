import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

const ROLLBACKS = join(__dirname, '../../libs/core/database/rollbacks')

// The rollbacks that promise to be safe to run twice (TDD_03 §5.4: a rollback that failed half way, or one repeated by
// hand, must not fail on what the first run already did). Each is run twice, in a transaction that is never committed,
// so nothing of the shared test database changes. Add a rollback here when it is made idempotent.
const IDEMPOTENT = [
  '20261028120000_plugin_installations.rollback.sql',
  '20261215120000_plugin_webhooks.rollback.sql'
] as const

// The script has its own BEGIN and COMMIT: the case wraps it in the transaction it throws away
function body(file: string): string {
  return readFileSync(join(ROLLBACKS, file), 'utf8')
    .split('\n')
    .filter(line => !/^\s*(BEGIN|COMMIT);\s*$/i.test(line))
    .join('\n')
}

describe('Rollbacks that are safe to run twice', () => {
  let client: pg.Client

  beforeAll(async () => {
    client = new pg.Client({ connectionString: connectionUrls().owner })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  it.each(IDEMPOTENT)('%s runs a second time without failing', async file => {
    const sql = body(file)
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b\s*;/i)
    await client.query('BEGIN')
    try {
      await client.query(sql)
      // The second run finds the first one's work done
      await client.query(sql)
    } finally {
      await client.query('ROLLBACK')
    }
  })
})
