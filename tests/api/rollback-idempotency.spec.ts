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
  ['20261217100000_finance_receipts.rollback.sql', 'media', 'finance_transaction_id'],
  ['20270208100000_fiscal_delivery_by_hand.rollback.sql', 'fiscal_deliveries', 'hand_means'],
  ['20270208100000_fiscal_delivery_by_hand.rollback.sql', 'fiscal_deliveries', 'handed_over_by'],
  ['20270208100000_fiscal_delivery_by_hand.rollback.sql', 'fiscal_deliveries', 'handed_over_at']
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
  // The rollback of the hand delivery changes data: the rows recorded by hand go back to not sent, the second run finds none and does not fail
  // on the columns the first one dropped. Rows are written with the foreign keys off for the transaction (the owner), and never committed.
  it('20270208100000_fiscal_delivery_by_hand.rollback.sql puts the hand deliveries back, and runs a second time on the result', async () => {
    const sql = body('20270208100000_fiscal_delivery_by_hand.rollback.sql')
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO fiscal_deliveries (id, organization_id, store_id, document_id, order_id, status, route, reason, hand_means, handed_over_by, handed_over_at)
         VALUES ('rb-1', 'o', 's', 'd1', 'o1', 'sent', 'manual', 'no_channel', 'download', 'u', now()),
                ('rb-2', 'o', 's', 'd2', 'o2', 'sent', 'manual', NULL, 'paper', 'u', now()),
                ('rb-3', 'o', 's', 'd3', 'o3', 'sent', 'email', NULL, NULL, NULL, NULL),
                ('rb-4', 'o', 's', 'd4', 'o4', 'not_sent', 'none', 'too_large', NULL, NULL, NULL)`
      )
      await client.query(sql)
      const rows = await client.query(
        `SELECT id, status, route, reason FROM fiscal_deliveries WHERE id LIKE 'rb-%' ORDER BY id`
      )
      expect(rows.rows).toEqual([
        { id: 'rb-1', status: 'not_sent', route: 'none', reason: 'no_channel' },
        { id: 'rb-2', status: 'not_sent', route: 'none', reason: 'files_unavailable' },
        { id: 'rb-3', status: 'sent', route: 'email', reason: null },
        { id: 'rb-4', status: 'not_sent', route: 'none', reason: 'too_large' }
      ])
      await client.query(sql)
    } finally {
      await client.query('ROLLBACK')
    }
  })
})
