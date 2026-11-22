import pg from 'pg'

import {
  connectionUrls,
  DatabaseRoles,
  replicaConnectionUrl
} from '@platform/core/database-testing'

// The role of DATABASE_REPLICA_URL (migration 20270122000000_rls_replica_readonly_role): it can only read, so a write through the
// handle of replicaTenantRead is refused by the database itself where there is no real standby (development, CI), and it sees
// the rows of the tenant context once Row-Level Security is enforced. Replaces the `SET TRANSACTION READ ONLY` that did not hold
// in CI (the callback saw 'off').
describe('the read only role of the replica', () => {
  const owner = new pg.Client({ connectionString: connectionUrls().owner })
  // The name is a constant of the harness: it is a role (an identifier), so it goes into the text of the statement
  const replica = DatabaseRoles.REPLICA

  beforeAll(async () => {
    await owner.connect()
  })
  afterAll(async () => {
    await owner.end()
  })

  it('is not a superuser, does not skip row security, cannot create anything and is not a member of a role', async () => {
    const { rows } = await owner.query<Record<string, boolean>>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
              has_database_privilege(rolname, current_database(), 'CREATE') AS can_create_in_database
         FROM pg_roles WHERE rolname = $1`,
      [DatabaseRoles.REPLICA]
    )
    expect(rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        can_create_in_database: false
      }
    ])
    const members = await owner.query<{ rolname: string }>(
      `SELECT g.rolname FROM pg_roles me
         JOIN pg_auth_members m ON m.member = me.oid
         JOIN pg_roles g ON g.oid = m.roleid
        WHERE me.rolname = $1`,
      [DatabaseRoles.REPLICA]
    )
    expect(members.rows).toEqual([])
  })

  it('holds no write privilege on any table, column, sequence or schema', async () => {
    const tables = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
          AND (has_table_privilege($1, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR has_any_column_privilege($1, c.oid, 'INSERT, UPDATE, REFERENCES'))
        ORDER BY c.relname`,
      [DatabaseRoles.REPLICA]
    )
    expect(tables.rows).toEqual([])
    const sequences = await owner.query<{ sequencename: string }>(
      `SELECT sequencename FROM pg_sequences
        WHERE schemaname = 'public'
          AND has_sequence_privilege($1, format('%I.%I', schemaname, sequencename), 'USAGE, UPDATE')
        ORDER BY sequencename`,
      [DatabaseRoles.REPLICA]
    )
    expect(sequences.rows).toEqual([])
    const schema = await owner.query<{ can_create: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS can_create`,
      [DatabaseRoles.REPLICA]
    )
    expect(schema.rows).toEqual([{ can_create: false }])
  })

  it('reads the same tables platform_app reads, and no table that platform_app cannot', async () => {
    const both = await owner.query<{ relname: string; replica_only: boolean }>(
      `SELECT c.relname, has_table_privilege($1, c.oid, 'SELECT') AS replica_only
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND has_table_privilege($1, c.oid, 'SELECT') <> has_table_privilege($2, c.oid, 'SELECT')
        ORDER BY c.relname`,
      [DatabaseRoles.REPLICA, DatabaseRoles.APP]
    )
    // A table the api reads and the replica does not (a global table made after this role) needs its own GRANT in its migration
    expect(both.rows).toEqual([])
  })

  it('is named by every policy that platform_app reads through (a new table calls rls_extend_policies_to_replica)', async () => {
    const { rows } = await owner.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'public' AND cmd IN ('SELECT', 'ALL')
          AND '${DatabaseRoles.APP}'::name = ANY (roles) AND NOT ($1::name = ANY (roles))
        ORDER BY tablename, policyname`,
      [DatabaseRoles.REPLICA]
    )
    expect(rows).toEqual([])
  })

  it('has a function that adds the role to the policies and finds nothing left to add', async () => {
    const { rows } = await owner.query<{ changed: number }>(
      'SELECT rls_extend_policies_to_replica() AS changed'
    )
    expect(rows[0]?.changed).toBe(0)
  })

  it('reads only the rows of the context under enforced policies and cannot write', async () => {
    await owner.query('BEGIN')
    try {
      await owner.query(
        'CREATE TABLE zz_replica_probe (id text PRIMARY KEY, store_id text NOT NULL)'
      )
      // The rows go in before row security is forced: an owner that is not a superuser would be bound by it too
      await owner.query(`INSERT INTO zz_replica_probe VALUES ('1', 'store-a'), ('2', 'store-b')`)
      await owner.query(`GRANT SELECT ON zz_replica_probe TO ${replica}`)
      await owner.query('ALTER TABLE zz_replica_probe ENABLE ROW LEVEL SECURITY')
      await owner.query('ALTER TABLE zz_replica_probe FORCE ROW LEVEL SECURITY')
      await owner.query(
        `CREATE POLICY zz_probe ON zz_replica_probe FOR SELECT TO ${DatabaseRoles.APP}, ${replica}
           USING (store_id = ANY ((SELECT app_store_ids())::text[]))`
      )
      await owner.query(`SET LOCAL ROLE ${replica}`)
      await owner.query(`SELECT set_config('app.store_ids', 'store-a', true)`)
      const seen = await owner.query<{ id: string }>('SELECT id FROM zz_replica_probe ORDER BY id')
      expect(seen.rows.map(row => row.id)).toEqual(['1'])
      await owner.query('SAVEPOINT write')
      await expect(
        owner.query(`INSERT INTO zz_replica_probe VALUES ('3', 'store-a')`)
      ).rejects.toMatchObject({ code: '42501' })
      await owner.query('ROLLBACK TO SAVEPOINT write')
      await owner.query(`SELECT set_config('app.store_ids', '', true)`)
      const none = await owner.query('SELECT id FROM zz_replica_probe')
      expect(none.rows).toEqual([])
    } finally {
      await owner.query('ROLLBACK')
    }
  })

  it('refuses a write on a connection of its own, whatever the mode of the session', async () => {
    const connection = new pg.Client({ connectionString: replicaConnectionUrl() })
    await connection.connect()
    try {
      // The role starts read only (a second line of defence): a write is refused by the mode before it reaches the privilege
      await expect(
        connection.query(`UPDATE stores SET name = name WHERE false`)
      ).rejects.toMatchObject({ code: '25006' })
      // The guarantee is the privilege: with the mode turned off the same write is refused for the missing UPDATE
      await connection.query('SET default_transaction_read_only = off')
      await expect(
        connection.query(`UPDATE stores SET name = name WHERE false`)
      ).rejects.toMatchObject({ code: '42501' })
      await expect(connection.query('SELECT count(*) FROM stores')).resolves.toBeDefined()
    } finally {
      await connection.end()
    }
  })
})
