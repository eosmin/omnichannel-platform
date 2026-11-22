import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls, DatabaseRoles } from '@platform/core/database-testing'
import { ApiKeyStatus, ChannelConnectionStatus } from '@platform/core/domain'

// Row-Level Security, phase 6 (F6-3b): the flows that find their store BEFORE there is a tenant context (the api key of the public
// API, the key of a plugin installation, the site key of the web widget, the id of a carrier connection in the address of its
// webhook). Each one asks a SECURITY DEFINER function (migration 20270122200000_rls_resolvers_live_rows) for the ids of the store
// and then reads its row inside the context of THAT store. The functions are the real ones, called as platform_app with no context;
// the tables they lead to are private temporary copies that carry the REAL policies and are enforced for platform_app inside a
// transaction that is always rolled back, so the shared tables are never locked and every fixture (also inserted into the real tables, with session_replication_role = replica) lives in a transaction that is always rolled back, so the cases run next to every suite. The owner of the tables is a superuser in CI: the function under an owner that is not (with FORCE) is covered by the `rls-enforced` job (F6-5).
// What is proven: the right context comes back or nothing does, an id of another store never resolves, a key that can no longer open
// a door opens no context, and the context that comes back reaches the row of its store and no other.

const TABLES = [
  'api_keys',
  'plugin_installations',
  'channel_connections',
  'carrier_connections'
] as const

const COMMANDS: Readonly<Record<string, string>> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL'
}

const FILLERS: Readonly<Record<string, string>> = {
  text: `'x'`,
  'character varying': `'x'`,
  integer: '0',
  bigint: '0',
  smallint: '0',
  numeric: '0',
  boolean: 'false',
  jsonb: `'{}'::jsonb`,
  json: `'{}'::json`,
  bytea: `'\\x00'::bytea`,
  'timestamp without time zone': 'now()',
  'timestamp with time zone': 'now()',
  date: 'now()::date',
  ARRAY: `'{}'`
}

interface PolicyRow {
  table: string
  name: string
  command: string
  using: string | null
  check: string | null
}

interface Resolved {
  id: string
  store_id: string
  organization_id: string
}

