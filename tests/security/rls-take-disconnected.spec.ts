import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import {
  ChannelConnectionStatus,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'

import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// rls_take_disconnected_connection (migration 20270122100000): the one write of the api that crosses stores. A store that connects
// an account another store let go renames the key (plugin, connection id) of that store's DISCONNECTED row so that it can have it.
// Row security is switched on INSIDE one transaction of the owner for channel_connections only, the role is platform_app and the
// transaction ends with ROLLBACK: no other suite sees the table enforced. One pg.Client for the whole spec.
describe('rls_take_disconnected_connection', () => {
  const prefix = newRunPrefix()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: connectionUrls().owner })
  const pluginId = `${prefix}-plugin`
  const store = { a: '', b: '', c: '' }
  const holder = { id: '', connectionId: `${prefix}-acct` }
  let installationA = ''

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    await owner.plugin.create({
      data: {
        id: pluginId,
        name: 'Take plugin',
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.CHANNEL,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED,
        organizationId: org.id
      }
    })
    store.a = (await ensureStore(owner, org.id, `${prefix}-store-a`)).id
    store.b = (await ensureStore(owner, org.id, `${prefix}-store-b`)).id
    // Store c has no installation of the plugin: it cannot take an account
    store.c = (await ensureStore(owner, org.id, `${prefix}-store-c`)).id
    await owner.pluginInstallation.create({
      data: { storeId: store.b, pluginId, scopes: [], status: 'active', installedBy: 'suite' }
    })
    installationA = (
      await owner.pluginInstallation.create({
        data: { storeId: store.a, pluginId, scopes: [], status: 'active', installedBy: 'suite' }
      })
    ).id
    holder.id = (
      await owner.channelConnection.create({
        data: {
          storeId: store.a,
          pluginId,
          connectionId: holder.connectionId,
          displayName: 'Account',
          credentials: Buffer.from('ciphertext-never-readable'),
          installationId: installationA
        }
      })
    ).id
  })

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.pluginInstallation.deleteMany({ where: { pluginId } })
    await owner.plugin.deleteMany({ where: { id: pluginId } })
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  })

  // The holder goes back to the state of each case before it, whatever the case before did
  async function holderIs(status: string, connectionId = holder.connectionId): Promise<void> {
    await owner.channelConnection.update({
      where: { id: holder.id },
      data: { status, connectionId, storeId: store.a }
    })
  }

  async function asApp<T>(
    stores: string[],
    work: (query: pg.Client['query']) => Promise<T>
  ): Promise<T> {
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      await raw.query('ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY')
      await raw.query('SET LOCAL ROLE platform_app')
      await raw.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', '', true), set_config('app.user_id', '', true)",
        [stores.join(',')]
      )
      return await work(raw.query.bind(raw))
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined)
    }
  }

  async function take(
    stores: string[],
    connecting: string,
    connectionId = holder.connectionId
  ): Promise<number> {
    return asApp(stores, async query => {
      const { rows } = await query<{ changed: number }>(
        'SELECT public.rls_take_disconnected_connection($1, $2, $3) AS changed',
        [connecting, pluginId, connectionId]
      )
      return rows[0]?.changed ?? -1
    })
  }

  async function holderRow(): Promise<{
    store_id: string
    connection_id: string
    status: string
    installation_id: string
  }> {
    const { rows } = await raw.query<{
      store_id: string
      connection_id: string
      status: string
      installation_id: string
    }>(
      'SELECT store_id, connection_id, status, installation_id FROM channel_connections WHERE id = $1',
      [holder.id]
    )
    const found = rows[0]
    if (found === undefined) throw new Error('the holder row is gone')
    return found
  }

  it('gives up the key of a DISCONNECTED row of another store and changes nothing else of it', async () => {
    await holderIs(ChannelConnectionStatus.DISCONNECTED)
    // The function writes inside a transaction that ROLLBACKs: the owner reads what it wrote in that same transaction
    const seen = await asApp([store.b], async query => {
      // What the function is for: under row security the role sees nothing of the row and an UPDATE of it changes nothing
      const visible = await query('SELECT 1 FROM channel_connections WHERE id = $1', [holder.id])
      expect(visible.rowCount).toBe(0)
      const blind = await query(
        'UPDATE channel_connections SET connection_id = connection_id WHERE id = $1',
        [holder.id]
      )
      expect(blind.rowCount).toBe(0)
      const changed = await query<{ changed: number }>(
        'SELECT public.rls_take_disconnected_connection($1, $2, $3) AS changed',
        [store.b, pluginId, holder.connectionId]
      )
      // The table is closed to the role; the owner's view of the same transaction is the proof
      await query('RESET ROLE')
      const row = await query<{
        store_id: string
        connection_id: string
        status: string
        installation_id: string
      }>(
        'SELECT store_id, connection_id, status, installation_id FROM channel_connections WHERE id = $1',
        [holder.id]
      )
      return { changed: changed.rows[0]?.changed, row: row.rows[0] }
    })
    expect(seen.changed).toBe(1)
    expect(seen.row).toEqual({
      store_id: store.a,
      connection_id: `${holder.connectionId}~released~${holder.id}`,
      status: ChannelConnectionStatus.DISCONNECTED,
      installation_id: installationA
    })
    // Rolled back: the case that follows starts from the row as it was
    expect((await holderRow()).connection_id).toBe(holder.connectionId)
  })

  it('does not touch an account that is ACTIVE or in ERROR, or one that does not exist', async () => {
    for (const status of [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR]) {
      await holderIs(status)
      expect(await take([store.b], store.b)).toBe(0)
      expect((await holderRow()).connection_id).toBe(holder.connectionId)
    }
    await holderIs(ChannelConnectionStatus.DISCONNECTED)
    expect(await take([store.b], store.b, `${prefix}-nobody`)).toBe(0)
  })

  it('does not take the account for the store that holds it, and takes it for another store of a context of several', async () => {
    await holderIs(ChannelConnectionStatus.DISCONNECTED)
    // Its own row is reconnected, not taken, even when the context holds more stores
    expect(await take([store.a], store.a)).toBe(0)
    expect(await take([store.a, store.b], store.a)).toBe(0)
    expect((await holderRow()).connection_id).toBe(holder.connectionId)
    // The store that connects is the parameter, and the context may hold others
    expect(await take([store.a, store.b], store.b)).toBe(1)
  })

  it('refuses a store that is not in the context, and answers 0 for a store without the plugin installed', async () => {
    await holderIs(ChannelConnectionStatus.DISCONNECTED)
    for (const stores of [[], [store.a], [store.c]]) {
      await expect(take(stores, store.b)).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('TAKE_CONTEXT_REQUIRED') as string
      })
    }
    // A context that lists a store is not an installation: store c cannot take anything
    expect(await take([store.c], store.c)).toBe(0)
    expect((await holderRow()).connection_id).toBe(holder.connectionId)
  })

  it('is a narrow definer: fixed search_path ending in pg_temp, owned by the migrations, executable only by the api, and the status is the enum', async () => {
    const { rows } = await raw.query<{
      secdef: boolean
      config: string[] | null
      owner: string
      app: boolean
      worker: boolean
      pub: boolean
      volatility: string
      source: string
      result: string
    }>(
      `SELECT p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('platform_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('platform_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              p.provolatile AS volatility, p.prosrc AS source, pg_get_function_result(p.oid) AS result
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'rls_take_disconnected_connection'`
    )
    expect(rows).toHaveLength(1)
    const fn = rows[0]
    expect(fn?.secdef).toBe(true)
    expect(fn?.config).toEqual(['search_path=pg_catalog, public, pg_temp'])
    expect(fn?.owner).not.toBe('platform_app')
    expect(fn?.owner).not.toBe('platform_worker')
    expect({ app: fn?.app, worker: fn?.worker, pub: fn?.pub }).toEqual({
      app: true,
      worker: false,
      pub: false
    })
    expect(fn?.result).toBe('integer')
    // The status the function compares with is written in it and is the one of the enum: the caller cannot choose it
    expect(fn?.source).toContain(`c.status = '${ChannelConnectionStatus.DISCONNECTED}'`)
    expect(fn?.source).not.toMatch(/p_status/)
    expect(fn?.source).toContain('c.store_id <> p_store_id')
  })
})
