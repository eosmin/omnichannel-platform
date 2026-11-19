import { randomUUID } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

import { AuditAction } from '@platform/core/audit'
import { RoleNames, RolePresets } from '@platform/core/auth'
import { AuditColdExport } from '@platform/core/compliance'
import { parseEncryptionKey } from '@platform/core/crypto'
import { WebhookSources } from '@platform/core/domain'

import { PrismaClient } from '../generated/client/client'
import { connectionUrls, replicaConnectionUrl } from '../testing/connection-urls'

import { bootstrapOwner, ensureSystemRoles } from './bootstrap-owner'
import { loadDevFixtures } from './dev-fixtures'
import {
  PrismaService,
  RawSqlContextRequiredError,
  TenantContextRequiredError
} from './prisma.service'
import { ProcessedWebhookEventsService } from './processed-webhook-events.service'

const urls = connectionUrls()
const runId = randomUUID().slice(0, 8)

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const AUDIT_ID = `audit-${runId}`

afterAll(async () => {
  await withClient(urls.owner, async owner => {
    await owner.query('DELETE FROM audit_logs WHERE id = $1', [AUDIT_ID])
    await owner.query('DELETE FROM organizations WHERE slug LIKE $1', [`it-${runId}%`])
  })
})

describe('database roles', () => {
  it('lets platform_app read and write ordinary tables', async () => {
    await withClient(urls.app, async app => {
      await app.query(
        'INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $3, now())',
        [randomUUID(), 'Integration', `it-${runId}-roles`]
      )
      const { rows } = await app.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM organizations WHERE slug = $1',
        [`it-${runId}-roles`]
      )
      expect(rows[0]?.n).toBe(1)
    })
  })

  it('lets platform_app append to audit_logs and read it, but not change or delete', async () => {
    await withClient(urls.app, async app => {
      await app.query("INSERT INTO audit_logs (id, action) VALUES ($1, 'integration.test')", [
        AUDIT_ID
      ])
      const { rows } = await app.query('SELECT id FROM audit_logs WHERE id = $1', [AUDIT_ID])
      expect(rows).toHaveLength(1)
      await expect(
        app.query("UPDATE audit_logs SET action = 'x' WHERE id = $1", [AUDIT_ID])
      ).rejects.toThrow(/permission denied/)
      await expect(app.query('DELETE FROM audit_logs WHERE id = $1', [AUDIT_ID])).rejects.toThrow(
        /permission denied/
      )
    })
  })

  // The audit log is append-only for the whole application: no role holds UPDATE, DELETE or TRUNCATE on it; the cold export of a
  // month it has copied deletes through purge_audit_logs() and nothing else. Until the QA review of 2026-11-16 nothing asserted the worker side, and the worker kept UPDATE. The privileges are
  // read as the owner (nothing destructive runs as an application role, so a privilege that comes back cannot empty the table), and
  // one UPDATE is tried on a row of the test, which is removed at the end whatever happens.
  it.each([
    ['platform_app', () => urls.app],
    ['platform_worker', () => urls.worker]
  ])('lets %s neither change nor empty audit_logs', async (role, url) => {
    const id = `${AUDIT_ID}-frozen-${role}`
    try {
      await withClient(urls.owner, async owner => {
        const { rows } = await owner.query<Record<string, boolean>>(
          `SELECT has_table_privilege($1, 'audit_logs', 'UPDATE') AS "update",
                  has_table_privilege($1, 'audit_logs', 'TRUNCATE') AS "truncate",
                  has_table_privilege($1, 'audit_logs', 'DELETE') AS "delete",
                  has_any_column_privilege($1, 'audit_logs', 'UPDATE') AS "columnUpdate"`,
          [role]
        )
        expect(rows).toEqual([
          { update: false, truncate: false, delete: false, columnUpdate: false }
        ])
        await owner.query("INSERT INTO audit_logs (id, action) VALUES ($1, 'integration.frozen')", [
          id
        ])
      })
      await withClient(url(), async client => {
        await expect(
          client.query("UPDATE audit_logs SET action = 'tampered' WHERE id = $1", [id])
        ).rejects.toThrow(/permission denied/)
        await expect(client.query('DELETE FROM audit_logs WHERE id = $1', [id])).rejects.toThrow(
          /permission denied/
        )
      })
      await withClient(urls.owner, async owner => {
        const { rows } = await owner.query<{ action: string }>(
          'SELECT action FROM audit_logs WHERE id = $1',
          [id]
        )
        expect(rows).toEqual([{ action: 'integration.frozen' }])
      })
    } finally {
      await withClient(urls.owner, async owner => {
        await owner.query('DELETE FROM audit_logs WHERE id = $1', [id])
      })
    }
  })

  it('refuses an UPDATE or a TRUNCATE of audit_logs to the owner too, and keeps the user_id clearing of the foreign key', async () => {
    const id = `${AUDIT_ID}-owner`
    const userId = `user-${runId}-audit`
    try {
      await withClient(urls.owner, async owner => {
        await owner.query(
          'INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, $3, now())',
          [userId, `${userId}@example.test`, 'Audit FK']
        )
        await owner.query(
          "INSERT INTO audit_logs (id, action, user_id) VALUES ($1, 'integration.owner', $2)",
          [id, userId]
        )
        await expect(
          owner.query("UPDATE audit_logs SET action = 'tampered' WHERE id = $1", [id])
        ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/)
        await expect(
          owner.query("UPDATE audit_logs SET user_id = NULL, action = 'x' WHERE id = $1", [id])
        ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/)
        // The TRUNCATE itself is not run (it would empty the log of every suite if the trigger were missing): the trigger is read
        const { rows: triggers } = await owner.query<{ tgname: string; truncate: boolean }>(
          `SELECT tgname, (tgtype & 32) <> 0 AS "truncate" FROM pg_trigger
           WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal ORDER BY tgname`
        )
        expect(triggers).toEqual([
          { tgname: 'trg_audit_logs_no_truncate', truncate: true },
          { tgname: 'trg_audit_logs_no_update', truncate: false },
          { tgname: 'trg_audit_logs_purge_entry', truncate: false }
        ])
        // And it is run, inside a transaction that is rolled back whatever happens
        await owner.query('BEGIN')
        try {
          await expect(owner.query('TRUNCATE audit_logs')).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/)
        } finally {
          await owner.query('ROLLBACK')
        }
        // A bare UPDATE that clears user_id of a person who still exists is refused too
        await expect(
          owner.query('UPDATE audit_logs SET user_id = NULL WHERE id = $1', [id])
        ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/)
        // A new id of the user follows into the entry (ON UPDATE CASCADE) and a statement of a person cannot do the same
        await owner.query('UPDATE users SET id = $2 WHERE id = $1', [userId, `${userId}-new`])
        const moved = await owner.query<{ user_id: string }>(
          'SELECT user_id FROM audit_logs WHERE id = $1',
          [id]
        )
        expect(moved.rows).toEqual([{ user_id: `${userId}-new` }])
        await owner.query('UPDATE users SET id = $2 WHERE id = $1', [`${userId}-new`, userId])
        // Deleting the person clears user_id of the entry (ON DELETE SET NULL) and nothing else
        await owner.query('DELETE FROM users WHERE id = $1', [userId])
        const { rows } = await owner.query<{ action: string; user_id: string | null }>(
          'SELECT action, user_id FROM audit_logs WHERE id = $1',
          [id]
        )
        expect(rows).toEqual([{ action: 'integration.owner', user_id: null }])
      })
    } finally {
      await withClient(urls.owner, async owner => {
        await owner.query('DELETE FROM audit_logs WHERE id = $1', [id])
        await owner.query('DELETE FROM users WHERE id = $1', [userId])
      })
    }
  })

  describe('purge_audit_logs()', () => {
    const SHA = 'a'.repeat(64)
    const KEY = `audit/${runId}/purge-test.jsonl.gz`
    const OLD = `${AUDIT_ID}-purge-old`
    const RECENT = `${AUDIT_ID}-purge-recent`
    const purge = (
      client: pg.Client,
      ids: string[],
      rows = ids.length,
      sha = SHA,
      key = KEY,
      days: number = AuditColdExport.HOT_DAYS
    ) =>
      client.query<{ n: number }>('SELECT purge_audit_logs($1::text[], $2, $3, $4, $5) AS n', [
        ids,
        key,
        sha,
        rows,
        days
      ])
    const purgeEntries = (owner: pg.Client) =>
      owner.query<{ id: string; metadata: Record<string, unknown>; action: string }>(
        `SELECT id, action, metadata FROM audit_logs WHERE action = $1 AND metadata->>'exportKey' = $2`,
        [AuditAction.AUDIT_LOG_PURGED, KEY]
      )

    beforeEach(async () => {
      await withClient(urls.owner, async owner => {
        await owner.query(
          "INSERT INTO audit_logs (id, action, timestamp) VALUES ($1, 'integration.purge', now() - interval '800 days'), ($2, 'integration.purge', now() - interval '10 days')",
          [OLD, RECENT]
        )
      })
    })

    afterEach(async () => {
      await withClient(urls.owner, async owner => {
        await owner.query('DELETE FROM audit_logs WHERE id = ANY($1::text[])', [[OLD, RECENT]])
        const entries = await purgeEntries(owner)
        await owner.query('DELETE FROM audit_logs WHERE id = ANY($1::text[])', [
          entries.rows.map(entry => entry.id)
        ])
      })
    })

    it('purges what is past the hot window, writes the entry of the purge and keeps what is inside the window', async () => {
      await withClient(urls.worker, async worker => {
        const result = await purge(worker, [OLD, RECENT], 2)
        expect(result.rows[0]?.n).toBe(1)
      })
      await withClient(urls.owner, async owner => {
        const left = await owner.query<{ id: string }>(
          'SELECT id FROM audit_logs WHERE id = ANY($1::text[])',
          [[OLD, RECENT]]
        )
        expect(left.rows).toEqual([{ id: RECENT }])
        const entries = await purgeEntries(owner)
        expect(entries.rows).toHaveLength(1)
        expect(entries.rows[0]?.metadata).toMatchObject({
          rule: AuditColdExport.PURGE_RULE,
          windowDays: AuditColdExport.HOT_DAYS,
          requested: 2,
          deleted: 1,
          exportKey: KEY,
          exportSha256: SHA,
          exportRows: 2
        })
      })
    })

    it('is idempotent: a second call deletes nothing and writes no second entry', async () => {
      await withClient(urls.worker, async worker => {
        await purge(worker, [OLD])
        const again = await purge(worker, [OLD])
        expect(again.rows[0]?.n).toBe(0)
      })
      await withClient(urls.owner, async owner => {
        expect((await purgeEntries(owner)).rows).toHaveLength(1)
      })
    })

    it('does not delete an entry inside the hot window, whatever the caller passes', async () => {
      await withClient(urls.worker, async worker => {
        const result = await purge(worker, [RECENT])
        expect(result.rows[0]?.n).toBe(0)
      })
      await withClient(urls.owner, async owner => {
        const left = await owner.query('SELECT id FROM audit_logs WHERE id = $1', [RECENT])
        expect(left.rows).toHaveLength(1)
        expect((await purgeEntries(owner)).rows).toHaveLength(0)
      })
    })

    it.each([
      ['no ids', [], 1, SHA, KEY],
      ['no key', [OLD], 1, SHA, ''],
      ['a malformed SHA-256', [OLD], 1, 'xyz', KEY],
      ['an export with fewer rows than ids', [OLD], 0, SHA, KEY]
    ] as const)('refuses %s and deletes nothing', async (_name, ids, rows, sha, key) => {
      await withClient(urls.worker, async worker => {
        await expect(purge(worker, [...ids], rows, sha, key)).rejects.toThrow(/AUDIT_PURGE_INPUT/)
      })
      await withClient(urls.owner, async owner => {
        const left = await owner.query('SELECT id FROM audit_logs WHERE id = $1', [OLD])
        expect(left.rows).toHaveLength(1)
      })
    })

    it('refuses a hot window under 730 days, so a recent entry is never reached', async () => {
      await withClient(urls.worker, async worker => {
        await expect(purge(worker, [RECENT], 1, SHA, KEY, 5)).rejects.toThrow(/AUDIT_PURGE_INPUT/)
      })
      expect(AuditColdExport.HOT_DAYS).toBeGreaterThanOrEqual(730)
    })

    it('can be called by platform_worker only: the api role has no EXECUTE', async () => {
      await withClient(urls.app, async app => {
        await expect(purge(app, [OLD])).rejects.toThrow(/permission denied/)
      })
      await withClient(urls.owner, async owner => {
        const { rows } = await owner.query<{ id: string }>(
          'SELECT id FROM audit_logs WHERE id = $1',
          [OLD]
        )
        expect(rows).toHaveLength(1)
      })
    })

    it('refuses an entry of a purge written by a role of the application', async () => {
      for (const url of [urls.app, urls.worker]) {
        await withClient(url, async client => {
          await expect(
            client.query('INSERT INTO audit_logs (id, action) VALUES ($1, $2)', [
              `${AUDIT_ID}-forged`,
              AuditAction.AUDIT_LOG_PURGED
            ])
          ).rejects.toThrow(/AUDIT_LOG_IMMUTABLE/)
        })
      }
    })

    it('has a fixed search_path, and the worker cannot delete directly', async () => {
      await withClient(urls.owner, async owner => {
        const { rows } = await owner.query<{ prosecdef: boolean; proconfig: string[] }>(
          "SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'purge_audit_logs'"
        )
        expect(rows[0]?.prosecdef).toBe(true)
        expect(rows[0]?.proconfig).toContain('search_path=pg_catalog, pg_temp')
        expect(rows[0]?.proconfig).toContain('lock_timeout=5s')
      })
      await withClient(urls.worker, async worker => {
        await expect(worker.query('DELETE FROM audit_logs WHERE id = $1', [OLD])).rejects.toThrow(
          /permission denied/
        )
      })
    })
  })

  it('makes neither role a superuser, and only the worker bypasses RLS', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query(
        "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'platform\\_%' ORDER BY rolname"
      )
      expect(rows).toEqual([
        { rolname: 'platform_app', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
        { rolname: 'platform_worker', rolsuper: false, rolbypassrls: true, rolcanlogin: true }
      ])
    })
  })
})

