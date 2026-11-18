import {
  checkRlsCoverage,
  coveredTables,
  roleViolations,
  schemaTables,
  scopeMismatches,
  sessionSettingViolations
} from './rls'

const schema = `
model Store {
  id             String @id
  organizationId String @map("organization_id")
  @@map("stores")
}

model Tag {
  id      String @id
  storeId String @map("store_id") // the store
  @@map("tags")
}

model Warehouse {
  id             String @id
  organizationId String @map("organization_id")
  @@map("warehouses")
}

model Membership {
  id             String @id
  storeId        String @map("store_id")
  organizationId String @map("organization_id")
  @@map("memberships")
}

model User {
  id String @id
  // organization_id here is a comment @map("organization_id")
  @@map("users")
}
`

describe('schemaTables', () => {
  it('reads the table and the scope of each model', () => {
    expect(schemaTables(schema).map(t => `${t.table}:${t.scope}`)).toEqual([
      'memberships:both',
      'stores:organization',
      'tags:store',
      'users:none',
      'warehouses:organization'
    ])
  })
})

describe('coveredTables', () => {
  it('counts rls_apply_policy and an explicit <table>_tenant policy, and ignores comments and other policies', () => {
    const covered = coveredTables([
      {
        name: '2',
        sql: "-- SELECT rls_apply_policy('ghost', 'store');\nCREATE POLICY audit_logs_tenant ON audit_logs USING (true);"
      },
      {
        name: '1',
        sql: "SELECT rls_apply_policy('tags', 'store');\nCREATE POLICY other ON users USING (true);"
      }
    ])
    expect([...covered].sort()).toEqual(['audit_logs', 'tags'])
  })

  it('uncovers a table whose policy a later migration drops', () => {
    const covered = coveredTables([
      { name: '1', sql: "SELECT rls_apply_policy('tags', 'store');" },
      { name: '2', sql: "SELECT rls_drop_policy('tags');" }
    ])
    expect(covered.size).toBe(0)
  })

  it('does not read the format strings of the foundation as tables', () => {
    expect(
      coveredTables([
        {
          name: '1',
          sql: "EXECUTE format('CREATE POLICY %I ON %s AS PERMISSIVE', a, b); rls_apply_policy(tbl regclass, scope text)"
        }
      ]).size
    ).toBe(0)
  })
})

describe('checkRlsCoverage', () => {
  const tables = schemaTables(schema)
  const reason = 'because'

  it('is clean when every table is covered or has an exemption', () => {
    const report = checkRlsCoverage(
      tables,
      new Set(['tags']),
      {
        stores: { kind: 'global', reason },
        memberships: { kind: 'global', reason },
        users: { kind: 'global', reason },
        warehouses: { kind: 'pending', phase: 3, reason }
      },
      [1, 2, 3, 4]
    )
    expect(report).toEqual({ unclassified: [], stale: [], orphanPolicies: [] })
  })

  it('names a table with no decision', () => {
    const report = checkRlsCoverage(tables, new Set(), {}, [1])
    expect(report.unclassified).toEqual(['memberships', 'stores', 'tags', 'users', 'warehouses'])
  })

  it('flags a pending table that already has its policy, a global one with a policy, and an entry for no table', () => {
    const report = checkRlsCoverage(
      tables,
      new Set(['tags', 'users']),
      {
        tags: { kind: 'pending', phase: 1, reason },
        users: { kind: 'global', reason },
        ghost: { kind: 'global', reason },
        stores: { kind: 'global', reason },
        memberships: { kind: 'global', reason },
        warehouses: { kind: 'pending', phase: 1, reason }
      },
      [1]
    )
    expect(report.stale).toEqual([
      'tags: has its policy, remove it from the pending list',
      'users: has a policy and is listed as global, pick one',
      'ghost: listed but not a table of the schema'
    ])
  })

  it('flags an exemption with no reason and a pending phase the plan does not have', () => {
    const report = checkRlsCoverage(
      tables,
      new Set(['tags']),
      {
        stores: { kind: 'global', reason: ' ' },
        memberships: { kind: 'global', reason },
        users: { kind: 'global', reason },
        warehouses: { kind: 'pending', phase: 9, reason }
      },
      [1, 2]
    )
    expect(report.stale).toEqual([
      'stores: the exemption has no reason',
      'warehouses: pending for phase 9, which the plan does not have'
    ])
  })

  it('reports a policy on a table the schema does not have', () => {
    expect(checkRlsCoverage([], new Set(['gone']), {}, [1]).orphanPolicies).toEqual(['gone'])
  })
})

