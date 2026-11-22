import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import pg from 'pg'

import { connectionUrls, DatabaseRoles } from '@platform/core/database-testing'

import { coveredTables } from '../../scripts/lib/rls'

// Row-Level Security with enforcement ON (TDD_01 section 3.2, layer 3). The database refuses what the code forgot to filter:
//  - a transaction with NO context sees no row and writes none (fails closed, never open);
//  - the context of store A never reads or writes a row of store B, and the same for organizations;
//  - the context lives only in the transaction (set_config(..., true)), so it cannot reach the next client of a pooled
//    connection (run this file with TEST_POOLER_URL to prove it through PgBouncer in transaction mode);
//  - platform_app can neither skip row security nor switch it off.
//
// The cases run on two probe tables of this file (one scoped by store, one by organization) that get the very policy the real
// tables get, from rls_apply_policy, and are enforced alone (rls_set_enforcement with `only`). So this suite can run in any
// database without changing what the other suites see. The real tables join the same cases as their phases land (the list in
// tests/helpers is extended by each phase), and the CI job that enforces every table runs the whole of tenant-isolation.spec.ts
// as platform_app.

// From the file, not from the working directory: jest runs this project from tests/
const MIGRATIONS = resolve(__dirname, '../../libs/core/database/prisma/migrations')

interface Probe {
  table: string
  scope: 'store' | 'organization'
  column: 'store_id' | 'organization_id'
}

