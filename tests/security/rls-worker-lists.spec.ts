import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { CarrierConnectionStatus, PickupStatus } from '@platform/core/domain'

import { createCarrierConnection } from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Row-Level Security, phase 5 (migration 20270121800000_rls_worker_lists): the lists that a scheduler of the worker walks. The role of
// the worker is going to lose BYPASSRLS, so each list is a SECURITY DEFINER function. What is proved, under the role of the worker with
// row security ON for the tables (one transaction of the owner, always ROLLBACK, so no other suite sees a table enforced): a plain
// query with no context sees no row, the function still returns the rows of every store, it returns ids and nothing else, the api role
// cannot call it, and a page that would cut the list in silence is refused.

const FUNCTIONS = [
  'rls_list_enabled_scheduled_reports(text, integer)',
  'rls_list_shipment_poll_targets(text, text[], text, text, integer)',
  'rls_list_benefit_close_targets(text, text, integer)',
  'rls_list_pickup_targets(text, text, integer)',
  'rls_list_pickups_pending_stale(text, timestamp, date, integer)',
  'rls_list_pickups_count_behind(text[], date, timestamp, integer)',
  'rls_list_active_channel_connections(text[], text, text, text, integer)',
  'rls_list_users_with_pending_email(text, integer)'
] as const

