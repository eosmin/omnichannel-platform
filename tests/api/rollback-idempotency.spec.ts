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
  ['20270208100000_fiscal_delivery_by_hand.rollback.sql', 'fiscal_deliveries', 'handed_over_at'],
  [
    '20270211100000_purchase_document_issued_on.rollback.sql',
    'purchase_receipt_documents',
    'issued_on'
  ],
  ['20270213100000_fiscal_void_event.rollback.sql', 'fiscal_documents', 'void_event_encrypted'],
  ['20270214100000_fiscal_contingency_batch.rollback.sql', 'fiscal_documents', 'batch_id']
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
  // The rollback of the day of issue drops the column and the index of the month and keeps every row: a document keeps its codes, a mark keeps
  // its reason, and the second run finds nothing to do. Rows are written with the foreign keys off for the transaction, never committed.
  it('20270211100000_purchase_document_issued_on.rollback.sql keeps the documents and the marks, and runs a second time on the result', async () => {
    const sql = body('20270211100000_purchase_document_issued_on.rollback.sql')
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO purchase_receipt_documents (id, organization_id, receipt_id, issued_on, document_class, document_type, generation_code, purchase_origin, expense_class, sector, cost_type, annex_exclusion, created_by)
         VALUES ('rb-d1', 'o', 'r1', '2026-02-05', '4', '03', 'RB-CODE-1', 'internal', '1', '2', '5', NULL, 'u'),
                ('rb-d2', 'o', 'r2', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'not_deductible', 'u')`
      )
      expect(
        (
          await client.query(
            `SELECT to_regclass('purchase_receipts_organization_id_received_on_idx') AS found`
          )
        ).rows[0]
      ).toEqual({ found: 'purchase_receipts_organization_id_received_on_idx' })
      await client.query(sql)
      expect(await hasColumn('purchase_receipt_documents', 'issued_on')).toBe(false)
      expect(
        (
          await client.query(
            `SELECT to_regclass('purchase_receipts_organization_id_received_on_idx') AS found`
          )
        ).rows[0]
      ).toEqual({ found: null })
      const rows = await client.query(
        `SELECT id, document_type, generation_code, annex_exclusion FROM purchase_receipt_documents WHERE id LIKE 'rb-d%' ORDER BY id`
      )
      expect(rows.rows).toEqual([
        { id: 'rb-d1', document_type: '03', generation_code: 'RB-CODE-1', annex_exclusion: null },
        {
          id: 'rb-d2',
          document_type: null,
          generation_code: null,
          annex_exclusion: 'not_deductible'
        }
      ])
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
  // The rollback of the sealed event: with a voided row that holds one, the first run takes the column, the function of the re-seal and the
  // check away and gives the guard the form it had before (it no longer names the column); the second finds it done. Written with the triggers
  // off for the transaction (replica role), never committed.
  it('20270213100000_fiscal_void_event.rollback.sql drops the column, the function and the check, with an event sealed in a row, and runs twice', async () => {
    const sql = body('20270213100000_fiscal_void_event.rollback.sql')
    const hasFunction = async (): Promise<boolean> =>
      (await client.query(`SELECT 1 FROM pg_proc WHERE proname = 'fiscal_reseal_void_event'`))
        .rowCount === 1
    const guardNamesColumn = async (): Promise<boolean> =>
      (
        await client.query<{ named: boolean }>(
          `SELECT prosrc LIKE '%void_event_encrypted%' AS named FROM pg_proc WHERE proname = 'fiscal_document_guard'`
        )
      ).rows[0]?.named === true
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO fiscal_documents (id, organization_id, store_id, order_id, sequence_number, document_type, status, provider_id, environment,
           issuer_snapshot, lines_snapshot, receiver_encrypted, total_cents, tax_cents, void_reason, voided_by, voided_at, void_event_encrypted, updated_at)
         VALUES ('rb-doc', 'o', 's', 'od', 987654321, 'pending', 'voided', 'simulator', 'sandbox', '{}', '{}', '\\x01', 1, 0, 'r', 'u', now(), '\\x0102', now())`
      )
      expect(await hasFunction()).toBe(true)
      expect(await guardNamesColumn()).toBe(true)
      await client.query(sql)
      expect(await hasColumn('fiscal_documents', 'void_event_encrypted')).toBe(false)
      expect(await hasFunction()).toBe(false)
      expect(await guardNamesColumn()).toBe(false)
      const check = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'fiscal_documents_void_event_encrypted_chk'`
      )
      expect(check.rowCount).toBe(0)
      // The row stays: only the sealed event goes with the column
      expect(
        (await client.query(`SELECT 1 FROM fiscal_documents WHERE id = 'rb-doc'`)).rowCount
      ).toBe(1)
      await client.query(sql)
    } finally {
      await client.query('ROLLBACK')
    }
  })
  // The rollback of the lots: with a lot and a document held in it, the first run takes the column, the check, the table and its guard away and
  // gives the guard of the documents the form of 20270213100000 (it no longer names the column); the second finds it done. Written with the
  // triggers off for the transaction (replica role), never committed.
  it('20270214100000_fiscal_contingency_batch.rollback.sql drops the lots and the column, with a document held in a lot, and runs twice', async () => {
    const sql = body('20270214100000_fiscal_contingency_batch.rollback.sql')
    const hasTable = async (): Promise<boolean> =>
      (
        await client.query<{ found: string | null }>(
          `SELECT to_regclass('fiscal_contingency_batches')::text AS found`
        )
      ).rows[0]?.found !== null
    const guardNamesColumn = async (): Promise<boolean> =>
      (
        await client.query<{ named: boolean }>(
          `SELECT prosrc LIKE '%batch_id%' AS named FROM pg_proc WHERE proname = 'fiscal_document_guard'`
        )
      ).rows[0]?.named === true
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO fiscal_contingencies (id, organization_id, provider_id, environment, status, origin, reason, event_code, started_at, ended_at, reported_at, window_ends_at, updated_at)
         VALUES ('rb-c', 'o', 'p', 'sandbox', 'reported', 'user', 'r', 'rb-event', now(), now(), now(), now(), now())`
      )
      await client.query(
        `INSERT INTO fiscal_contingency_batches (id, organization_id, contingency_id, sequence, send_id, document_count, updated_at)
         VALUES ('rb-b', 'o', 'rb-c', 1, 'rb-send', 1, now())`
      )
      await client.query(
        `INSERT INTO fiscal_documents (id, organization_id, store_id, order_id, sequence_number, document_type, status, provider_id, environment,
           issuer_snapshot, lines_snapshot, receiver_encrypted, total_cents, tax_cents, contingency_id, batch_id, updated_at)
         VALUES ('rb-doc-b', 'o', 's', 'od', 987654322, 'pending', 'queued', 'simulator', 'sandbox', '{}', '{}', '\\x01', 1, 0, 'rb-c', 'rb-b', now())`
      )
      expect(await hasTable()).toBe(true)
      expect(await guardNamesColumn()).toBe(true)
      await client.query(sql)
      expect(await hasColumn('fiscal_documents', 'batch_id')).toBe(false)
      expect(await hasTable()).toBe(false)
      expect(await guardNamesColumn()).toBe(false)
      // The row stays: only the lot goes with the column
      expect(
        (await client.query(`SELECT 1 FROM fiscal_documents WHERE id = 'rb-doc-b'`)).rowCount
      ).toBe(1)
      await client.query(sql)
    } finally {
      await client.query('ROLLBACK')
    }
  })
})