describe('row-level security with enforcement on', () => {
  const run = randomUUID().replaceAll('-', '').slice(0, 10)
  const probes: Record<'store' | 'organization', Probe> = {
    store: { table: `rls_probe_s_${run}`, scope: 'store', column: 'store_id' },
    organization: { table: `rls_probe_o_${run}`, scope: 'organization', column: 'organization_id' }
  }
  const A = `probe-a-${run}`
  const B = `probe-b-${run}`
  const urls = connectionUrls()
  const owner = new pg.Client({ connectionString: urls.owner })
  const opened: pg.Client[] = []

  async function appClient(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: urls.app })
    await client.connect()
    opened.push(client)
    return client
  }

  // What the tenant interceptor does: one transaction, the context first, transaction-local
  async function inContext<T>(
    client: pg.Client,
    context: { stores?: string[]; organizations?: string[] },
    work: () => Promise<T>
  ): Promise<T> {
    await client.query('BEGIN')
    try {
      await client.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
        [(context.stores ?? []).join(','), (context.organizations ?? []).join(',')]
      )
      const result = await work()
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }

  async function failureCode(work: Promise<unknown>): Promise<string | undefined> {
    try {
      await work
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }

  const ids = (rows: Array<{ id: string }>): string[] => rows.map(row => row.id).sort()

  beforeAll(async () => {
    await owner.connect()
    for (const { table, column, scope } of Object.values(probes)) {
      await owner.query(
        `CREATE TABLE ${table} (id text PRIMARY KEY, ${column} text NOT NULL, label text NOT NULL DEFAULT '')`
      )
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${DatabaseRoles.APP}, ${DatabaseRoles.WORKER}`
      )
      await owner.query('SELECT rls_apply_policy($1::regclass, $2)', [table, scope])
      await owner.query(
        `INSERT INTO ${table} (id, ${column}) VALUES ($1, $2), ($3, $2), ($4, $5)`,
        [`${table}-a1`, A, `${table}-a2`, `${table}-b1`, B]
      )
    }
    await owner.query('SELECT rls_set_enforcement(true, $1::text[])', [
      Object.values(probes).map(probe => probe.table)
    ])
  })

  afterAll(async () => {
    for (const client of opened) await client.end().catch(() => undefined)
    for (const { table } of Object.values(probes)) {
      await owner.query(`DROP TABLE IF EXISTS ${table}`)
    }
    await owner.end()
  })

  describe.each(Object.values(probes))('$table (scope: $scope)', ({ table, scope, column }) => {
    const as = (id: string): { stores?: string[]; organizations?: string[] } =>
      scope === 'store' ? { stores: [id] } : { organizations: [id] }
    const own = (prefix: string): string => `${table}-${prefix}`

    it('shows no row to a transaction with no context, and to a statement outside any transaction', async () => {
      const client = await appClient()
      expect((await client.query(`SELECT id FROM ${table}`)).rows).toEqual([])
      const inside = await inContext(client, {}, () => client.query(`SELECT id FROM ${table}`))
      expect(inside.rows).toEqual([])
    })

    it('shows no row for the other kind of id (a store context does not open an organization table, nor the other way round)', async () => {
      const client = await appClient()
      const crossed = scope === 'store' ? { organizations: [A] } : { stores: [A] }
      const rows = await inContext(client, crossed, () => client.query(`SELECT id FROM ${table}`))
      expect(rows.rows).toEqual([])
    })

    it('answers a query with no filter with the rows of the context only', async () => {
      const client = await appClient()
      const rows = await inContext(client, as(A), () =>
        client.query<{ id: string }>(`SELECT id FROM ${table}`)
      )
      expect(ids(rows.rows)).toEqual([own('a1'), own('a2')])
    })

    it('does not find a row of the other store, by id or by a filter that names it', async () => {
      const client = await appClient()
      const byId = await inContext(client, as(A), () =>
        client.query(`SELECT id FROM ${table} WHERE id = $1`, [own('b1')])
      )
      const byColumn = await inContext(client, as(A), () =>
        client.query(`SELECT id FROM ${table} WHERE ${column} = $1`, [B])
      )
      expect(byId.rows).toEqual([])
      expect(byColumn.rows).toEqual([])
    })

    it('refuses to insert a row of the other store (42501) and one with no context', async () => {
      const client = await appClient()
      const crossed = await failureCode(
        inContext(client, as(A), () =>
          client.query(`INSERT INTO ${table} (id, ${column}) VALUES ($1, $2)`, [own('x1'), B])
        )
      )
      const bare = await failureCode(
        inContext(client, {}, () =>
          client.query(`INSERT INTO ${table} (id, ${column}) VALUES ($1, $2)`, [own('x2'), A])
        )
      )
      expect(crossed).toBe('42501')
      expect(bare).toBe('42501')
    })

    it('changes and deletes nothing of the other store, and refuses to move a row to it', async () => {
      const client = await appClient()
      const updated = await inContext(client, as(A), () =>
        client.query(`UPDATE ${table} SET label = 'hacked' WHERE id = $1`, [own('b1')])
      )
      const deleted = await inContext(client, as(A), () =>
        client.query(`DELETE FROM ${table} WHERE id = $1`, [own('b1')])
      )
      expect(updated.rowCount).toBe(0)
      expect(deleted.rowCount).toBe(0)
      const moved = await failureCode(
        inContext(client, as(A), () =>
          client.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [B, own('a1')])
        )
      )
      expect(moved).toBe('42501')
      const { rows } = await owner.query<{ id: string; label: string; scope_id: string }>(
        `SELECT id, label, ${column} AS scope_id FROM ${table} ORDER BY id`
      )
      expect(rows.map(row => [row.id, row.label, row.scope_id])).toEqual([
        [own('a1'), '', A],
        [own('a2'), '', A],
        [own('b1'), '', B]
      ])
    })

    it('writes the rows of its own store', async () => {
      const client = await appClient()
      const written = await inContext(client, as(A), async () => {
        const update = await client.query(`UPDATE ${table} SET label = 'mine' WHERE id = $1`, [
          own('a1')
        ])
        const insert = await client.query(`INSERT INTO ${table} (id, ${column}) VALUES ($1, $2)`, [
          own('a3'),
          A
        ])
        const remove = await client.query(`DELETE FROM ${table} WHERE id = $1`, [own('a3')])
        return [update.rowCount, insert.rowCount, remove.rowCount]
      })
      expect(written).toEqual([1, 1, 1])
    })

    it('shows the rows of every store of the context (a multi-store screen)', async () => {
      const client = await appClient()
      const both = await inContext(
        client,
        scope === 'store' ? { stores: [A, B] } : { organizations: [A, B] },
        () => client.query<{ id: string }>(`SELECT id FROM ${table}`)
      )
      expect(ids(both.rows)).toEqual([own('a1'), own('a2'), own('b1')])
    })

    it('forgets the context when the transaction ends, on the same client', async () => {
      const client = await appClient()
      await inContext(client, as(A), () => client.query(`SELECT id FROM ${table}`))
      const after = await client.query(`SELECT id FROM ${table}`)
      const setting = await client.query<{ value: string }>(
        "SELECT coalesce(current_setting('app.store_ids', true), '') || coalesce(current_setting('app.organization_ids', true), '') AS value"
      )
      expect(after.rows).toEqual([])
      expect(setting.rows[0]?.value).toBe('')
    })

    it('never mixes the contexts of concurrent clients, whatever connection the pool hands them', async () => {
      const clients = await Promise.all(Array.from({ length: 20 }, () => appClient()))
      const seen = await Promise.all(
        clients.map(async (client, index) => {
          const mine = index % 2 === 0 ? A : B
          const rows = await inContext(client, as(mine), async () => {
            // Hold the connection while the others take theirs
            await client.query('SELECT pg_sleep(0.05)')
            return client.query<{ id: string; scope_id: string }>(
              `SELECT id, ${column} AS scope_id FROM ${table}`
            )
          })
          return rows.rows.every(row => row.scope_id === mine) && rows.rows.length > 0
        })
      )
      expect(seen.every(Boolean)).toBe(true)
    })
  })

  describe('the roles and the switch', () => {
    it('keeps platform_app out of the roles that skip row security', async () => {
      const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${DatabaseRoles.APP}'`
      )
      expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }])
    })

    it('connects as platform_app, which is neither a superuser nor the owner of the probe tables', async () => {
      const client = await appClient()
      const { rows } = await client.query<{ user: string; super: string }>(
        "SELECT current_user AS user, current_setting('is_superuser') AS super"
      )
      expect(rows).toEqual([{ user: DatabaseRoles.APP, super: 'off' }])
    })

    it('does not let platform_app turn row security off, change a policy, or read the switch', async () => {
      const client = await appClient()
      const { table } = probes.store
      expect(
        await failureCode(client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`))
      ).toBe('42501')
      expect(
        await failureCode(client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`))
      ).toBe('42501')
      expect(await failureCode(client.query(`DROP POLICY ${table}_tenant ON ${table}`))).toBe(
        '42501'
      )
      expect(await failureCode(client.query('SELECT rls_set_enforcement(false)'))).toBe('42501')
      expect(await failureCode(client.query('SELECT * FROM rls_status'))).toBe('42501')
    })

    it('enforces the probe tables only, so the switch can be limited to a few tables', async () => {
      const { rows } = await owner.query<{ table_name: string; enabled: boolean; forced: boolean }>(
        'SELECT table_name, enabled, forced FROM rls_status WHERE table_name LIKE $1',
        [`rls_probe_%_${run}`]
      )
      expect(rows.map(row => [row.enabled, row.forced])).toEqual([
        [true, true],
        [true, true]
      ])
    })

    it('turns enforcement off and on again with the same function (the way back)', async () => {
      const { table } = probes.store
      await owner.query('SELECT rls_set_enforcement(false, $1::text[])', [[table]])
      const off = await owner.query<{ enabled: boolean }>(
        'SELECT enabled FROM rls_status WHERE table_name = $1',
        [table]
      )
      expect(off.rows).toEqual([{ enabled: false }])
      await owner.query('SELECT rls_set_enforcement(true, $1::text[])', [[table]])
      const on = await owner.query<{ enabled: boolean; forced: boolean }>(
        'SELECT enabled, forced FROM rls_status WHERE table_name = $1',
        [table]
      )
      expect(on.rows).toEqual([{ enabled: true, forced: true }])
    })

    it('has exactly the policies that the migrations create, for the tables of the database', async () => {
      const migrations = readdirSync(MIGRATIONS)
        .filter(name => statSync(`${MIGRATIONS}/${name}`).isDirectory())
        .map(name => ({ name, sql: readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8') }))
      const { rows } = await owner.query<{ table_name: string }>(
        "SELECT table_name FROM rls_status WHERE table_name NOT LIKE 'rls\\_probe\\_%'"
      )
      expect(rows.map(row => row.table_name).sort()).toEqual([...coveredTables(migrations)].sort())
    })
  })
})

