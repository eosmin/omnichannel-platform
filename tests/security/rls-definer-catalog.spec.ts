import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

// Every SECURITY DEFINER function of the database, read from the catalog (not from a list of migrations), against a CLOSED list of who
// may call it. The per-function specs fix each function they know; this one is the net for the next one: a definer function that is
// added with no entry here, that keeps EXECUTE for PUBLIC, that is granted to a role it should not be, that does not fix its search_path
// with pg_temp last, or that is owned by a login role of the application, fails the suite until it is reviewed and listed.
// (`pnpm validate:definer` reads the migrations for the search_path only; it does not look at grants.)
// The audit of the activation of RLS (area 5, findings D2 and D3) is the origin of this file.

const APP = 'platform_app'
const WORKER = 'platform_worker'
// A trigger function cannot be called with SELECT: its EXECUTE is the default one, only its search_path and owner are checked
const TRIGGER = 'trigger'

// function name -> the roles that hold EXECUTE (besides its owner). Add a function here in the PR that creates it, with the reason.
const DEFINER_FUNCTIONS: Readonly<Record<string, readonly string[] | typeof TRIGGER>> = {
  // finance ledger: write as the owner of the tables on behalf of the triggers
  advance_finance_head: TRIGGER,
  apply_journal_line_to_balance: TRIGGER,
  // the purge of the audit trail: the worker only
  purge_audit_logs: [WORKER],
  // which store owns an id: the worker's alone (the api always has the store from the guard)
  rls_store_of_media: [WORKER],
  rls_store_of_export: [WORKER],
  rls_store_of_scheduled_report: [WORKER],
  // resolvers that find their store before any context exists
  rls_resolve_channel_connection: [APP, WORKER],
  resolve_widget_site: [APP, WORKER],
  resolve_plugin_installation: [APP, WORKER],
  resolve_api_key: [APP, WORKER],
  resolve_carrier_connection: [APP, WORKER],
  lookup_plugin_status_of_key: [APP, WORKER],
  // the api only
  rls_store_tables_with_rows: [APP],
  rls_take_disconnected_connection: [APP],
  rls_transfer_line_store_ids: [APP],
  rls_plugin_foreign_owner: [APP],
  rls_search_messages: [APP],
  rls_search_messages_typed: [APP],
  rls_search_customers: [APP],
  rls_search_orders: [APP],
  rls_search_products: [APP],
  rls_search_product_matches: [APP],
  // the api and the worker (the exports run per page in the context of a store)
  rls_search_customer_list: [APP, WORKER],
  rls_count_customer_list: [APP, WORKER],
  rls_search_order_customers: [APP, WORKER],
  rls_list_remote_channel_plugins: [APP, WORKER],
  // the lists and sweeps of the worker, across stores: the worker only
  rls_list_enabled_scheduled_reports: [WORKER],
  rls_list_shipment_poll_targets: [WORKER],
  rls_list_benefit_close_targets: [WORKER],
  rls_list_pickup_targets: [WORKER],
  rls_list_active_channel_connections: [WORKER],
  rls_list_users_with_pending_email: [WORKER],
  rls_list_pickups_pending_stale: [WORKER],
  rls_list_pickups_count_behind: [WORKER],
  rls_audit_oldest_before: [WORKER],
  rls_audit_count_between: [WORKER],
  rls_audit_logs_for_cold_export: [WORKER],
  rls_list_avatar_media: [WORKER],
  rls_list_orphan_avatars: [WORKER],
  rls_clear_orphan_avatar: [WORKER],
  rls_avatar_media_keys: [WORKER]
}

interface DefinerRow {
  name: string
  schema: string
  is_trigger: boolean
  config: string[] | null
  owner: string
  grantees: string[]
}

describe('row-level security: the SECURITY DEFINER functions of the catalog', () => {
  const raw = new pg.Client({ connectionString: connectionUrls().owner })
  let rows: DefinerRow[] = []
  let tablesOwner = ''

  beforeAll(async () => {
    await raw.connect()
    rows = (
      await raw.query<DefinerRow>(
        `SELECT p.proname AS name, n.nspname AS schema, p.prorettype = 'trigger'::regtype AS is_trigger,
                p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
                coalesce((
                  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                         ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
                  FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
                ), ARRAY[]::text[]) AS grantees
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         ORDER BY p.proname`
      )
    ).rows
    tablesOwner = (
      await raw.query<{ owner: string }>(
        `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.stores'::regclass`
      )
    ).rows[0]?.owner as string
  })
  afterAll(async () => {
    await raw.end().catch(() => undefined)
  })

  it('finds the definer functions at all (an empty catalog read would pass every other case)', () => {
    expect(rows.length).toBeGreaterThan(30)
    expect(tablesOwner).not.toBe('')
  })

  it('lists every definer function, in the public schema, and none that no longer exists', () => {
    const found = rows.map(row => row.name)
    expect(
      rows.filter(row => row.schema !== 'public').map(row => `${row.schema}.${row.name}`)
    ).toEqual([])
    expect(found.filter(name => !(name in DEFINER_FUNCTIONS))).toEqual([])
    expect(Object.keys(DEFINER_FUNCTIONS).filter(name => !found.includes(name))).toEqual([])
    // An overload would be a second function with the same name and its own grants: it is reviewed by name, so it is refused
    expect(found.filter((name, index) => found.indexOf(name) !== index)).toEqual([])
  })

  it('gives EXECUTE to PUBLIC to none of them, and to exactly the roles of the list', () => {
    const wrong: string[] = []
    for (const row of rows) {
      const expected = DEFINER_FUNCTIONS[row.name]
      if (expected === undefined || expected === TRIGGER) continue
      expect(row.is_trigger).toBe(false)
      const want = [...expected].sort()
      if (JSON.stringify(row.grantees) !== JSON.stringify(want)) {
        wrong.push(
          `${row.name}: ${row.grantees.join(',') || '(nobody)'} instead of ${want.join(',')}`
        )
      }
    }
    expect(wrong).toEqual([])
  })

  it('keeps the trigger functions as triggers, and every other one callable', () => {
    for (const row of rows) {
      const expected = DEFINER_FUNCTIONS[row.name]
      if (expected === TRIGGER) expect(row.is_trigger).toBe(true)
    }
  })

  it('fixes the search_path of each one with pg_temp last', () => {
    const wrong: string[] = []
    for (const row of rows) {
      const entry = (row.config ?? []).find(setting => setting.startsWith('search_path='))
      const path = (entry ?? '')
        .slice('search_path='.length)
        .split(',')
        .map(part => part.trim())
      if (entry === undefined || path[path.length - 1] !== 'pg_temp') {
        wrong.push(`${row.name}: ${entry ?? 'no search_path'}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('belongs to the owner of the tables, never to a role of the application', () => {
    expect(
      rows.filter(row => row.owner !== tablesOwner).map(row => `${row.name}: ${row.owner}`)
    ).toEqual([])
    expect([APP, WORKER]).not.toContain(tablesOwner)
  })
})