describe('schema shape', () => {
  it('has search_vector only on messages, customers and products', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.columns WHERE column_name = 'search_vector' ORDER BY 1"
      )
      expect(rows.map(row => row.table_name)).toEqual(['customers', 'messages', 'products'])
    })
  })

  it('names every table and column in snake_case, except Prisma implicit join tables', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'
           AND (table_name !~ '^[a-z][a-z0-9_]*$' OR column_name !~ '^[a-z][a-z0-9_]*$')`
      )
      expect(rows).toEqual([])
    })
  })

  it('enforces the CSAT range and the pending invitation uniqueness', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE conname = 'chk_csat_range' UNION ALL SELECT indexname FROM pg_indexes WHERE indexname = 'uq_invitations_pending'"
      )
      expect(rows.map(row => row.conname).sort()).toEqual([
        'chk_csat_range',
        'uq_invitations_pending'
      ])
    })
  })
})

describe('PrismaService', () => {
  const service = new PrismaService({ databaseUrl: urls.app, poolSize: 4 })

  beforeAll(() => service.onModuleInit())
  afterAll(() => service.onModuleDestroy())

  it('queries as platform_app through the driver adapter', async () => {
    const rows = await service.client.$queryRaw<{ current_user: string }[]>`SELECT current_user`
    expect(rows[0]?.current_user).toBe('platform_app')
  })

  it('answers replicaTenantRead() from the primary when there is no replica, with the context set', async () => {
    const rows = await service.replicaTenantRead(
      { storeIds: ['s-1', 's-2'], organizationIds: ['o-1'], userId: 'u-1' },
      db =>
        db.$queryRaw<{ stores: string; organizations: string; person: string }[]>`
          SELECT current_setting('app.store_ids') AS stores,
                 current_setting('app.organization_ids') AS organizations,
                 current_setting('app.user_id') AS person`
    )
    expect(rows[0]).toEqual({ stores: 's-1,s-2', organizations: 'o-1', person: 'u-1' })
  })

  it('answers replicaTenantRead() as the read only role when DATABASE_REPLICA_URL names it, and refuses a write through the handle', async () => {
    const withReplica = new PrismaService({
      databaseUrl: urls.app,
      replicaUrl: replicaConnectionUrl(),
      poolSize: 2
    })
    await withReplica.onModuleInit()
    try {
      const context = { storeIds: ['s-1'], organizationIds: ['o-1'], userId: 'u-1' }
      const read = await withReplica.replicaTenantRead(
        context,
        db => db.$queryRaw<{ who: string; stores: string }[]>`
          SELECT current_user AS who, current_setting('app.store_ids') AS stores`
      )
      expect(read[0]).toEqual({ who: 'platform_replica_ro', stores: 's-1' })
      // A read of a table the replica readers use (the rollups of the analytics) is allowed ...
      await expect(
        withReplica.replicaTenantRead(
          context,
          db => db.$queryRaw`SELECT count(*) FROM metrics_hourly WHERE false`
        )
      ).resolves.toBeDefined()
      // ... and a write through the handle is refused by the database, with no standby behind it. Here the session default of the role
      // (read only) answers first; the missing privilege is proven on a connection of its own in tests/security/rls-replica-role.spec.ts
      await expect(
        withReplica.replicaTenantRead(
          context,
          db => db.$executeRaw`UPDATE metrics_hourly SET store_id = store_id WHERE false`
        )
      ).rejects.toThrow(/read-only transaction/)
    } finally {
      await withReplica.onModuleDestroy()
    }
  })

  it('runs the callback of replicaTenantRead and of tenantTransaction on the one connection and transaction that got the context', async () => {
    type Probe = { stores: string; pid: number; txid: string }
    const context = { storeIds: ['s-77'], organizationIds: ['o-77'], userId: 'u-77' }
    // Two statements inside the callback: if the second ran on another connection or transaction (a pooler, the adapter) the pid or
    // the transaction id would differ and the transaction-local context would be missing
    const replica = await service.replicaTenantRead(context, async db => [
      ...(await db.$queryRaw<
        Probe[]
      >`SELECT current_setting('app.store_ids') AS stores, pg_backend_pid() AS pid, txid_current()::text AS txid`),
      ...(await db.$queryRaw<
        Probe[]
      >`SELECT current_setting('app.store_ids') AS stores, pg_backend_pid() AS pid, txid_current()::text AS txid`)
    ])
    expect(replica[0]?.stores).toBe('s-77')
    expect(replica[1]).toEqual(replica[0])
    const tenant = await service.tenantTransaction(context, async () => [
      ...(await service.client.$queryRaw<
        Probe[]
      >`SELECT current_setting('app.store_ids') AS stores, pg_backend_pid() AS pid, txid_current()::text AS txid`),
      ...(await service.client.$queryRaw<
        Probe[]
      >`SELECT current_setting('app.store_ids') AS stores, pg_backend_pid() AS pid, txid_current()::text AS txid`)
    ])
    expect(tenant[0]?.stores).toBe('s-77')
    expect(tenant[1]).toEqual(tenant[0])
    expect(replica[0]?.txid).not.toBe(tenant[0]?.txid)
  })

  it('refuses replicaTenantRead inside a tenant transaction (two connections of one pool)', async () => {
    const context = { storeIds: ['s-1'], organizationIds: ['o-1'] }
    await expect(
      service.tenantTransaction(context, () =>
        service.replicaTenantRead(context, () => Promise.resolve(1))
      )
    ).rejects.toThrow('replicaTenantRead inside a tenant transaction')
  })

  it('answers the person of the context through app_user_id(), and NULL when there is none', async () => {
    const rows = await service.tenantTransaction(
      { storeIds: [], organizationIds: [], userId: 'u-3' },
      () => service.client.$queryRaw<{ person: string | null }[]>`SELECT app_user_id() AS person`
    )
    expect(rows[0]?.person).toBe('u-3')
    const none = await service.tenantTransaction(
      { storeIds: [], organizationIds: [] },
      () => service.client.$queryRaw<{ person: string | null }[]>`SELECT app_user_id() AS person`
    )
    expect(none[0]?.person).toBeNull()
  })

  it('sets the tenant context in the transaction only, with the person when it is given', async () => {
    const inside = await service.tenantTransaction(
      { storeIds: ['s-9'], organizationIds: ['o-9'], userId: 'u-9' },
      async () => {
        expect(service.hasTenantContext()).toBe(true)
        expect(service.currentTenantContext()?.userId).toBe('u-9')
        return service.client.$queryRaw<{ person: string; stores: string }[]>`
          SELECT current_setting('app.user_id') AS person, current_setting('app.store_ids') AS stores`
      }
    )
    expect(inside[0]).toEqual({ person: 'u-9', stores: 's-9' })
    expect(service.hasTenantContext()).toBe(false)
    // Outside the transaction nothing is left on the pooled connection
    const after = await service.client.$queryRaw<{ stores: string | null }[]>`
      SELECT nullif(current_setting('app.store_ids', true), '') AS stores`
    expect(after[0]?.stores).toBeNull()
  })

  it('rolls a transaction back as one unit', async () => {
    const slug = `it-${runId}-rollback`
    await expect(
      service.transaction(async tx => {
        await tx.organization.create({ data: { name: 'Rolled back', slug } })
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    expect(await service.client.organization.count({ where: { slug } })).toBe(0)
  })

  it('exposes the tenant settings only inside a tenant transaction, and joins it', async () => {
    const read = async (): Promise<string | null> => {
      const rows = await service.client.$queryRaw<{ value: string | null }[]>`
        SELECT nullif(current_setting('app.store_ids', true), '') AS value`
      return rows[0]?.value ?? null
    }
    expect(await read()).toBeNull()

    const inside = await service.tenantTransaction(
      { storeIds: ['store-a', 'store-b'], organizationIds: ['org-a'] },
      async () => {
        const nested = await service.transaction(async tx => {
          const rows = await tx.$queryRaw<
            { value: string }[]
          >`SELECT current_setting('app.organization_ids', true) AS value`
          return rows[0]?.value
        })
        return { stores: await read(), organizations: nested }
      }
    )
    expect(inside).toEqual({ stores: 'store-a,store-b', organizations: 'org-a' })
    expect(await read()).toBeNull()
  })

  it('refuses to open a tenant transaction inside another one', async () => {
    const context = { storeIds: ['store-a'], organizationIds: [] }
    await expect(
      service.tenantTransaction(context, () =>
        service.tenantTransaction(context, () => Promise.resolve(1))
      )
    ).rejects.toThrow('already open')
  })

  it('rolls back a whole tenant transaction when its work throws', async () => {
    const slug = `it-${runId}-tenant`
    await expect(
      service.tenantTransaction({ storeIds: [], organizationIds: [] }, async () => {
        await service.client.organization.create({ data: { name: 'Tenant rollback', slug } })
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    expect(await service.client.organization.count({ where: { slug } })).toBe(0)
  })

  it('runs a detached tenant transaction on its own: it keeps its write when the outer one rolls back, and has its own context', async () => {
    const slug = `it-${runId}-detached`
    const read = async (): Promise<string | null> => {
      const rows = await service.client.$queryRaw<{ value: string | null }[]>`
        SELECT nullif(current_setting('app.store_ids', true), '') AS value`
      return rows[0]?.value ?? null
    }
    let inner: string | null = null
    await expect(
      service.tenantTransaction({ storeIds: ['outer'], organizationIds: [] }, async () => {
        await service.detachedTenantTransaction(
          { storeIds: ['inner'], organizationIds: [] },
          async () => {
            inner = await read()
            await service.client.organization.create({ data: { name: 'Detached', slug } })
          }
        )
        // Back in the outer transaction, with its own context
        expect(await read()).toBe('outer')
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    expect(inner).toBe('inner')
    expect(await service.client.organization.count({ where: { slug } })).toBe(1)
  })

  it('sets the catalog flag, and no tenant context, only inside a catalog transaction', async () => {
    const read = async (): Promise<{ flag: string | null; stores: string | null }> => {
      const rows = await service.client.$queryRaw<{ flag: string | null; stores: string | null }[]>`
        SELECT nullif(current_setting('app.platform_catalog', true), '') AS flag,
               nullif(current_setting('app.store_ids', true), '') AS stores`
      return rows[0] ?? { flag: null, stores: null }
    }
    expect(await read()).toEqual({ flag: null, stores: null })
    expect(await service.catalogTransaction(read)).toEqual({ flag: 'on', stores: null })
    expect(await read()).toEqual({ flag: null, stores: null })
  })

  describe('afterCommit', () => {
    const slugOf = (suffix: string): string => `it-${runId}-hook-${suffix}`

    it('runs the hook once the transaction is over, not while it runs', async () => {
      const slug = slugOf('commit')
      const seen: string[] = []

      await service.transaction(async tx => {
        await tx.organization.create({ data: { name: 'Hook', slug } })
        service.afterCommit(tx, () => {
          seen.push('hook')
        })
        expect(seen).toEqual([])
      })

      // The hook ran once the transaction was over: what it announces is stored
      expect(seen).toEqual(['hook'])
      expect(await service.client.organization.count({ where: { slug } })).toBe(1)
    })

    it('reads the change from another connection when the hook runs', async () => {
      const slug = slugOf('visible')
      let found = 0

      await service.transaction(async tx => {
        await tx.organization.create({ data: { name: 'Hook', slug } })
        service.afterCommit(tx, () => {
          void withClient(urls.owner, async owner => {
            const { rows } = await owner.query('SELECT 1 FROM organizations WHERE slug = $1', [
              slug
            ])
            found = rows.length
          })
        })
      })
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(found).toBe(1)
    })

    it('drops the hooks of a transaction that rolls back', async () => {
      const hook = jest.fn()

      await expect(
        service.transaction(tx => {
          service.afterCommit(tx, hook)
          return Promise.reject(new Error('abort'))
        })
      ).rejects.toThrow('abort')

      expect(hook).not.toHaveBeenCalled()
    })

    it('keeps the hooks in the order they were added', async () => {
      const order: string[] = []

      await service.transaction(tx => {
        service.afterCommit(tx, () => order.push('one'))
        service.afterCommit(tx, () => order.push('two'))
        return Promise.resolve()
      })

      expect(order).toEqual(['one', 'two'])
    })

    it('waits for the commit of the tenant transaction that a nested one joins', async () => {
      const order: string[] = []

      await service.tenantTransaction({ storeIds: [], organizationIds: [] }, async () => {
        await service.transaction(tx => {
          service.afterCommit(tx, () => order.push('hook'))
          return Promise.resolve()
        })
        // The inner transaction is over, the outer one is not: nothing was announced yet
        order.push('inner done')
      })

      expect(order).toEqual(['inner done', 'hook'])
    })

    it('drops the hooks of a nested transaction when the tenant transaction rolls back', async () => {
      const hook = jest.fn()

      await expect(
        service.tenantTransaction({ storeIds: [], organizationIds: [] }, async () => {
          await service.transaction(tx => {
            service.afterCommit(tx, hook)
            return Promise.resolve()
          })
          throw new Error('abort')
        })
      ).rejects.toThrow('abort')

      expect(hook).not.toHaveBeenCalled()
    })

    it('runs every hook even when one throws, and does not fail the committed transaction', async () => {
      const order: string[] = []

      await service.transaction(tx => {
        service.afterCommit(tx, () => {
          throw new Error('hook failed')
        })
        service.afterCommit(tx, () => order.push('second'))
        return Promise.resolve()
      })

      expect(order).toEqual(['second'])
    })

    it('refuses a transaction that the service did not open, instead of announcing too early', async () => {
      const hook = jest.fn()

      // eslint-disable-next-line no-restricted-syntax -- a transaction the service did not open is the case under test
      await service.client.$transaction(tx => {
        expect(() => service.afterCommit(tx, hook)).toThrow('did not open')
        return Promise.resolve()
      })

      expect(hook).not.toHaveBeenCalled()
    })

    it('drops a hook added after the transaction rolled back, and runs one added after the commit', async () => {
      const late = jest.fn()
      const afterRollback = jest.fn()
      let rolledBack: Parameters<Parameters<typeof service.transaction>[0]>[0] | undefined
      let committed: typeof rolledBack

      await expect(
        service.transaction(tx => {
          rolledBack = tx
          return Promise.reject(new Error('abort'))
        })
      ).rejects.toThrow('abort')
      await service.transaction(tx => {
        committed = tx
        return Promise.resolve()
      })
      if (rolledBack === undefined || committed === undefined) throw new Error('no transaction')

      service.afterCommit(rolledBack, afterRollback)
      service.afterCommit(committed, late)

      expect(afterRollback).not.toHaveBeenCalled()
      expect(late).toHaveBeenCalledTimes(1)
    })

    it('runs the hook at once outside a transaction', () => {
      const hook = jest.fn()

      service.afterCommit(service.client, hook)

      expect(hook).toHaveBeenCalledTimes(1)
    })
  })
})

describe('PrismaService with requireContext', () => {
  const guarded = new PrismaService({ databaseUrl: urls.app, poolSize: 4, requireContext: true })
  const open = new PrismaService({ databaseUrl: urls.app, poolSize: 2 })
  const context = { storeIds: ['s-1'], organizationIds: ['o-1'] }

  beforeAll(async () => {
    await guarded.onModuleInit()
    await open.onModuleInit()
  })
  afterAll(async () => {
    await guarded.onModuleDestroy()
    await open.onModuleDestroy()
  })

  it('throws, naming the model, for a model that is not global when there is no context', async () => {
    const error: unknown = await guarded.client.conversation.count().then(
      () => undefined,
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(TenantContextRequiredError)
    expect((error as Error).message).toContain('Conversation.count')
  })

  it('runs inside tenantTransaction, replicaTenantRead and withoutTenantContext', async () => {
    expect(
      await guarded.tenantTransaction(context, () => guarded.client.conversation.count())
    ).toBeGreaterThanOrEqual(0)
    expect(
      await guarded.replicaTenantRead(context, db => db.conversation.count())
    ).toBeGreaterThanOrEqual(0)
    expect(
      await guarded.withoutTenantContext('a lookup with no tenant yet', () =>
        guarded.client.conversation.count()
      )
    ).toBeGreaterThanOrEqual(0)
  })

  it('lets the global models through, and asks for a reason to call without a context', async () => {
    expect(await guarded.client.store.count()).toBeGreaterThanOrEqual(0)
    expect(await guarded.client.user.count()).toBeGreaterThanOrEqual(0)
    expect(() => guarded.withoutTenantContext('  ', () => Promise.resolve(1))).toThrow(
      'needs a reason'
    )
  })

  it('does nothing while the switch is off', async () => {
    expect(await open.client.conversation.count()).toBeGreaterThanOrEqual(0)
  })

  it('lets a catalog transaction query a model that is not global, even when it returns the lazy query as it is', async () => {
    expect(
      await guarded.catalogTransaction(() => guarded.client.plugin.count())
    ).toBeGreaterThanOrEqual(0)
  })

  it('throws for a raw statement that names a table with a policy when there is no context, in the four forms', async () => {
    const client = guarded.client
    await expect(client.$queryRaw`SELECT count(*) FROM conversations`).rejects.toBeInstanceOf(
      RawSqlContextRequiredError
    )
    await expect(client.$executeRaw`UPDATE messages SET id = id WHERE false`).rejects.toThrow(
      'messages'
    )
    await expect(client.$queryRawUnsafe('SELECT 1 FROM public.media')).rejects.toBeInstanceOf(
      RawSqlContextRequiredError
    )
    await expect(
      client.$executeRawUnsafe('UPDATE "orders" SET id = id WHERE false')
    ).rejects.toBeInstanceOf(RawSqlContextRequiredError)
  })

  it('lets a raw statement through inside a context, on a global table, with no table, and while the switch is off', async () => {
    expect(
      await guarded.tenantTransaction(
        context,
        () => guarded.client.$queryRaw`SELECT count(*)::int AS n FROM conversations`
      )
    ).toHaveLength(1)
    expect(
      await guarded.withoutTenantContext(
        'a lookup with no tenant yet',
        () => guarded.client.$queryRaw`SELECT count(*)::int AS n FROM conversations`
      )
    ).toHaveLength(1)
    expect(await guarded.client.$queryRaw`SELECT count(*)::int AS n FROM stores`).toHaveLength(1)
    expect(await guarded.client.$queryRaw`SELECT 1 AS one`).toHaveLength(1)
    expect(await open.client.$queryRaw`SELECT count(*)::int AS n FROM conversations`).toHaveLength(
      1
    )
  })

  it('refuses to open a catalog transaction inside a tenant transaction', () => {
    return expect(
      guarded.tenantTransaction(context, () => guarded.catalogTransaction(() => Promise.resolve(1)))
    ).rejects.toThrow('inside a tenant transaction')
  })
})

describe('ProcessedWebhookEventsService', () => {
  const prisma = new PrismaService({ databaseUrl: urls.app, poolSize: 8 })
  const events = new ProcessedWebhookEventsService(prisma)
  const eventId = (suffix: string): string => `it-${runId}-${suffix}`

  beforeAll(() => prisma.onModuleInit())
  afterAll(async () => {
    await withClient(urls.owner, owner =>
      owner.query('DELETE FROM processed_webhook_events WHERE event_id LIKE $1', [`it-${runId}-%`])
    )
    await prisma.onModuleDestroy()
  })

  it('runs the handler once and ignores the same event afterwards', async () => {
    const handler = jest.fn(() => Promise.resolve())
    const id = eventId('twice')

    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)).toBe(true)
    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)).toBe(false)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('rolls the marker back when the handler throws, so the provider retry is processed', async () => {
    const id = eventId('retry')
    await expect(
      events.runOnce(WebhookSources.RESEND, id, 'email.bounced', () =>
        Promise.reject(new Error('redis down'))
      )
    ).rejects.toThrow('redis down')

    const handler = jest.fn(() => Promise.resolve())
    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.bounced', handler)).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('runs the handler once when the same event arrives twice at the same time', async () => {
    const handler = jest.fn(() => new Promise<void>(resolve => setTimeout(resolve, 100)))
    const id = eventId('race')

    const results = await Promise.all([
      events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler),
      events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)
    ])

    expect(results.filter(ran => ran)).toHaveLength(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('keeps the same event id of two sources apart', async () => {
    const handler = jest.fn(() => Promise.resolve())
    const id = eventId('sources')
    await withClient(urls.owner, owner =>
      owner.query(
        `INSERT INTO processed_webhook_events (source, event_id, type) VALUES ('other', $1, 't')`,
        [id]
      )
    )

    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)).toBe(true)
  })
})

describe('owner bootstrap', () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urls.owner }) })
  const input = {
    ownerEmail: `owner-${runId}@example.com`,
    ownerName: 'Owner',
    organizationName: `it ${runId} bootstrap`,
    storeName: 'Tienda Principal'
  }

  afterAll(async () => {
    await prisma.membership.deleteMany({ where: { user: { email: input.ownerEmail } } })
    await prisma.user.deleteMany({ where: { email: input.ownerEmail } })
    await prisma.organization.deleteMany({
      where: { slug: { startsWith: `it-${runId}-bootstrap` } }
    })
    await prisma.$disconnect()
  })

  it('creates the owner with a working Admin membership, and running it twice duplicates nothing', async () => {
    const first = await bootstrapOwner(prisma, input)
    const second = await bootstrapOwner(prisma, input)
    expect(second).toEqual(first)

    expect(await prisma.organization.count({ where: { id: first.organizationId } })).toBe(1)
    expect(await prisma.store.count({ where: { organizationId: first.organizationId } })).toBe(1)
    expect(await prisma.storeSettings.count({ where: { storeId: first.storeId } })).toBe(1)
    expect(await prisma.retentionSettings.count({ where: { storeId: first.storeId } })).toBe(1)
    expect(await prisma.user.count({ where: { email: input.ownerEmail } })).toBe(1)

    const memberships = await prisma.membership.findMany({
      where: { userId: first.ownerId },
      include: { role: { include: { permissions: true } } }
    })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]?.status).toBe('ACTIVE')
    expect(memberships[0]?.role.name).toBe(RoleNames.ADMIN)
    expect(memberships[0]?.role.permissions).toHaveLength(RolePresets[RoleNames.ADMIN].length)
  })

  it('creates each system role once, with the permissions of its preset', async () => {
    for (const name of Object.values(RoleNames)) {
      const roles = await prisma.role.findMany({
        where: { storeId: null, name },
        include: { permissions: true }
      })
      expect(roles).toHaveLength(1)
      expect(roles[0]?.permissions).toHaveLength(RolePresets[name].length)
    }
  })

  it('verifies the owner without a password column', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: input.ownerEmail } })
    expect(user.emailVerified).toBe(true)
    expect(Object.keys(user)).not.toContain('passwordHash')
  })

  it('creates a system role once even when two runs race', async () => {
    await Promise.all([
      ensureSystemRoles(prisma),
      ensureSystemRoles(prisma),
      ensureSystemRoles(prisma)
    ])
    for (const name of Object.values(RoleNames)) {
      expect(await prisma.role.count({ where: { storeId: null, name } })).toBe(1)
    }
  })
})

describe('development fixtures', () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urls.owner }) })
  const key = parseEncryptionKey('11'.repeat(32))

  afterAll(() => prisma.$disconnect())

  it('load completely and a second run adds nothing', async () => {
    const counts = async (): Promise<number[]> => [
      await prisma.customer.count(),
      await prisma.conversation.count(),
      await prisma.message.count(),
      await prisma.product.count()
    ]
    await loadDevFixtures(prisma, key)
    const first = await counts()
    await loadDevFixtures(prisma, key)
    expect(await counts()).toEqual(first)
    const fixtureUsers = await prisma.user.count({
      where: {
        email: {
          in: [
            'admin@test.com',
            'agent@test.com',
            'viewer@test.com',
            'multi-store@test.com',
            'admin2@test.com',
            'admin3@test.com',
            'agent2@test.com',
            'viewer2@test.com',
            'admin4@test.com',
            'agent3@test.com'
          ]
        }
      }
    })
    expect(fixtureUsers).toBe(10)
  })

  it('give each spare person the role and the main store they are named for', async () => {
    await loadDevFixtures(prisma, key)
    const expected = [
      ['admin2@test.com', RoleNames.ADMIN],
      ['admin3@test.com', RoleNames.ADMIN],
      ['admin4@test.com', RoleNames.ADMIN],
      ['agent2@test.com', RoleNames.AGENT],
      ['agent3@test.com', RoleNames.AGENT],
      ['viewer2@test.com', RoleNames.VIEWER]
    ] as const
    for (const [email, role] of expected) {
      const memberships = await prisma.membership.findMany({
        where: { user: { email } },
        select: {
          status: true,
          role: { select: { name: true } },
          store: { select: { name: true } }
        }
      })
      expect(memberships).toEqual([
        { status: 'ACTIVE', role: { name: role }, store: { name: 'Main Store' } }
      ])
    }
  })
})
