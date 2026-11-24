import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

// Every SECURITY DEFINER function of the schema fixes its search_path to the convention of the project: the catalog first, pg_temp last
// (QA B5, SEG-195). Read from the live catalog, so that a function made by any migration, or altered later, is counted without a list.
const CONVENTION = 'search_path=pg_catalog, public, pg_temp'

describe('the search_path of the SECURITY DEFINER functions', () => {
  const owner = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    await owner.connect()
  })
  afterAll(async () => {
    await owner.end().catch(() => undefined)
  })

  it('is the convention in every one of them', async () => {
    const { rows } = await owner.query<{ name: string; config: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS name, p.proconfig AS config
       FROM pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)`
    )
    // A query that read nothing is not a pass: the three that this convention was written for must be in what it read
    const names = rows.map(row => row.name)
    for (const known of ['advance_finance_head()', 'apply_journal_line_to_balance()']) {
      expect(names).toContain(known)
    }
    expect(names.some(name => name.startsWith('purge_audit_logs('))).toBe(true)
    const off = rows.filter(row => !(row.config ?? []).includes(CONVENTION)).map(row => row.name)
    expect(off).toEqual([])
  })
})
