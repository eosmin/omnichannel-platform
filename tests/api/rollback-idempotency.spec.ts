import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

const ROLLBACKS = join(__dirname, '../../libs/core/database/rollbacks')

// The rollbacks that promise to be safe to run twice (TDD_03 §5.4: a rollback that failed half way, or one repeated by
// hand, must not fail on what the first run already did). Each is run twice, in a transaction that is never committed,
// so nothing of the shared test database changes (the statements do take their locks until the end of each case, so
// the suites of this folder run one at a time, `--runInBand`, as the migration specs rely on). Add a rollback here when it is made idempotent.
// With the columns each one removes, to check that the first run did its work and the second found it done
const IDEMPOTENT = [
  ['20261028120000_plugin_installations.rollback.sql', 'channel_connections', 'installation_id'],
  ['20261215120000_plugin_webhooks.rollback.sql', 'plugin_installations', 'webhook_secret'],
  ['20261215120000_plugin_webhooks.rollback.sql', 'webhook_deliveries', 'plugin_installation_id'],
  ['20261217100000_finance_receipts.rollback.sql', 'finance_transactions', 'document_media_id'],
  ['20261217100000_finance_receipts.rollback.sql', 'media', 'finance_transaction_id']
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

  const hasColumn = async (table: string, column: string): Promise<boolean> =>
    (
      await client.query(
        `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped`,
        [table, column]
      )
    ).rowCount === 1

  it.each(IDEMPOTENT)('%s runs a second time without failing', async (file, table, column) => {
    const sql = body(file)
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b\s*;/i)
    await client.query('BEGIN')
    try {
      expect(await hasColumn(table, column)).toBe(true)
      await client.query(sql)
      // The first run did its work: the column the migration added is gone
      expect(await hasColumn(table, column)).toBe(false)
      // The second run finds the first one's work done
      await client.query(sql)
    } finally {
      await client.query('ROLLBACK')
    }
  })
})