describe('row-level security, phase 5: the lists of the worker', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: urls.owner })
  const stores: string[] = []
  const pickups: string[] = []

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    for (const side of ['a', 'b']) {
      const store = await ensureStore(owner, org.id, `${prefix}-store-${side}`)
      stores.push(store.id)
      const carrier = await createCarrierConnection(owner, { storeId: store.id })
      await owner.carrierConnection.update({
        where: { id: carrier.id },
        data: { pickupEnabled: true }
      })
      pickups.push(carrier.id)
    }
  })

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  })

  const asWorker = <T>(work: (query: pg.Client['query']) => Promise<T>): Promise<T> =>
    asRole('platform_worker', work)

  // One transaction: row security on for the tables of the lists, the role of the worker, NO context, the work, ROLLBACK
  async function asRole<T>(
    role: 'platform_app' | 'platform_worker',
    work: (query: pg.Client['query']) => Promise<T>
  ): Promise<T> {
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      for (const table of [
        'carrier_connections',
        'channel_connections',
        'notifications',
        'pickup_requests'
      ]) {
        await raw.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      }
      await raw.query(`SET LOCAL ROLE ${role}`)
      return await work(raw.query.bind(raw))
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined)
    }
  }

  it('hides the rows from the role of the api with no context, and the list still returns every store to the worker', async () => {
    // The worker still has BYPASSRLS (it loses it in the last PR of the phase), so "no row" is shown with the role of the api, which
    // has none; the list is read as the worker, which is the only role that may call it
    await asRole('platform_app', async query => {
      const plain = await query('SELECT id FROM carrier_connections WHERE id = ANY ($1)', [pickups])
      expect(plain.rows).toHaveLength(0)
    })
    await asWorker(async query => {
      const listed = await query(
        'SELECT id, store_id FROM rls_list_pickup_targets($1, NULL, 1000)',
        [CarrierConnectionStatus.ACTIVE]
      )
      const mine = listed.rows.filter((row: { id: string }) => pickups.includes(row.id))
      expect(mine.map((row: { store_id: string }) => row.store_id).sort()).toEqual(
        [...stores].sort()
      )
    })
  })

  it('keeps one store for each connection of the shipment list, which its paging by connection relies on', async () => {
    // rls_list_shipment_poll_targets pages by connection_id and returns (connection_id, store_id): a connection with two stores would
    // lose the second at a page boundary. The invariant is that a shipment takes the store of its connection (trigger of shipments).
    const result = await raw.query(
      `SELECT count(*)::int AS n FROM (SELECT s.connection_id FROM shipments s GROUP BY s.connection_id HAVING count(DISTINCT s.store_id) > 1) x`
    )
    expect((result.rows[0] as { n: number }).n).toBe(0)
  })

  it('walks a list page by page with no row twice or skipped', async () => {
    await asWorker(async query => {
      const seen: string[] = []
      let after: string | null = null
      for (let guard = 0; guard < 10_000; guard += 1) {
        const page: { rows: { id: string }[] } = await query(
          'SELECT id FROM rls_list_pickup_targets($1, $2, 1)',
          [CarrierConnectionStatus.ACTIVE, after]
        )
        const row = page.rows[0]
        if (row === undefined) break
        seen.push(row.id)
        after = row.id
      }
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen).toEqual(expect.arrayContaining(pickups))
      expect([...seen].sort()).toEqual(seen)
    })
  })

  it('lists the pickups of the sweep of every store, oldest first, and refuses a missing filter', async () => {
    const old = new Date('2031-01-06T10:00:00.000Z')
    const day = new Date('2031-01-06T00:00:00.000Z')
    const made: { stuck: string[]; behind: string[] } = { stuck: [], behind: [] }
    for (const [index, storeId] of stores.entries()) {
      const connectionId = pickups[index] ?? ''
      const stuck = await owner.pickupRequest.create({
        data: {
          storeId,
          connectionId,
          pickupDate: day,
          status: PickupStatus.PENDING,
          packageCount: 1,
          requestedBy: 'system',
          createdAt: old
        }
      })
      const behind = await owner.pickupRequest.create({
        data: {
          storeId,
          connectionId,
          pickupDate: day,
          status: PickupStatus.REQUESTED,
          packageCount: 3,
          carrierPackageCount: 2,
          providerPickupId: `${prefix}-p${index}`,
          requestedBy: 'system'
        }
      })
      await owner.pickupRequest.updateMany({ where: { id: behind.id }, data: { updatedAt: old } })
      made.stuck.push(stuck.id)
      made.behind.push(behind.id)
    }
    await asWorker(async query => {
      const pending = await query(
        'SELECT id, store_id FROM rls_list_pickups_pending_stale($1, $2, $3, 1000)',
        [PickupStatus.PENDING, new Date('2031-01-06T11:00:00.000Z'), day]
      )
      const mine = pending.rows.filter((row: { id: string }) => made.stuck.includes(row.id))
      expect(mine.map((row: { store_id: string }) => row.store_id).sort()).toEqual(
        [...stores].sort()
      )
      const behind = await query(
        'SELECT id, store_id FROM rls_list_pickups_count_behind($1::text[], $2, $3, 1000)',
        [
          [PickupStatus.REQUESTED, PickupStatus.CONFIRMED],
          day,
          new Date('2031-01-06T11:00:00.000Z')
        ]
      )
      const mineBehind = behind.rows.filter((row: { id: string }) => made.behind.includes(row.id))
      expect(mineBehind.map((row: { store_id: string }) => row.store_id).sort()).toEqual(
        [...stores].sort()
      )
      await raw.query('SAVEPOINT filter')
      await expect(
        query('SELECT * FROM rls_list_pickups_pending_stale(NULL, $1, $2, 10)', [old, day])
      ).rejects.toMatchObject({ code: '22023' })
      await raw.query('ROLLBACK TO SAVEPOINT filter')
    })
  })

  it('refuses a page that is not 1 to 1000 rows, instead of cutting the list in silence', async () => {
    await asWorker(async query => {
      for (const limit of [0, -1, 1001]) {
        await raw.query('SAVEPOINT page')
        await expect(
          query('SELECT * FROM rls_list_pickup_targets($1, NULL, $2)', [
            CarrierConnectionStatus.ACTIVE,
            limit
          ])
        ).rejects.toMatchObject({ code: '22023' })
        await raw.query('ROLLBACK TO SAVEPOINT page')
      }
    })
  })

  it('is for the worker alone: the role of the api cannot call any list, and the worker can', async () => {
    for (const fn of FUNCTIONS) {
      const result = await raw.query(
        `SELECT has_function_privilege('platform_app', '${fn}', 'EXECUTE') AS app, has_function_privilege('platform_worker', '${fn}', 'EXECUTE') AS worker, has_function_privilege('public', '${fn}', 'EXECUTE') AS public`
      )
      expect(result.rows[0]).toEqual({ app: false, worker: true, public: false })
    }
  })

  it('runs as its owner with a fixed search_path that ends with pg_temp, and reads only', async () => {
    const result = await raw.query(
      `SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig FROM pg_proc p WHERE p.proname = ANY ($1)`,
      [FUNCTIONS.map(fn => fn.split('(')[0])]
    )
    expect(result.rows).toHaveLength(FUNCTIONS.length)
    for (const row of result.rows as {
      prosecdef: boolean
      provolatile: string
      proconfig: string[]
    }[]) {
      expect(row.prosecdef).toBe(true)
      expect(row.provolatile).toBe('s')
      expect(row.proconfig.join(',')).toContain('search_path=pg_catalog, public, pg_temp')
    }
  })
})