describe('row-level security, the flows that find their store before there is a context', () => {
  const run = randomUUID().replaceAll('-', '').slice(0, 8)
  const ORG_A = `pf-oa-${run}`
  const ORG_B = `pf-ob-${run}`
  const A = `pf-a-${run}`
  const B = `pf-b-${run}`
  const WIDGET = 'web-widget-spec'
  const SITE_A = `SITE-A-${run}`
  const SITE_B = `SITE-B-${run}`
  const CARRIER_A = randomUUID()
  const owner = new pg.Client({ connectionString: connectionUrls().owner })
  let policies: PolicyRow[] = []

  beforeAll(async () => {
    await owner.connect()
    // Before any copy exists: the text of a policy names the tables it reads by their real name only while no temporary table shadows them
    const result = await owner.query<PolicyRow>(
      `SELECT c.relname AS "table", p.polname AS name, p.polcmd AS command,
              pg_get_expr(p.polqual, p.polrelid) AS "using", pg_get_expr(p.polwithcheck, p.polrelid) AS "check"
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[])
         AND '${DatabaseRoles.APP}'::regrole::oid = ANY (p.polroles)
       ORDER BY c.relname, p.polname`,
      [TABLES]
    )
    policies = result.rows
  })

  afterAll(async () => {
    await owner.end()
  })

  async function insertFixture(table: string, row: Record<string, string | null>): Promise<void> {
    const columns = await owner.query<{ column_name: string; data_type: string }>(
      `SELECT a.attname AS column_name,
              CASE WHEN t.typcategory = 'A' THEN 'ARRAY' ELSE format_type(a.atttypid, NULL) END AS data_type
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
       WHERE a.attrelid = (SELECT to_regclass($1)) AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attnotnull AND NOT a.atthasdef AND a.attgenerated = ''`,
      [`public.${table}`]
    )
    const names = Object.keys(row)
    const extra = columns.rows.filter(column => !names.includes(column.column_name))
    const allNames = [...names, ...extra.map(column => column.column_name)]
    const placeholders = [
      ...names.map((_, index) => `$${index + 1}`),
      ...extra.map(column => FILLERS[column.data_type] ?? `'x'`)
    ]
    await owner.query(
      `INSERT INTO public.${table} (${allNames.map(name => `"${name}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
      names.map(name => row[name] ?? null)
    )
  }

  // The fixtures go into the REAL tables (the functions read those), then the enforced copies are made from them. All inside one
  // transaction that is rolled back.
  async function inFlows<T>(work: () => Promise<T>): Promise<T> {
    await owner.query('BEGIN')
    try {
      await owner.query('SET LOCAL session_replication_role = replica')
      await insertFixture('organizations', { id: ORG_A, name: 'x', slug: `o-a-${run}` })
      await insertFixture('organizations', { id: ORG_B, name: 'x', slug: `o-b-${run}` })
      await insertFixture('stores', {
        id: A,
        organization_id: ORG_A,
        name: 'x',
        slug: `s-a-${run}`
      })
      await insertFixture('stores', {
        id: B,
        organization_id: ORG_B,
        name: 'x',
        slug: `s-b-${run}`
      })
      await insertFixture('channel_connections', {
        id: `cc-a-${run}`,
        store_id: A,
        plugin_id: WIDGET,
        connection_id: SITE_A,
        status: ChannelConnectionStatus.ACTIVE
      })
      await insertFixture('channel_connections', {
        id: `cc-b-${run}`,
        store_id: B,
        plugin_id: WIDGET,
        connection_id: SITE_B,
        status: ChannelConnectionStatus.DISCONNECTED
      })
      await insertFixture('api_keys', {
        id: `k-a-${run}`,
        store_id: A,
        key_hash: `h-a-${run}`,
        status: ApiKeyStatus.ACTIVE
      })
      await insertFixture('api_keys', {
        id: `k-b-${run}`,
        store_id: B,
        key_hash: `h-b-${run}`,
        status: ApiKeyStatus.ACTIVE
      })
      await insertFixture('api_keys', {
        id: `k-rev-${run}`,
        store_id: A,
        key_hash: `h-rev-${run}`,
        status: ApiKeyStatus.REVOKED
      })
      await owner.query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [
        `k-rev-${run}`
      ])
      await insertFixture('api_keys', {
        id: `k-gone-${run}`,
        store_id: A,
        key_hash: `h-gone-${run}`,
        status: ApiKeyStatus.ACTIVE
      })
      await owner.query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [
        `k-gone-${run}`
      ])
      await insertFixture('api_keys', {
        id: `k-exp-${run}`,
        store_id: A,
        key_hash: `h-exp-${run}`,
        status: ApiKeyStatus.ACTIVE
      })
      await owner.query(
        `UPDATE public.api_keys SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE id = $1`,
        [`k-exp-${run}`]
      )
      await insertFixture('plugin_installations', {
        id: `pi-a-${run}`,
        store_id: A,
        plugin_id: 'p',
        api_key_hash: `ph-a-${run}`,
        status: 'active'
      })
      await insertFixture('plugin_installations', {
        id: `pi-b-${run}`,
        store_id: B,
        plugin_id: 'p',
        api_key_hash: `ph-b-${run}`,
        status: 'disabled'
      })
      // A plugin registered by ANOTHER organization, installed in store A: the policy of plugins hides it from the context of A
      await insertFixture('plugins', {
        id: `pl-b-${run}`,
        organization_id: ORG_B,
        status: 'approved'
      })
      await insertFixture('plugin_installations', {
        id: `pi-c-${run}`,
        store_id: A,
        plugin_id: `pl-b-${run}`,
        api_key_hash: `ph-c-${run}`,
        status: 'active'
      })
      await insertFixture('carrier_connections', { id: CARRIER_A, store_id: A, carrier_id: 'c' })
      for (const table of TABLES) {
        await owner.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table}`)
        await owner.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${DatabaseRoles.APP}`
        )
        await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
        await owner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
        for (const policy of policies.filter(p => p.table === table)) {
          const using = policy.using === null ? '' : ` USING (${policy.using})`
          const check = policy.check === null ? '' : ` WITH CHECK (${policy.check})`
          await owner.query(
            `CREATE POLICY ${policy.name} ON pg_temp.${table} AS PERMISSIVE FOR ${COMMANDS[policy.command] ?? 'ALL'} TO ${DatabaseRoles.APP}${using}${check}`
          )
        }
      }
      return await work()
    } finally {
      await owner.query('ROLLBACK')
    }
  }

  // The function as platform_app with NO context at all: the situation these flows are in
  async function resolve(statement: string, values: unknown[]): Promise<Resolved[]> {
    await owner.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
    try {
      return (await owner.query<Resolved>(statement, values)).rows
    } finally {
      await owner.query('RESET ROLE')
    }
  }

  // Rows of a table as platform_app inside the context a lookup returned (the way contextOf() opens it), or with none
  async function readAs(found: Resolved | null, table: (typeof TABLES)[number]): Promise<string[]> {
    await owner.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
    try {
      await owner.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
        [found?.store_id ?? '', found?.organization_id ?? '']
      )
      const rows = await owner.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)
      return rows.rows.map(row => row.id)
    } finally {
      await owner.query('RESET ROLE')
    }
  }

  describe('the site key of the web widget', () => {
    it('opens the context of the store of an active site, which reaches its connection and no other', async () => {
      await inFlows(async () => {
        const found = await resolve('SELECT * FROM resolve_widget_site($1, $2)', [WIDGET, SITE_A])
        expect(found).toEqual([{ id: `cc-a-${run}`, store_id: A, organization_id: ORG_A }])
        expect(await readAs(found[0] ?? null, 'channel_connections')).toEqual([`cc-a-${run}`])
      })
    })

    it('opens nothing for a site that was disconnected, for the id of a connection used as a key and for another plugin', async () => {
      await inFlows(async () => {
        expect(
          await resolve('SELECT * FROM resolve_widget_site($1, $2)', [WIDGET, SITE_B])
        ).toEqual([])
        expect(
          await resolve('SELECT * FROM resolve_widget_site($1, $2)', [WIDGET, `cc-a-${run}`])
        ).toEqual([])
        expect(
          await resolve('SELECT * FROM resolve_widget_site($1, $2)', ['another-plugin', SITE_A])
        ).toEqual([])
      })
    })

    it('shows a public call with no context nothing of the connections', async () => {
      await inFlows(async () => {
        expect(await readAs(null, 'channel_connections')).toEqual([])
      })
    })
  })

  describe('the key of the public API', () => {
    it('opens the context of the store of an active key, which reaches the keys of that store only', async () => {
      await inFlows(async () => {
        const found = await resolve('SELECT * FROM resolve_api_key($1)', [`h-b-${run}`])
        expect(found).toEqual([{ id: `k-b-${run}`, store_id: B, organization_id: ORG_B }])
        expect(await readAs(found[0] ?? null, 'api_keys')).toEqual([`k-b-${run}`])
      })
    })

    it('opens nothing for a key that was revoked, one with a revoked date and one that expired', async () => {
      await inFlows(async () => {
        for (const hash of [`h-rev-${run}`, `h-gone-${run}`, `h-exp-${run}`]) {
          expect(await resolve('SELECT * FROM resolve_api_key($1)', [hash])).toEqual([])
        }
      })
    })

    it('judges the expiry in UTC whatever the time zone of the session is (expires_at holds UTC with no zone)', async () => {
      await inFlows(async () => {
        await insertFixture('api_keys', {
          id: `k-soon-${run}`,
          store_id: A,
          key_hash: `h-soon-${run}`,
          status: ApiKeyStatus.ACTIVE
        })
        await owner.query(
          `UPDATE public.api_keys SET expires_at = (now() AT TIME ZONE 'UTC') + interval '5 hours' WHERE id = $1`,
          [`k-soon-${run}`]
        )
        for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
          await owner.query(`SET LOCAL TIME ZONE '${zone}'`)
          // Valid for five more hours: resolves in every zone. The one that expired an hour ago never does.
          expect(await resolve('SELECT * FROM resolve_api_key($1)', [`h-soon-${run}`])).toEqual([
            { id: `k-soon-${run}`, store_id: A, organization_id: ORG_A }
          ])
          expect(await resolve('SELECT * FROM resolve_api_key($1)', [`h-exp-${run}`])).toEqual([])
        }
      })
    })

    it('opens nothing for the id of a key, for the hash of a key of a plugin or for a key that does not exist', async () => {
      await inFlows(async () => {
        for (const value of [`k-a-${run}`, `ph-a-${run}`, `h-nobody-${run}`]) {
          expect(await resolve('SELECT * FROM resolve_api_key($1)', [value])).toEqual([])
        }
      })
    })
  })

  describe('the key of a plugin installation', () => {
    it('opens the context of the store of the installation, which reaches its installations and no other', async () => {
      await inFlows(async () => {
        const found = await resolve('SELECT * FROM resolve_plugin_installation($1)', [
          `ph-a-${run}`
        ])
        expect(found).toEqual([{ id: `pi-a-${run}`, store_id: A, organization_id: ORG_A }])
        // Store A holds two installations (pi-c is the one of the plugin of another organization): both are its own, none of store B
        expect(await readAs(found[0] ?? null, 'plugin_installations')).toEqual([
          `pi-a-${run}`,
          `pi-c-${run}`
        ])
      })
    })

    it('still answers an installation that is not active (the guard refuses it and audits which one it was), and only its own store', async () => {
      await inFlows(async () => {
        const found = await resolve('SELECT * FROM resolve_plugin_installation($1)', [
          `ph-b-${run}`
        ])
        expect(found).toEqual([{ id: `pi-b-${run}`, store_id: B, organization_id: ORG_B }])
        expect(await readAs(found[0] ?? null, 'plugin_installations')).toEqual([`pi-b-${run}`])
      })
    })

    it('answers the status of the plugin of an installation whose plugin the policy hides from its store', async () => {
      await inFlows(async () => {
        const state = await owner.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`).then(async () => {
          try {
            return (
              await owner.query<{ plugin_status: string }>(
                'SELECT * FROM lookup_plugin_status_of_key($1)',
                [`ph-c-${run}`]
              )
            ).rows
          } finally {
            await owner.query('RESET ROLE')
          }
        })
        expect(state).toEqual([{ plugin_status: 'approved' }])
      })
    })

    it('answers nothing for a key with no plugin row, for a hash of another kind of key and for one that does not exist', async () => {
      await inFlows(async () => {
        for (const hash of [`ph-a-${run}`, `h-a-${run}`, `nope-${run}`]) {
          await owner.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
          try {
            const rows = await owner.query('SELECT * FROM lookup_plugin_status_of_key($1)', [hash])
            expect(rows.rows).toEqual([])
          } finally {
            await owner.query('RESET ROLE')
          }
        }
      })
    })

    it('opens nothing for a hash of another kind of key', async () => {
      await inFlows(async () => {
        expect(
          await resolve('SELECT * FROM resolve_plugin_installation($1)', [`h-a-${run}`])
        ).toEqual([])
      })
    })
  })

  describe('the connection named in the address of a carrier webhook', () => {
    it('opens the context of the store of that connection, and the context of another store does not reach it', async () => {
      await inFlows(async () => {
        const found = await resolve('SELECT * FROM resolve_carrier_connection($1)', [CARRIER_A])
        expect(found).toEqual([{ id: CARRIER_A, store_id: A, organization_id: ORG_A }])
        expect(await readAs(found[0] ?? null, 'carrier_connections')).toEqual([CARRIER_A])
        const other: Resolved = { id: 'x', store_id: B, organization_id: ORG_B }
        expect(await readAs(other, 'carrier_connections')).toEqual([])
      })
    })

    it('opens nothing for an id that does not exist or that belongs to something else', async () => {
      await inFlows(async () => {
        expect(
          await resolve('SELECT * FROM resolve_carrier_connection($1)', [randomUUID()])
        ).toEqual([])
        expect(
          await resolve('SELECT * FROM resolve_carrier_connection($1)', [`cc-a-${run}`])
        ).toEqual([])
      })
    })
  })
})
