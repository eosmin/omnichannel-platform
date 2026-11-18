import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

// Row-Level Security, phase 1 (migration 20270121110000_rls_phase1): the policies of the configuration, catalog, audit and analytics
// tables, and the lookups that run before there is a context. The REAL policies are read from the catalog of the database and
// put on private temporary copies of their tables, which are enforced for platform_app inside a transaction that is always rolled
// back: the shared tables of the database are never locked, enforced or written, so this file can run next to every other suite
// (the CI job that enforces every table runs the whole of tenant-isolation.spec.ts as platform_app).
// The cases fail CLOSED: a statement with no context sees nothing and writes nothing, and a context of one store never reaches another.

const STORE_TABLES = [
  'tags',
  'snippets',
  'business_hours',
  'routing_rules',
  'store_settings',
  'retention_settings',
  'notification_preferences',
  'api_keys',
  'webhooks',
  'plugin_installations',
  'scheduled_reports',
  'analytics_events',
  'metrics_daily',
  'metrics_hourly',
  'exports',
  'consent_records'
] as const
const ORGANIZATION_TABLES = ['data_subject_requests'] as const
const CUSTOM_TABLES = ['audit_logs', 'plugins', 'webhook_deliveries'] as const
const PHASE_TABLES = [...STORE_TABLES, ...ORGANIZATION_TABLES, ...CUSTOM_TABLES]

const COMMANDS: Readonly<Record<string, string>> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL'
}

interface PolicyRow {
  table: string
  name: string
  command: string
  roles: string[]
  using: string | null
  check: string | null
}

const RESOLVERS = [
  'resolve_widget_site(text, text)',
  'resolve_plugin_installation(text)',
  'resolve_api_key(text)',
  'resolve_carrier_connection(text)'
] as const

// A value for a NOT NULL column of a fixture row that the case does not care about
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