describe('roleViolations', () => {
  it('refuses a migration that makes platform_app a bypass role or a superuser, and allows the worker', () => {
    const problems = roleViolations([
      { name: 'a', sql: 'ALTER ROLE platform_app BYPASSRLS;' },
      { name: 'b', sql: 'CREATE ROLE platform_app SUPERUSER;' },
      { name: 'c', sql: 'CREATE ROLE platform_app NOLOGIN NOSUPERUSER NOBYPASSRLS;' },
      { name: 'd', sql: 'CREATE ROLE platform_worker NOLOGIN BYPASSRLS;' },
      { name: 'e', sql: '-- ALTER ROLE platform_app BYPASSRLS;' }
    ])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('a:')
    expect(problems[1]).toContain('b:')
  })

  it('also refuses the other spellings: ALTER USER, IF EXISTS, a role granted to it, a table owned by it', () => {
    const problems = roleViolations([
      { name: 'a', sql: 'ALTER USER platform_app BYPASSRLS;' },
      { name: 'b', sql: 'ALTER ROLE IF EXISTS platform_app WITH SUPERUSER;' },
      { name: 'c', sql: 'GRANT pg_write_all_data TO platform_app;' },
      { name: 'd', sql: 'ALTER TABLE stores OWNER TO platform_app;' },
      { name: 'e', sql: 'CREATE ROLE platform_app IN ROLE platform_worker;' },
      {
        name: 'f',
        sql: 'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO platform_app, platform_worker;'
      },
      { name: 'g', sql: 'ALTER ROLE platform_app IN DATABASE x SET lock_timeout = 5000;' }
    ])
    expect(problems.map(p => p.split(':')[0])).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('sessionSettingViolations', () => {
  it('refuses a session-level setting and allows the transaction-local one', () => {
    const problems = sessionSettingViolations([
      { path: 'ok.ts', text: "SELECT set_config('app.store_ids', x, true)" },
      { path: 'bad.ts', text: "SELECT set_config('app.store_ids', x, false)" },
      { path: 'bad2.ts', text: 'SET SESSION app.store_ids = 1' }
    ])
    expect(problems.map(p => p.split(':')[0])).toEqual(['bad.ts', 'bad2.ts'])
  })

  it('reads the arguments of set_config as they are written: nested calls, casts, a bare SET, a variable as the last argument', () => {
    const problems = sessionSettingViolations([
      { path: 'nested.ts', text: "SELECT set_config('app.store_ids', lower(id), false)" },
      { path: 'cast.ts', text: "SELECT set_config('app.store_ids', ($1)::text, false)" },
      { path: 'bare.ts', text: "SET app.store_ids = 'x'" },
      { path: 'variable.ts', text: "SELECT set_config('app.store_ids', $1, $2)" },
      { path: 'okNested.ts', text: "SELECT set_config('app.store_ids', lower(id), true)" },
      { path: 'okLocal.ts', text: "SET LOCAL app.store_ids = 'x'" },
      { path: 'okComment.ts', text: '// set_config(..., true) in a comment' }
    ])
    expect(problems.map(p => p.split(':')[0])).toEqual([
      'nested.ts',
      'cast.ts',
      'bare.ts',
      'variable.ts'
    ])
  })
})

describe('scopeMismatches', () => {
  const tables = schemaTables(schema)
  it('accepts the scope that fits the columns and names the one that does not', () => {
    const problems = scopeMismatches(tables, [
      {
        name: 'a',
        sql: "SELECT rls_apply_policy('tags', 'store'); SELECT rls_apply_policy('warehouses', 'organization');"
      },
      { name: 'b', sql: "SELECT rls_apply_policy('warehouses', 'store');" },
      { name: 'c', sql: "SELECT rls_apply_policy('tags', 'organization');" },
      { name: 'd', sql: "SELECT rls_apply_policy('users', 'store');" },
      { name: 'e', sql: "SELECT rls_apply_policy('memberships', 'store_or_organization');" }
    ])
    expect(problems.map(p => p.split(':')[0])).toEqual(['b', 'c', 'd'])
  })
})

describe('schemaTables, comments', () => {
  it('does not cut a line at a // inside a string', () => {
    const [table] = schemaTables(`model Hook {
  url     String @default("https://example.test/") @map("store_id")
  @@map("hooks")
}`)
    expect(table?.scope).toBe('store')
  })
})
