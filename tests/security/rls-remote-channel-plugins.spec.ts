import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import {
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'

import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Row-Level Security, phase 5 (migration 20270122800000_rls_remote_channel_plugins): RemoteChannelSync, which the api AND the worker run,
// reads every remote channel plugin that has an active installation, across stores, with no context. With row security on for
// plugin_installations a plain query sees nothing, and the registry would drop every adapter as if nobody had it installed, so the read
// is a SECURITY DEFINER function. Proved here under the role of each process, with row security ON (one transaction of the owner, always
// ROLLBACK, so no other suite sees a table enforced): a plain query with no context sees no row, the function returns the rows of every
// store, only what the registry registers (private, approved, a channel, an ACTIVE installation), a page is walked with no row twice or
// skipped, a page that would cut the list in silence and a missing filter are refused, and PUBLIC cannot call it.

const FUNCTION = 'rls_list_remote_channel_plugins(text, text, text, text, integer)'
const LIST = `SELECT id, manifest, store_ids FROM rls_list_remote_channel_plugins($1, $2, $3, $4, $5)`

interface Listed {
  id: string
  manifest: unknown
  store_ids: string[]
}

describe('row-level security, phase 5: the list of remote channel plugins', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: urls.owner })
  const stores: string[] = []
  const ids = {
    shared: `${prefix}-shared`,
    lonely: `${prefix}-lonely`,
    official: `${prefix}-official`,
    pending: `${prefix}-pending`,
    revoked: `${prefix}-revoked`,
    integration: `${prefix}-integration`
  }
  const wanted = [ids.lonely, ids.shared].sort()

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    for (const side of ['a', 'b']) {
      stores.push((await ensureStore(owner, org.id, `${prefix}-store-${side}`)).id)
    }
    const plugin = (id: string, extra: { type?: string; status?: string; official?: boolean }) =>
      owner.plugin.create({
        data: {
          id,
          name: id,
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: extra.type ?? PluginCatalogTypes.CHANNEL,
          isOfficial: extra.official ?? false,
          manifest: { marker: id },
          pricingModel: PluginPricingModels.FREE,
          status: extra.status ?? PluginStatus.APPROVED,
          // An official plugin belongs to no organization
          organizationId: extra.official === true ? null : org.id
        }
      })
    const install = (pluginId: string, storeId: string, status: string) =>
      owner.pluginInstallation.create({
        data: { storeId, pluginId, scopes: [], status, installedBy: 'suite' }
      })
    await plugin(ids.shared, {})
    await plugin(ids.lonely, {})
    await plugin(ids.official, { official: true })
    await plugin(ids.pending, { status: PluginStatus.SUBMITTED })
    await plugin(ids.revoked, {})
    await plugin(ids.integration, { type: PluginCatalogTypes.INTEGRATION })
    const active = PluginInstallationStatus.ACTIVE
    // The one installed by both stores, the one installed by the store B alone, and the ones the registry must not see
    await install(ids.shared, stores[0] ?? '', active)
    await install(ids.shared, stores[1] ?? '', active)
    await install(ids.lonely, stores[1] ?? '', active)
    await install(ids.official, stores[0] ?? '', active)
    await install(ids.pending, stores[0] ?? '', active)
    await install(ids.integration, stores[0] ?? '', active)
    await install(ids.revoked, stores[0] ?? '', PluginInstallationStatus.REVOKED)
  })

  afterAll(async () => {
    await owner.plugin.deleteMany({ where: { id: ids.official } })
    await cleanUp(owner, prefix)
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  })

  // One transaction: row security on for the tables of the list, the role, NO context, the work, ROLLBACK
  async function asRole<T>(
    role: 'platform_app' | 'platform_worker',
    work: (query: pg.Client['query']) => Promise<T>
  ): Promise<T> {
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      for (const table of ['plugin_installations']) {
        await raw.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      }
      await raw.query(`SET LOCAL ROLE ${role}`)
      return await work(raw.query.bind(raw))
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined)
    }
  }

  const list = async (
    query: pg.Client['query'],
    after: string | null = null,
    limit = 1000
  ): Promise<Listed[]> => {
    const result = await query(LIST, [
      PluginCatalogTypes.CHANNEL,
      PluginStatus.APPROVED,
      PluginInstallationStatus.ACTIVE,
      after,
      limit
    ])
    return result.rows as Listed[]
  }
  const mine = (rows: Listed[]): Listed[] => rows.filter(row => Object.values(ids).includes(row.id))

  for (const role of ['platform_app', 'platform_worker'] as const) {
    it(`hides the installations from ${role} with no context, and the list still returns every store`, async () => {
      await asRole(role, async query => {
        const plain = await query(
          'SELECT id FROM plugin_installations WHERE plugin_id = ANY ($1)',
          [Object.values(ids)]
        )
        // The worker still has BYPASSRLS until the last PR of the phase: the proof of "no row" is the one of the api
        if (role === 'platform_app') expect(plain.rows).toHaveLength(0)
        const rows = mine(await list(query))
        expect(rows.map(row => row.id)).toEqual(wanted)
        const byId = new Map(rows.map(row => [row.id, row]))
        expect([...(byId.get(ids.shared)?.store_ids ?? [])].sort()).toEqual([...stores].sort())
        expect(byId.get(ids.lonely)?.store_ids).toEqual([stores[1]])
        expect(byId.get(ids.lonely)?.manifest).toEqual({ marker: ids.lonely })
      })
    })
  }

  it('leaves out an official plugin, one not approved, an integration and one with no ACTIVE installation', async () => {
    await asRole('platform_app', async query => {
      const seen = mine(await list(query)).map(row => row.id)
      for (const id of [ids.official, ids.pending, ids.integration, ids.revoked]) {
        expect(seen).not.toContain(id)
      }
    })
  })

  it('walks the list page by page with no row twice or skipped', async () => {
    await asRole('platform_app', async query => {
      const seen: string[] = []
      let after: string | null = null
      for (let guard = 0; guard < 10_000; guard += 1) {
        const page: Listed[] = await list(query, after, 1)
        const row = page[0]
        if (row === undefined) break
        seen.push(row.id)
        after = row.id
      }
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen).toEqual(expect.arrayContaining(wanted))
      expect([...seen].sort()).toEqual(seen)
    })
  })

  it('refuses a page outside 1..1000 and a missing filter, with the message and not a clamp', async () => {
    await asRole('platform_app', async query => {
      for (const limit of [0, 1001, -1]) {
        await raw.query('SAVEPOINT page')
        await expect(list(query, null, limit)).rejects.toThrow(/page/i)
        await raw.query('ROLLBACK TO SAVEPOINT page')
      }
      for (const index of [0, 1, 2]) {
        const args: (string | number | null)[] = [
          PluginCatalogTypes.CHANNEL,
          PluginStatus.APPROVED,
          PluginInstallationStatus.ACTIVE,
          null,
          10
        ]
        args[index] = null
        await raw.query('SAVEPOINT filter')
        await expect(query(LIST, args)).rejects.toThrow(/required/i)
        await raw.query('ROLLBACK TO SAVEPOINT filter')
      }
    })
  })

  it('is callable by the api and the worker and by nobody else', async () => {
    const { rows } = await raw.query<{ role: string; allowed: boolean }>(
      `SELECT r AS role, has_function_privilege(r, $1, 'EXECUTE') AS allowed
       FROM unnest(ARRAY['platform_app', 'platform_worker', 'platform_readonly']::text[]) AS r
       WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`,
      [`public.${FUNCTION}`]
    )
    const allowed = Object.fromEntries(rows.map(row => [row.role, row.allowed]))
    expect(allowed['platform_app']).toBe(true)
    expect(allowed['platform_worker']).toBe(true)
    if ('platform_readonly' in allowed) expect(allowed['platform_readonly']).toBe(false)
    // Grantee 0 is PUBLIC: the REVOKE ALL FROM PUBLIC of the migration must have left no entry for it
    const publicCan = await raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
      [`public.${FUNCTION}`]
    )
    expect(publicCan.rows[0]?.n).toBe(0)
  })
})
