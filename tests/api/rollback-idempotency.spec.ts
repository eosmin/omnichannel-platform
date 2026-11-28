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
  ['20270213100000_fiscal_void_event.rollback.sql', 'fiscal_documents', 'void_event_encrypted']
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
  // The rollback of the roles of returns and VAT deletes only the accounts and mappings its migration wrote, and only those with no entries
  // (the cases with rows are in `finance-returns-vat-roles-migration.spec.ts`): run twice on the database as it is, it must not fail and must
  // not take a row of any other account
  it('20270217100000_finance_returns_vat_roles.rollback.sql runs twice and touches only the rows its migration wrote', async () => {
    const sql = body('20270217100000_finance_returns_vat_roles.rollback.sql')
    const others = `SELECT count(*)::int AS n FROM ledger_accounts WHERE NOT (code IN ('1402','1405','1406','2103','6113') AND id = md5(organization_id || ':finance_returns_vat:' || code)::uuid::text)`
    await client.query('BEGIN')
    try {
      const before = (await client.query<{ n: number }>(others)).rows[0]
      await client.query(sql)
      await client.query(sql)
      expect((await client.query<{ n: number }>(others)).rows[0]).toEqual(before)
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
  // The rollback of the constancia of the exported annexes drops its two append-only tables with rows in them (the triggers refuse a DELETE, never
  // a DROP) and its function; the second run finds nothing. Rows are written with the foreign keys off for the transaction, never committed.
  it('20270218100000_fiscal_annex_export_constancy.rollback.sql drops the constancia with its rows, and runs a second time on the result', async () => {
    const sql = body('20270218100000_fiscal_annex_export_constancy.rollback.sql')
    const present = async (name: string): Promise<boolean> =>
      (await client.query<{ found: string | null }>(`SELECT to_regclass($1) AS found`, [name]))
        .rows[0]?.found != null
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO fiscal_annex_exports (id, organization_id, annex_id, year, month, row_count, content_sha256, sources_sha256, exported_by)
         VALUES ('rb-x1', 'o', 'purchases', 2026, 10, 1, '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'u')`
      )
      await client.query(
        `INSERT INTO fiscal_annex_export_items (id, organization_id, export_id, receipt_id, source_sha256, included)
         VALUES ('rb-i1', 'o', 'rb-x1', 'r1', '${'c'.repeat(64)}', true)`
      )
      expect(await present('fiscal_annex_exports')).toBe(true)
      await client.query(sql)
      expect(await present('fiscal_annex_exports')).toBe(false)
      expect(await present('fiscal_annex_export_items')).toBe(false)
      expect(
        (
          await client.query(
            `SELECT 1 FROM pg_proc WHERE proname = 'forbid_fiscal_annex_export_change'`
          )
        ).rowCount
      ).toBe(0)
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
  // The rollback of the purchases from excluded subjects drops both tables and their five functions, with their rows (nothing else refers to
  // them), and the second run finds nothing. Rows are written with the foreign keys and the triggers off for the transaction, never committed.
  it('20270215100000_excluded_subject_purchases.rollback.sql drops the tables with their rows, and runs a second time on the result', async () => {
    const sql = body('20270215100000_excluded_subject_purchases.rollback.sql')
    const found = async (name: string): Promise<boolean> =>
      (await client.query<{ found: string | null }>(`SELECT to_regclass($1) AS found`, [name]))
        .rows[0]?.found !== null
    const functions = async (): Promise<number> =>
      (
        await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('check_excluded_subject_purchase_total', 'check_excluded_subject_purchase_lines_total', 'forbid_excluded_subject_purchase_change', 'guard_excluded_subject_purchase', 'fiscal_reseal_excluded_subject')`
        )
      ).rows[0]?.n ?? -1
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO excluded_subject_purchases (id, organization_id, client_key, purchased_on, seller_document_type, seller_encrypted, amount_cents, vat_withheld_cents, income_tax_withheld_cents, operation_type, expense_class, sector, cost_type, created_by)
         VALUES ('rb-esp1', 'o', 'rb-key-1', '2026-11-01', '2', decode('01' || repeat('00', 40), 'hex'), 5000, 0, 500, '1', '2', '2', '1', 'u')`
      )
      await client.query(
        `INSERT INTO excluded_subject_purchase_lines (id, organization_id, purchase_id, line_no, description, kind, amount_cents)
         VALUES ('rb-espl1', 'o', 'rb-esp1', 1, 'flete', 'service', 5000)`
      )
      expect(await found('excluded_subject_purchases')).toBe(true)
      expect(await functions()).toBe(5)
      await client.query(sql)
      expect(await found('excluded_subject_purchases')).toBe(false)
      expect(await found('excluded_subject_purchase_lines')).toBe(false)
      expect(await functions()).toBe(0)
      await client.query(sql)
    } finally {
      await client.query('ROLLBACK')
    }
  })

  // The rollback of the kinds of evidence of an invalidation: with no file of the new kinds the check goes back to the five kinds and the
  // second run finds it done; with one, the first run FAILS and nothing changes (the files a receiver was owed are never deleted).
  describe('20270216100000_fiscal_void_evidence_kinds.rollback.sql', () => {
    const sql = body('20270216100000_fiscal_void_evidence_kinds.rollback.sql')
    const checkKinds = async (): Promise<string> =>
      (
        await client.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_media_fiscal_evidence'`
        )
      ).rows[0]?.def ?? ''
    it('puts the check back to five kinds and runs a second time on the result', async () => {
      await client.query('BEGIN')
      try {
        expect(await checkKinds()).toContain('void_dte_file')
        await client.query(sql)
        const after = await checkKinds()
        expect(after).not.toContain('void_dte_file')
        expect(after).not.toContain('void_representation')
        expect(after).toContain('dte_file')
        await client.query(sql)
        expect(await checkKinds()).toBe(after)
      } finally {
        await client.query('ROLLBACK')
      }
    })

    it('fails, and changes nothing, while a file of the new kinds exists', async () => {
      await client.query('BEGIN')
      try {
        await client.query('SET LOCAL session_replication_role = replica')
        await client.query(
          `INSERT INTO media (id, store_id, purpose, fiscal_document_id, fiscal_evidence_kind, key, filename, content_type, file_size)
           VALUES ('rb-m', 's', 'fiscal_evidence', 'rb-doc', 'void_representation', 'rb/void-key', 'f.pdf', 'application/pdf', 1)`
        )
        const before = await checkKinds()
        await client.query('SAVEPOINT rollback_try')
        await expect(client.query(sql)).rejects.toThrow(/chk_media_fiscal_evidence/)
        await client.query('ROLLBACK TO SAVEPOINT rollback_try')
        expect(await checkKinds()).toBe(before)
      } finally {
        await client.query('ROLLBACK')
      }
    })
  })

  // The rollback of the subject of a delivery: with only deliveries of documents, the first run takes the guard, the function, the checks and the
  // column away and puts the key of the document back; the second finds it done. With a delivery of an invalidation it FAILS and changes nothing.
  describe('20270219100000_fiscal_delivery_void_subject.rollback.sql', () => {
    const sql = body('20270219100000_fiscal_delivery_void_subject.rollback.sql')
    const count = async (query: string): Promise<number> =>
      (await client.query(query)).rowCount ?? 0
    const hasTrigger = (): Promise<number> =>
      count(
        `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fiscal_delivery_guard' AND NOT tgisinternal`
      )
    const hasFunction = (): Promise<number> =>
      count(`SELECT 1 FROM pg_proc WHERE proname = 'fiscal_delivery_guard'`)
    const hasIndex = (name: string): Promise<number> =>
      count(
        `SELECT 1 FROM pg_indexes WHERE tablename = 'fiscal_deliveries' AND indexname = '${name}'`
      )
    const workerCanUpdate = async (): Promise<boolean> =>
      (
        await client.query<{ ok: boolean }>(
          `SELECT has_table_privilege('platform_worker', 'fiscal_deliveries', 'UPDATE') AS ok`
        )
      ).rows[0]?.ok === true
    const insert = (id: string, document: string, subject: string): Promise<unknown> =>
      client.query(
        `INSERT INTO fiscal_deliveries (id, organization_id, store_id, document_id, order_id, subject, status, route, reason)
         VALUES ($1, 'o', 's', $2, 'od', $3, 'not_sent', 'none', 'no_channel')`,
        [id, document, subject]
      )

    it('takes the guard, the function and the subject away, keeps the rows, and runs a second time on the result', async () => {
      await client.query('BEGIN')
      try {
        await client.query('SET LOCAL session_replication_role = replica')
        await insert('rb-s1', 'rb-sd1', 'document')
        // The migration took UPDATE from the worker
        expect(await workerCanUpdate()).toBe(false)
        expect(await hasTrigger()).toBe(1)
        expect(await hasFunction()).toBe(1)
        expect(await hasIndex('fiscal_deliveries_document_id_subject_key')).toBe(1)
        await client.query(sql)
        expect(await hasColumn('fiscal_deliveries', 'subject')).toBe(false)
        expect(await hasTrigger()).toBe(0)
        expect(await hasFunction()).toBe(0)
        expect(await hasIndex('fiscal_deliveries_document_id_subject_key')).toBe(0)
        expect(await hasIndex('fiscal_deliveries_document_id_key')).toBe(1)
        expect(await count(`SELECT 1 FROM fiscal_deliveries WHERE id = 'rb-s1'`)).toBe(1)
        // The worker holds UPDATE on the table again, as before the migration
        expect(await workerCanUpdate()).toBe(true)
        await client.query(sql)
        expect(await workerCanUpdate()).toBe(true)
        expect(await hasIndex('fiscal_deliveries_document_id_key')).toBe(1)
      } finally {
        await client.query('ROLLBACK')
      }
    })

    it('fails, and changes nothing, while the delivery of an invalidation exists', async () => {
      await client.query('BEGIN')
      try {
        await client.query('SET LOCAL session_replication_role = replica')
        await insert('rb-s2', 'rb-sd2', 'document')
        await insert('rb-s3', 'rb-sd2', 'void')
        await client.query('SAVEPOINT rollback_try')
        await expect(client.query(sql)).rejects.toThrow(/delivery of an invalidation/)
        await client.query('ROLLBACK TO SAVEPOINT rollback_try')
        expect(await hasColumn('fiscal_deliveries', 'subject')).toBe(true)
        expect(await hasTrigger()).toBe(1)
      } finally {
        await client.query('ROLLBACK')
      }
    })
  })
})