describe('row-level security, phase 1', () => {
  const run = randomUUID().replaceAll('-', '').slice(0, 8)
  const A = `ph1-a-${run}`
  const B = `ph1-b-${run}`
  const ORG_A = `ph1-oa-${run}`
  const ORG_B = `ph1-ob-${run}`
  const owner = new pg.Client({ connectionString: connectionUrls().owner })
  let policies: PolicyRow[] = []

  beforeAll(async () => {
    await owner.connect()
    // Before any copy exists: the text of a policy names the tables it reads by their real, schema-qualified name only while
    // no temporary table of the same name shadows them
    const result = await owner.query<PolicyRow>(
      `SELECT c.relname AS "table", p.polname AS name, p.polcmd AS command,
              ARRAY(SELECT r.rolname FROM pg_roles r WHERE r.oid = ANY (p.polroles))::text[] AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS "using",
              pg_get_expr(p.polwithcheck, p.polrelid) AS "check"
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[])
       ORDER BY c.relname, p.polname`,
      [PHASE_TABLES]
    )
    policies = result.rows
  })

  afterAll(async () => {
    await owner.end()
  })

  // One transaction on the owner connection: the copies are made, the fixtures go in as the owner, and then the rest runs as
  // platform_app with the context the case asks for. Always rolled back.
  async function inCopies<T>(
    tables: readonly string[],
    work: (app: AppSession) => Promise<T>
  ): Promise<T> {
    await owner.query('BEGIN')
    try {
      for (const table of tables) {
        await owner.query(
          `CREATE TEMP TABLE ${table} AS SELECT * FROM public.${table} WITH NO DATA`
        )
        await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO platform_app`)
        await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
        await owner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
        for (const policy of policies.filter(
          p => p.table === table && p.roles.includes('platform_app')
        )) {
          const using = policy.using === null ? '' : ` USING (${policy.using})`
          const check = policy.check === null ? '' : ` WITH CHECK (${policy.check})`
          await owner.query(
            `CREATE POLICY ${policy.name} ON pg_temp.${table} AS PERMISSIVE FOR ${COMMANDS[policy.command] ?? 'ALL'} TO platform_app${using}${check}`
          )
        }
      }
      return await work(appSession())
    } finally {
      await owner.query('ROLLBACK')
    }
  }

  interface AppSession {
    // Rows as the owner, who is not bound by the policies (fixtures)
    seed: (table: string, rows: Array<Record<string, string | null>>) => Promise<void>
    // The statement as platform_app, with the context set the way PrismaService.tenantTransaction sets it
    as: (
      context: { stores?: string[]; organizations?: string[]; settings?: Record<string, string> },
      statement: string,
      values?: unknown[]
    ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
    // The code of the error a statement ends with (undefined when it succeeds)
    failure: (
      context: { stores?: string[]; organizations?: string[]; settings?: Record<string, string> },
      statement: string,
      values?: unknown[]
    ) => Promise<string | undefined>
  }

  function appSession(): AppSession {
    const enter = async (context: {
      stores?: string[]
      organizations?: string[]
      settings?: Record<string, string>
    }): Promise<void> => {
      await owner.query('SET LOCAL ROLE platform_app')
      await owner.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
        [(context.stores ?? []).join(','), (context.organizations ?? []).join(',')]
      )
      for (const [name, value] of Object.entries(context.settings ?? {})) {
        await owner.query('SELECT set_config($1, $2, true)', [name, value])
      }
    }
    return {
      async seed(table, rows) {
        for (const row of rows) await insertFixture(table, row)
      },
      async as(context, statement, values) {
        await enter(context)
        try {
          const result = await owner.query(statement, values)
          return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
        } finally {
          await owner.query('RESET ROLE')
        }
      },
      async failure(context, statement, values) {
        await enter(context)
        await owner.query('SAVEPOINT attempt')
        try {
          await owner.query(statement, values)
          return undefined
        } catch (error) {
          await owner.query('ROLLBACK TO SAVEPOINT attempt')
          return (error as { code?: string }).code
        } finally {
          await owner.query('RESET ROLE')
        }
      }
    }
  }

  // An insert as the owner into a table (a copy or the real one), filling the NOT NULL columns the case does not name
  async function insertFixture(table: string, row: Record<string, string | null>): Promise<void> {
    const columns = await owner.query<{ column_name: string; data_type: string }>(
      `SELECT a.attname AS column_name,
              CASE WHEN t.typcategory = 'A' THEN 'ARRAY' ELSE format_type(a.atttypid, NULL) END AS data_type
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
       WHERE a.attrelid = (SELECT to_regclass($1)) AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attnotnull AND NOT a.atthasdef AND a.attgenerated = ''`,
      [table]
    )
    const names = Object.keys(row)
    const extra = columns.rows.filter(column => !names.includes(column.column_name))
    const allNames = [...names, ...extra.map(column => column.column_name)]
    const placeholders = [
      ...names.map((_, index) => `$${index + 1}`),
      ...extra.map(column => FILLERS[column.data_type] ?? `'x'`)
    ]
    await owner.query(
      `INSERT INTO ${table} (${allNames.map(name => `"${name}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
      names.map(name => row[name] ?? null)
    )
  }

  const ids = (rows: Array<Record<string, unknown>>): string[] =>
    rows.map(row => String(row['id'])).sort()
  const INSUFFICIENT_PRIVILEGE = '42501'

  describe('the policies are declared, and the migration turns nothing on', () => {
    it('gives every table of the phase its <table>_tenant policy and its owner policy', () => {
      for (const table of PHASE_TABLES) {
        const names = policies.filter(p => p.table === table).map(p => p.name)
        expect(names).toContain(`${table}_tenant`)
        expect(names).toContain(`${table}_owner`)
      }
    })

    it('never opens a table to every role (no policy for PUBLIC)', () => {
      for (const policy of policies) expect(policy.roles).not.toContain('public')
      expect(policies.every(policy => policy.roles.length > 0)).toBe(true)
    })

    it('leaves UPDATE and DELETE of audit_logs with no policy for the application roles (they are revoked)', () => {
      const commands = policies
        .filter(p => p.table === 'audit_logs' && p.roles.includes('platform_app'))
        .map(p => p.command)
        .sort()
      expect(commands).toEqual(['a', 'r'])
    })
  })

  // The tables whose key is the store itself (one row per store): there is no id column
  const KEYED_BY_STORE: readonly string[] = [
    'business_hours',
    'retention_settings',
    'store_settings'
  ]

  describe.each([...STORE_TABLES, ...ORGANIZATION_TABLES])('%s', table => {
    const organization = (ORGANIZATION_TABLES as readonly string[]).includes(table)
    const column = organization ? 'organization_id' : 'store_id'
    const mine = organization ? ORG_A : A
    const other = organization ? ORG_B : B
    const keyless = KEYED_BY_STORE.includes(table)
    // What a row is called in the answers: its id, or its store when the store is its key
    const key = keyless ? column : 'id'
    const as = (id: string): { stores?: string[]; organizations?: string[] } =>
      organization ? { organizations: [id] } : { stores: [id] }
    const crossed = (id: string): { stores?: string[]; organizations?: string[] } =>
      organization ? { stores: [id] } : { organizations: [id] }
    const label = (n: number, owner_: string): string => (keyless ? owner_ : `${table}-${n}`)
    // An insert of one row for the store or organization `owner_`
    const insertOf = (n: number, owner_: string): { sql: string; values: string[] } =>
      keyless
        ? { sql: `INSERT INTO ${table} (${column}) VALUES ($1)`, values: [owner_] }
        : {
            sql: `INSERT INTO ${table} (id, ${column}) VALUES ($1, $2)`,
            values: [label(n, owner_), owner_]
          }

    function rows(): Array<Record<string, string | null>> {
      return keyless
        ? [{ [column]: mine }, { [column]: other }]
        : [
            { id: `${table}-1`, [column]: mine },
            { id: `${table}-2`, [column]: other }
          ]
    }
    const theirs = label(2, other)
    const idsOf = (result: Array<Record<string, unknown>>): string[] =>
      result.map(row => String(row[key])).sort()

    it('shows nothing to a statement with no context, nor to the other kind of id', async () => {
      await inCopies([table], async app => {
        await app.seed(table, rows())
        const none = await app.as({}, `SELECT ${key} FROM ${table}`)
        expect(none.rows).toEqual([])
        const wrongKind = await app.as(crossed(mine), `SELECT ${key} FROM ${table}`)
        expect(wrongKind.rows).toEqual([])
      })
    })

    it('shows the rows of the context and not those of another store or organization', async () => {
      await inCopies([table], async app => {
        await app.seed(table, rows())
        const visible = await app.as(as(mine), `SELECT ${key} FROM ${table}`)
        expect(idsOf(visible.rows)).toEqual([label(1, mine)])
        const byKey = await app.as(as(mine), `SELECT ${key} FROM ${table} WHERE ${key} = $1`, [
          theirs
        ])
        expect(byKey.rows).toEqual([])
      })
    })

    it('refuses a write into another store or organization, and changes nothing of it', async () => {
      await inCopies([table], async app => {
        await app.seed(table, rows())
        const foreign = insertOf(3, other)
        expect(await app.failure(as(mine), foreign.sql, foreign.values)).toBe(
          INSUFFICIENT_PRIVILEGE
        )
        const unowned = insertOf(4, mine)
        expect(await app.failure({}, unowned.sql, unowned.values)).toBe(INSUFFICIENT_PRIVILEGE)
        const removed = await app.as(as(mine), `DELETE FROM ${table} WHERE ${key} = $1`, [theirs])
        expect(removed.rowCount).toBe(0)
      })
    })

    it('does not let a row move to another store or organization', async () => {
      await inCopies([table], async app => {
        await app.seed(table, rows())
        const moved = await app.failure(
          as(mine),
          `UPDATE ${table} SET ${column} = $1 WHERE ${key} = $2`,
          [other, label(1, mine)]
        )
        expect(moved).toBe(INSUFFICIENT_PRIVILEGE)
      })
    })
  })

  describe('audit_logs', () => {
    const rowsOf = (): Array<Record<string, string | null>> => [
      { id: `audit-a-${run}`, action: 'x', store_id: A },
      { id: `audit-b-${run}`, action: 'x', store_id: B },
      { id: `audit-n-${run}`, action: 'x', store_id: null }
    ]

    it('shows a request the entries of its own store only, never the ones with no store, and nothing with no context', async () => {
      await inCopies(['audit_logs'], async app => {
        await app.seed('audit_logs', rowsOf())
        expect((await app.as({}, 'SELECT id FROM audit_logs')).rows).toEqual([])
        const visible = await app.as({ stores: [A] }, 'SELECT id FROM audit_logs')
        expect(ids(visible.rows)).toEqual([`audit-a-${run}`])
        const several = await app.as({ stores: [A, B] }, 'SELECT id FROM audit_logs')
        expect(ids(several.rows)).toEqual([`audit-a-${run}`, `audit-b-${run}`])
        const organizations = await app.as({ organizations: [ORG_A] }, 'SELECT id FROM audit_logs')
        expect(organizations.rows).toEqual([])
      })
    })

    it('takes an entry with no store (login, system) and one of the store of the context, with no RETURNING', async () => {
      await inCopies(['audit_logs'], async app => {
        expect(
          await app.failure(
            {},
            `INSERT INTO audit_logs (id, action, store_id) VALUES ($1, 'x', NULL)`,
            [`audit-1-${run}`]
          )
        ).toBeUndefined()
        expect(
          await app.failure(
            { stores: [A] },
            `INSERT INTO audit_logs (id, action, store_id) VALUES ($1, 'x', $2)`,
            [`audit-2-${run}`, A]
          )
        ).toBeUndefined()
      })
    })

    it('refuses an entry for a store that is not the context, with or without a context', async () => {
      await inCopies(['audit_logs'], async app => {
        const insert = `INSERT INTO audit_logs (id, action, store_id) VALUES ($1, 'x', $2)`
        expect(await app.failure({ stores: [A] }, insert, [`audit-3-${run}`, B])).toBe(
          INSUFFICIENT_PRIVILEGE
        )
        expect(await app.failure({}, insert, [`audit-4-${run}`, B])).toBe(INSUFFICIENT_PRIVILEGE)
      })
    })

    it('refuses an INSERT ... RETURNING of an entry with no store: the returned row has to pass the SELECT policy', async () => {
      await inCopies(['audit_logs'], async app => {
        const code = await app.failure(
          { stores: [A] },
          `INSERT INTO audit_logs (id, action, store_id) VALUES ($1, 'x', NULL) RETURNING id`,
          [`audit-5-${run}`]
        )
        expect(code).toBe(INSUFFICIENT_PRIVILEGE)
      })
    })

    it('has no policy for UPDATE or DELETE, so the trail cannot be changed through a policy', async () => {
      await inCopies(['audit_logs'], async app => {
        await app.seed('audit_logs', rowsOf())
        const mine = `audit-%-${run}`
        const update = await app.as(
          { stores: [A] },
          `UPDATE audit_logs SET action = 'y' WHERE id LIKE $1`,
          [mine]
        )
        expect(update.rowCount).toBe(0)
        const remove = await app.as({ stores: [A] }, 'DELETE FROM audit_logs WHERE id LIKE $1', [
          mine
        ])
        expect(remove.rowCount).toBe(0)
      })
    })
  })

  describe('plugins', () => {
    const rowsOf = (): Array<Record<string, string | null>> => [
      { id: `official-${run}`, organization_id: null },
      { id: `mine-${run}`, organization_id: ORG_A },
      { id: `theirs-${run}`, organization_id: ORG_B }
    ]

    it('shows the official plugins and the ones of the organization of the context, never another organization private plugin', async () => {
      await inCopies(['plugins'], async app => {
        await app.seed('plugins', rowsOf())
        const visible = await app.as({ organizations: [ORG_A] }, 'SELECT id FROM plugins')
        expect(ids(visible.rows)).toEqual([`mine-${run}`, `official-${run}`])
        const none = await app.as({}, 'SELECT id FROM plugins')
        expect(ids(none.rows)).toEqual([`official-${run}`])
      })
    })

    it('lets an organization write its own plugin and neither an official one nor another organization one', async () => {
      await inCopies(['plugins'], async app => {
        await app.seed('plugins', rowsOf())
        const own = await app.failure(
          { organizations: [ORG_A] },
          'INSERT INTO plugins (id, organization_id) VALUES ($1, $2)',
          [`new-${run}`, ORG_A]
        )
        expect(own).toBeUndefined()
        const official = await app.failure(
          { organizations: [ORG_A] },
          'INSERT INTO plugins (id, organization_id) VALUES ($1, NULL)',
          [`new-official-${run}`]
        )
        expect(official).toBe(INSUFFICIENT_PRIVILEGE)
        const foreign = await app.failure(
          { organizations: [ORG_A] },
          'INSERT INTO plugins (id, organization_id) VALUES ($1, $2)',
          [`new-theirs-${run}`, ORG_B]
        )
        expect(foreign).toBe(INSUFFICIENT_PRIVILEGE)
        const edited = await app.as(
          { organizations: [ORG_A] },
          `UPDATE plugins SET name = 'hacked' WHERE id = $1`,
          [`official-${run}`]
        )
        expect(edited.rowCount).toBe(0)
        const deleted = await app.as(
          { organizations: [ORG_A] },
          'DELETE FROM plugins WHERE id = $1',
          [`official-${run}`]
        )
        expect(deleted.rowCount).toBe(0)
      })
    })

    it('lets only the catalog transaction write a plugin of the platform (no organization), and nothing else with that setting', async () => {
      await inCopies(['plugins'], async app => {
        await app.seed('plugins', rowsOf())
        const catalog = { settings: { 'app.platform_catalog': 'on' } }
        expect(
          await app.failure(
            catalog,
            'INSERT INTO plugins (id, organization_id) VALUES ($1, NULL)',
            [`platform-${run}`]
          )
        ).toBeUndefined()
        const refreshed = await app.as(catalog, `UPDATE plugins SET name = 'ok' WHERE id = $1`, [
          `official-${run}`
        ])
        expect(refreshed.rowCount).toBe(1)
        // The flag opens the platform rows only: a private plugin of an organization is not written with it
        expect(
          await app.failure(catalog, 'INSERT INTO plugins (id, organization_id) VALUES ($1, $2)', [
            `private-${run}`,
            ORG_B
          ])
        ).toBe(INSUFFICIENT_PRIVILEGE)
        const private_ = await app.as(catalog, `UPDATE plugins SET name = 'x' WHERE id = $1`, [
          `theirs-${run}`
        ])
        expect(private_.rowCount).toBe(0)
        // Any other value of the flag opens nothing
        expect(
          await app.failure(
            { settings: { 'app.platform_catalog': 'yes' } },
            'INSERT INTO plugins (id, organization_id) VALUES ($1, NULL)',
            [`platform-2-${run}`]
          )
        ).toBe(INSUFFICIENT_PRIVILEGE)
      })
    })
  })

  describe('webhook_deliveries (no store_id: it follows its webhook or its plugin installation)', () => {
    async function seedAll(app: AppSession): Promise<void> {
      await app.seed('webhooks', [
        { id: `wa-${run}`, store_id: A },
        { id: `wb-${run}`, store_id: B }
      ])
      await app.seed('plugin_installations', [
        { id: `ia-${run}`, store_id: A },
        { id: `ib-${run}`, store_id: B }
      ])
      await app.seed('webhook_deliveries', [
        { id: `d1-${run}`, webhook_id: `wa-${run}`, plugin_installation_id: null },
        { id: `d2-${run}`, webhook_id: `wb-${run}`, plugin_installation_id: null },
        { id: `d3-${run}`, webhook_id: null, plugin_installation_id: `ia-${run}` },
        { id: `d4-${run}`, webhook_id: null, plugin_installation_id: `ib-${run}` },
        { id: `d5-${run}`, webhook_id: null, plugin_installation_id: null }
      ])
    }

    it('shows the deliveries of the webhooks and installations of the store of the context, and nothing with no context', async () => {
      await inCopies(['webhooks', 'plugin_installations', 'webhook_deliveries'], async app => {
        await seedAll(app)
        expect((await app.as({}, 'SELECT id FROM webhook_deliveries')).rows).toEqual([])
        const visible = await app.as({ stores: [A] }, 'SELECT id FROM webhook_deliveries')
        expect(ids(visible.rows)).toEqual([`d1-${run}`, `d3-${run}`])
      })
    })

    it('refuses a delivery that belongs to a webhook or an installation of another store, or to none', async () => {
      await inCopies(['webhooks', 'plugin_installations', 'webhook_deliveries'], async app => {
        await seedAll(app)
        const insert = `INSERT INTO webhook_deliveries (id, webhook_id, plugin_installation_id) VALUES ($1, $2, $3)`
        expect(
          await app.failure({ stores: [A] }, insert, [`n1-${run}`, `wa-${run}`, null])
        ).toBeUndefined()
        expect(await app.failure({ stores: [A] }, insert, [`n2-${run}`, `wb-${run}`, null])).toBe(
          INSUFFICIENT_PRIVILEGE
        )
        expect(await app.failure({ stores: [A] }, insert, [`n3-${run}`, null, `ib-${run}`])).toBe(
          INSUFFICIENT_PRIVILEGE
        )
        expect(await app.failure({ stores: [A] }, insert, [`n4-${run}`, null, null])).toBe(
          INSUFFICIENT_PRIVILEGE
        )
      })
    })

    it('holds when the parent tables are not enforced (the predicate reads the store of the parent, not its policy)', async () => {
      await owner.query('BEGIN')
      try {
        // Only the child is a copy that is enforced: the parents are plain temporary tables with no row security
        await owner.query(
          `CREATE TEMP TABLE webhooks AS SELECT * FROM public.webhooks WITH NO DATA`
        )
        await owner.query(
          `CREATE TEMP TABLE plugin_installations AS SELECT * FROM public.plugin_installations WITH NO DATA`
        )
        await owner.query(
          `CREATE TEMP TABLE webhook_deliveries AS SELECT * FROM public.webhook_deliveries WITH NO DATA`
        )
        await owner.query(`GRANT SELECT ON webhooks, plugin_installations TO platform_app`)
        await owner.query(`GRANT SELECT, INSERT ON webhook_deliveries TO platform_app`)
        await owner.query(`ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY`)
        await owner.query(`ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY`)
        for (const policy of policies.filter(
          p => p.table === 'webhook_deliveries' && p.name === 'webhook_deliveries_tenant'
        )) {
          await owner.query(
            `CREATE POLICY ${policy.name} ON pg_temp.webhook_deliveries FOR ALL TO platform_app USING (${policy.using ?? 'false'}) WITH CHECK (${policy.check ?? 'false'})`
          )
        }
        await insertFixture('webhooks', { id: `wa-${run}`, store_id: A })
        await insertFixture('webhooks', { id: `wb-${run}`, store_id: B })
        await insertFixture('webhook_deliveries', { id: `d1-${run}`, webhook_id: `wa-${run}` })
        await insertFixture('webhook_deliveries', { id: `d2-${run}`, webhook_id: `wb-${run}` })
        await owner.query('SET LOCAL ROLE platform_app')
        await owner.query("SELECT set_config('app.store_ids', $1, true)", [A])
        const rows = await owner.query<{ id: string }>('SELECT id FROM webhook_deliveries')
        expect(rows.rows.map(row => row.id)).toEqual([`d1-${run}`])
      } finally {
        await owner.query('ROLLBACK')
      }
    })
  })

  describe('the lookups that run before there is a context', () => {
    // The real tables, inside a transaction that is rolled back (the functions read the real ones, never a copy)
    async function withKeys<T>(work: () => Promise<T>): Promise<T> {
      await owner.query('BEGIN')
      try {
        await owner.query('SET LOCAL session_replication_role = replica')
        await insertFixture('organizations', { id: ORG_A, name: 'x', slug: `o-${run}` })
        await insertFixture('stores', {
          id: A,
          organization_id: ORG_A,
          name: 'x',
          slug: `s-${run}`
        })
        await insertFixture('stores', {
          id: B,
          organization_id: ORG_A,
          name: 'x',
          slug: `s2-${run}`
        })
        await insertFixture('channel_connections', {
          id: `cc-${run}`,
          store_id: A,
          plugin_id: 'site-plugin',
          connection_id: `SITE-${run}`
        })
        await insertFixture('plugin_installations', {
          id: `pi-${run}`,
          store_id: A,
          plugin_id: 'p',
          api_key_hash: `hash-pi-${run}`
        })
        await insertFixture('api_keys', { id: `k-${run}`, store_id: B, key_hash: `hash-k-${run}` })
        await insertFixture('carrier_connections', {
          id: `cr-${run}`,
          store_id: A,
          carrier_id: 'c'
        })
        return await work()
      } finally {
        await owner.query('ROLLBACK')
      }
    }

    async function lookup(
      statement: string,
      values: unknown[]
    ): Promise<Array<Record<string, unknown>>> {
      await owner.query('SET LOCAL ROLE platform_app')
      try {
        // No tenant context at all: this is the situation the lookup is for
        return (await owner.query(statement, values)).rows as Array<Record<string, unknown>>
      } finally {
        await owner.query('RESET ROLE')
      }
    }

    it('finds the connection of a widget site key with the ids of its store and organization, and nothing else', async () => {
      await withKeys(async () => {
        const rows = await lookup('SELECT * FROM resolve_widget_site($1, $2)', [
          'site-plugin',
          `SITE-${run}`
        ])
        expect(rows).toEqual([{ id: `cc-${run}`, store_id: A, organization_id: ORG_A }])
      })
    })

    it('finds a plugin installation by the hash of its key, an api key by its hash and a carrier connection by its id', async () => {
      await withKeys(async () => {
        expect(
          await lookup('SELECT * FROM resolve_plugin_installation($1)', [`hash-pi-${run}`])
        ).toEqual([{ id: `pi-${run}`, store_id: A, organization_id: ORG_A }])
        expect(await lookup('SELECT * FROM resolve_api_key($1)', [`hash-k-${run}`])).toEqual([
          { id: `k-${run}`, store_id: B, organization_id: ORG_A }
        ])
        expect(await lookup('SELECT * FROM resolve_carrier_connection($1)', [`cr-${run}`])).toEqual(
          [{ id: `cr-${run}`, store_id: A, organization_id: ORG_A }]
        )
      })
    })

    it('answers nothing for a key that is not exact: another case, a prefix, a wildcard, an empty value, another plugin', async () => {
      await withKeys(async () => {
        const attempts: Array<[string, unknown[]]> = [
          ['SELECT * FROM resolve_widget_site($1, $2)', ['site-plugin', `site-${run}`]],
          ['SELECT * FROM resolve_widget_site($1, $2)', ['site-plugin', 'SITE-%']],
          ['SELECT * FROM resolve_widget_site($1, $2)', ['site-plugin', '']],
          ['SELECT * FROM resolve_widget_site($1, $2)', ['other-plugin', `SITE-${run}`]],
          ['SELECT * FROM resolve_plugin_installation($1)', [`hash-pi-${run.slice(0, 4)}`]],
          ['SELECT * FROM resolve_plugin_installation($1)', ['%']],
          ['SELECT * FROM resolve_api_key($1)', ['']],
          ['SELECT * FROM resolve_api_key($1)', [`HASH-K-${run}`]],
          ['SELECT * FROM resolve_carrier_connection($1)', ['cr-%']],
          ['SELECT * FROM resolve_carrier_connection($1)', ['']]
        ]
        for (const [statement, values] of attempts) {
          expect(await lookup(statement, values)).toEqual([])
        }
      })
    })

    it('answers at most one row per key and never a column other than the three ids (no secret, scope or status)', async () => {
      const columns = await owner.query<{ name: string; columns: string[] }>(
        `SELECT p.proname AS name,
                ARRAY(SELECT unnest(p.proargnames[p.pronargs + 1:]))::text[] AS columns
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'resolve\\_%'
         ORDER BY p.proname`
      )
      expect(columns.rows).toHaveLength(RESOLVERS.length)
      for (const row of columns.rows)
        expect(row.columns).toEqual(['id', 'store_id', 'organization_id'])
    })

    it('belongs to the owner of the tables, reads with a fixed search path, writes nothing and is callable by the application roles only', async () => {
      const result = await owner.query<{
        name: string
        definer: boolean
        volatility: string
        config: string[] | null
        owned_by_tables_owner: boolean
        public_exec: boolean
        app_exec: boolean
        worker_exec: boolean
      }>(
        `SELECT p.proname AS name, p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
                p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'public.api_keys'::regclass) AS owned_by_tables_owner,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('platform_app', p.oid, 'EXECUTE') AS app_exec,
                has_function_privilege('platform_worker', p.oid, 'EXECUTE') AS worker_exec
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'resolve\\_%'`
      )
      expect(result.rows).toHaveLength(RESOLVERS.length)
      for (const row of result.rows) {
        expect(row.definer).toBe(true)
        expect(row.volatility).toBe('s')
        expect(row.config).toEqual(['search_path=public, pg_temp'])
        expect(row.owned_by_tables_owner).toBe(true)
        expect(row.public_exec).toBe(false)
        expect(row.app_exec).toBe(true)
        expect(row.worker_exec).toBe(true)
      }
    })
  })
})