// The scopes for rows that may have no owner (an avatar upload with no store, an official plugin with no organization) and for
// tables that carry both columns. A row with no owner is read by every context and written by none that does not name an owner;
// nothing here ever shows the row of another store.
describe('row-level security, scopes with an optional or a double owner', () => {
  const run = randomUUID().replaceAll('-', '').slice(0, 10)
  const urls = connectionUrls()
  const owner = new pg.Client({ connectionString: urls.owner })
  const app = new pg.Client({ connectionString: urls.app })
  const orNull = `rls_probe_n_${run}`
  const either = `rls_probe_e_${run}`
  const A = `scope-a-${run}`
  const B = `scope-b-${run}`

  async function inContext<T>(
    stores: string[],
    organizations: string[],
    work: () => Promise<T>
  ): Promise<T> {
    await app.query('BEGIN')
    try {
      await app.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
        [stores.join(','), organizations.join(',')]
      )
      const result = await work()
      await app.query('COMMIT')
      return result
    } catch (error) {
      await app.query('ROLLBACK')
      throw error
    }
  }

  const failureCode = async (work: Promise<unknown>): Promise<string | undefined> =>
    work.then(
      () => undefined,
      (error: { code?: string }) => error.code
    )

  beforeAll(async () => {
    await owner.connect()
    await app.connect()
    await owner.query(`CREATE TABLE ${orNull} (id text PRIMARY KEY, store_id text)`)
    await owner.query(
      `CREATE TABLE ${either} (id text PRIMARY KEY, store_id text NOT NULL, organization_id text NOT NULL)`
    )
    for (const table of [orNull, either]) {
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${DatabaseRoles.APP}, ${DatabaseRoles.WORKER}`
      )
    }
    await owner.query('SELECT rls_apply_policy($1::regclass, $2)', [orNull, 'store_or_null'])
    await owner.query('SELECT rls_apply_policy($1::regclass, $2)', [
      either,
      'store_or_organization'
    ])
    await owner.query(
      `INSERT INTO ${orNull} (id, store_id) VALUES ('n-a', $1), ('n-b', $2), ('n-none', NULL)`,
      [A, B]
    )
    await owner.query(`INSERT INTO ${either} VALUES ('e-a', $1, 'org-a'), ('e-b', $2, 'org-b')`, [
      A,
      B
    ])
    await owner.query('SELECT rls_set_enforcement(true, $1::text[])', [[orNull, either]])
  })

  afterAll(async () => {
    await app.end().catch(() => undefined)
    for (const table of [orNull, either]) await owner.query(`DROP TABLE IF EXISTS ${table}`)
    await owner.end()
  })

  it('store_or_null: a context reads its own rows and the rows with no owner, never another store', async () => {
    const rows = await inContext([A], [], () =>
      app.query<{ id: string }>(`SELECT id FROM ${orNull}`)
    )
    expect(rows.rows.map(row => row.id).sort()).toEqual(['n-a', 'n-none'])
  })

  it('store_or_null: a write needs an owner in the context (no unowned row, no row of another store; an unowned row cannot be edited or deleted by any context)', async () => {
    const insertNone = await inContext([A], [], () =>
      failureCode(app.query(`INSERT INTO ${orNull} (id, store_id) VALUES ('n-new', NULL)`))
    )
    expect(insertNone).toBe('42501')
    const insertOther = await inContext([A], [], () =>
      failureCode(app.query(`INSERT INTO ${orNull} (id, store_id) VALUES ('n-x', $1)`, [B]))
    )
    expect(insertOther).toBe('42501')
    // An unowned row is visible, but no context may change or delete it: the strict predicate is on every write command
    const edited = await inContext([A], [], () =>
      app.query(`UPDATE ${orNull} SET id = 'n-none-2' WHERE id = 'n-none'`)
    )
    expect(edited.rowCount).toBe(0)
    const removed = await inContext([A], [], () =>
      app.query(`DELETE FROM ${orNull} WHERE id = 'n-none'`)
    )
    expect(removed.rowCount).toBe(0)
    const removedOther = await inContext([A], [], () =>
      app.query(`DELETE FROM ${orNull} WHERE id = 'n-b'`)
    )
    expect(removedOther.rowCount).toBe(0)
    const removedOwn = await inContext([A], [], () =>
      app.query(`DELETE FROM ${orNull} WHERE id = 'n-a'`)
    )
    expect(removedOwn.rowCount).toBe(1)
  })

  it('store_or_organization: a row is seen through its store or through its organization, and through nothing else', async () => {
    const byStore = await inContext([A], [], () =>
      app.query<{ id: string }>(`SELECT id FROM ${either}`)
    )
    expect(byStore.rows.map(row => row.id)).toEqual(['e-a'])
    const byOrganization = await inContext([], ['org-b'], () =>
      app.query<{ id: string }>(`SELECT id FROM ${either}`)
    )
    expect(byOrganization.rows.map(row => row.id)).toEqual(['e-b'])
    const none = await inContext([], [], () => app.query(`SELECT id FROM ${either}`))
    expect(none.rows).toEqual([])
  })
})
