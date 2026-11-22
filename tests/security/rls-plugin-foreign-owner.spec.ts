import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls, DatabaseRoles } from '@platform/core/database-testing'
import { PluginCatalogTypes, PluginPricingModels, PluginStatus } from '@platform/core/domain'

// Row-Level Security, PR B of the plugins (migration 20270123100000_rls_plugin_foreign_owner): the function that tells the registration of
// a private plugin whether an id is held by an owner that is not the caller's organization, so that no address of a manifest is fetched
// for an id the caller can never write. Everything is proved with one client inside a transaction that ends in ROLLBACK (the rows of
// the fixture never exist outside it): another organization's id and an official one answer true, the organization's own, a free id
// and a null answer false (the same false for "mine" and "free"), no context is an error, and only the api role may call it.

const FUNCTION = 'public.rls_plugin_foreign_owner(text)'

describe('row-level security, plugins: rls_plugin_foreign_owner', () => {
  const raw = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    await raw.connect()
  })
  afterAll(async () => {
    await raw.end().catch(() => undefined)
  })

  async function insertPlugin(id: string, organizationId: string | null): Promise<void> {
    await raw.query(
      `INSERT INTO plugins (id, name, author_name, author_email, type, is_official, manifest, pricing_model, status, organization_id, updated_at)
       VALUES ($1, 'fixture', 'fixture', 'fixture@example.com', $2, $3, '{}'::jsonb, $4, $5, $6, now())`,
      [
        id,
        PluginCatalogTypes.CHANNEL,
        organizationId === null,
        PluginPricingModels.FREE,
        PluginStatus.APPROVED,
        organizationId
      ]
    )
  }

  // One transaction as the owner for the fixture, then the api role with the context of one organization (or none)
  async function withFixture<T>(
    work: (fixture: {
      mine: string
      other: string
      official: string
      query: pg.Client['query']
    }) => Promise<T>,
    options: { organizations?: 'mine' | 'both' | 'none'; role?: string } = {}
  ): Promise<T> {
    const run = randomUUID().slice(0, 8)
    const mine = `org-mine-${run}`
    const other = `org-other-${run}`
    await raw.query('BEGIN')
    try {
      for (const id of [mine, other]) {
        await raw.query(
          `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, 'fixture', $1, now())`,
          [id]
        )
      }
      const ids = {
        mine: `p-mine-${run}`,
        other: `p-other-${run}`,
        official: `p-official-${run}`
      }
      await insertPlugin(ids.mine, mine)
      await insertPlugin(ids.other, other)
      await insertPlugin(ids.official, null)
      await raw.query(`SET LOCAL ROLE ${options.role ?? DatabaseRoles.APP}`)
      await raw.query(
        "SELECT set_config('app.store_ids', '', true), set_config('app.organization_ids', $1, true)",
        [
          options.organizations === 'none'
            ? ''
            : options.organizations === 'both'
              ? `${mine},${other}`
              : mine
        ]
      )
      return await work({ ...ids, query: raw.query.bind(raw) })
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined)
    }
  }

  async function foreign(query: pg.Client['query'], id: string | null): Promise<boolean> {
    const { rows } = await query<{ foreign: boolean }>(
      'SELECT public.rls_plugin_foreign_owner($1::text) AS foreign',
      [id]
    )
    return rows[0]?.foreign ?? false
  }

  it('is granted to the api alone and fixes its search_path with pg_temp last', async () => {
    const { rows } = await raw.query<{
      app: boolean
      worker: boolean
      pub: boolean
      config: string[]
      definer: boolean
    }>(
      `SELECT has_function_privilege('${DatabaseRoles.APP}', $1::regprocedure, 'EXECUTE') AS app,
              has_function_privilege('${DatabaseRoles.WORKER}', $1::regprocedure, 'EXECUTE') AS worker,
              has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub,
              p.proconfig AS config, p.prosecdef AS definer
       FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FUNCTION]
    )
    expect(rows[0]).toMatchObject({ app: true, worker: false, pub: false, definer: true })
    expect(rows[0]?.config).toEqual(['search_path=pg_catalog, public, pg_temp'])
  })

  it('answers true for the plugin of another organization and for an official one', async () => {
    await withFixture(async ({ other, official, query }) => {
      expect(await foreign(query, other)).toBe(true)
      expect(await foreign(query, official)).toBe(true)
    })
  })

  it('answers the same false for the own plugin of the organization and for an id nobody holds', async () => {
    await withFixture(async ({ mine, query }) => {
      expect(await foreign(query, mine)).toBe(false)
      expect(await foreign(query, `p-free-${randomUUID()}`)).toBe(false)
    })
  })

  it('answers false for the plugin of every organization of a context that holds several', async () => {
    await withFixture(
      async ({ mine, other, official, query }) => {
        expect(await foreign(query, mine)).toBe(false)
        expect(await foreign(query, other)).toBe(false)
        expect(await foreign(query, official)).toBe(true)
      },
      { organizations: 'both' }
    )
  })

  it('refuses a missing id and a call with no organization in the context', async () => {
    await withFixture(async ({ query }) => {
      await expect(foreign(query, null)).rejects.toMatchObject({ code: '22023' })
    })
    await withFixture(
      async ({ other, query }) => {
        await expect(foreign(query, other)).rejects.toMatchObject({ code: '22023' })
      },
      { organizations: 'none' }
    )
  })

  it('refuses the worker role with 42501', async () => {
    await withFixture(
      async ({ other, query }) => {
        await expect(foreign(query, other)).rejects.toMatchObject({ code: '42501' })
      },
      { role: DatabaseRoles.WORKER }
    )
  })
})
