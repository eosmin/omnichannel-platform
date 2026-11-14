import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls, poolerAdminUrl, poolerUrl } from '@platform/core/database-testing'

// What TDD_08 section 2.6 says about connection pooling, proved against the PgBouncer of
// docker-compose.yml (`pnpm test:pooler` starts nothing: the stack is up and TEST_POOLER_URL names
// it). The app of the suites in tests/api and tests/security connects through the same pooler when
// that variable is set, so these cases are about the pooler itself and the suites that run beside
// them in jest.pooler.config.cts are about what the app does through it.

const CLIENTS = 40
// What the settings of TDD_08 section 2.6 allow: default_pool_size 25, reserve_pool_size 5
const DEFAULT_POOL_SIZE = 25
const RESERVE_POOL_SIZE = 5
// Long enough for the clients to pile up behind the 25 backends, short enough to stay under the
// reserve_pool_timeout (3 s) that would open the five reserve connections
const HOLD_SECONDS = 1
const SNAPSHOT_TIMEOUT_MS = 8_000
const POLL_MS = 50

const EXPECTED_CONFIG: Record<string, string> = {
  pool_mode: 'transaction',
  max_client_conn: '1000',
  default_pool_size: '25',
  reserve_pool_size: '5',
  reserve_pool_timeout: '3',
  server_idle_timeout: '600',
  max_db_connections: '100',
  ignore_startup_parameters: 'extra_float_digits',
  auth_type: 'scram-sha-256'
}

interface PoolRow {
  database: string
  user: string
  cl_active: number
  cl_waiting: number
  sv_active: number
  sv_idle: number
  sv_used: number
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function connected(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return client
}

// The admin console speaks the simple query protocol only
async function showPools(admin: pg.Client): Promise<PoolRow[]> {
  const { rows } = await admin.query<Record<string, string | number>>('SHOW POOLS')
  return rows.map(row => ({
    database: String(row['database']),
    user: String(row['user']),
    cl_active: Number(row['cl_active']),
    cl_waiting: Number(row['cl_waiting']),
    sv_active: Number(row['sv_active']),
    sv_idle: Number(row['sv_idle']),
    sv_used: Number(row['sv_used'])
  }))
}

function poolOf(rows: PoolRow[], url: string): PoolRow | undefined {
  const target = new URL(url)
  const database = decodeURIComponent(target.pathname.slice(1))
  return rows.find(row => row.database === database && row.user === target.username)
}

describe('PgBouncer in transaction mode (TDD_08 section 2.6)', () => {
  let admin: pg.Client
  const clients: pg.Client[] = []
  const appUrl = connectionUrls().app

  beforeAll(async () => {
    if (poolerUrl() === undefined) {
      throw new Error('TEST_POOLER_URL is required: this suite is about the pooler (see CLAUDE.md)')
    }
    admin = await connected(poolerAdminUrl())
  })

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.end().catch(() => undefined)))
  })

  afterAll(async () => {
    await admin.end()
  })

  async function client(): Promise<pg.Client> {
    const opened = await connected(appUrl)
    clients.push(opened)
    return opened
  }

  it('runs with the settings of the TDD', async () => {
    const { rows } = await admin.query<{ key: string; value: string }>('SHOW CONFIG')
    const actual = Object.fromEntries(rows.map(row => [row.key, String(row.value)]))
    for (const [key, expected] of Object.entries(EXPECTED_CONFIG)) {
      expect({ key, value: actual[key] }).toEqual({ key, value: expected })
    }
  })

  it('carries the traffic of the api role: its pool is listed under the role and the database', async () => {
    const one = await client()
    await one.query('SELECT 1')
    const pool = poolOf(await showPools(admin), appUrl)
    expect(pool).toBeDefined()
  })

  it('lets many clients share few backends', async () => {
    const group = await Promise.all(Array.from({ length: CLIENTS }, () => client()))
    const running = group.map(async member => {
      // One transaction per client, held for a while: the pid says which backend served it
      await member.query('BEGIN')
      const { rows } = await member.query<{ pid: number }>(
        `SELECT pg_backend_pid()::int AS pid, pg_sleep(${HOLD_SECONDS})`
      )
      await member.query('COMMIT')
      return rows[0]?.pid ?? 0
    })

    // While they run, SHOW POOLS says that more clients are in the pool than backends serve them,
    // and that some wait for a backend: transaction pooling, not one backend per client
    let snapshot: PoolRow | undefined
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const pool = poolOf(await showPools(admin), appUrl)
      if (pool !== undefined && pool.cl_waiting > 0) {
        snapshot = pool
        break
      }
      await sleep(POLL_MS)
    }
    const pids = await Promise.all(running)

    expect(snapshot).toBeDefined()
    expect(snapshot?.cl_active).toBeGreaterThan(0)
    expect((snapshot?.cl_active ?? 0) + (snapshot?.cl_waiting ?? 0)).toBe(CLIENTS)
    const backends =
      (snapshot?.sv_active ?? 0) + (snapshot?.sv_idle ?? 0) + (snapshot?.sv_used ?? 0)
    expect(backends).toBeLessThanOrEqual(DEFAULT_POOL_SIZE + RESERVE_POOL_SIZE)
    expect(backends).toBeLessThan(CLIENTS)

    const distinct = new Set(pids)
    expect(pids).toHaveLength(CLIENTS)
    expect(distinct.size).toBeLessThanOrEqual(DEFAULT_POOL_SIZE + RESERVE_POOL_SIZE)
    expect(distinct.size).toBeLessThan(CLIENTS)
  })

  it('does not let a transaction-local setting (SET LOCAL, set_config) reach the next client', async () => {
    const setter = await client()
    await setter.query('BEGIN')
    await setter.query("SELECT set_config('app.store_ids', 'a-store', true)")
    const inside = await setter.query<{ value: string | null }>(
      "SELECT current_setting('app.store_ids', true) AS value"
    )
    expect(inside.rows[0]?.value).toBe('a-store')
    await setter.query('COMMIT')

    // The same client (it may be handed the same backend) and a crowd of others
    const readers = [setter, ...(await Promise.all(Array.from({ length: 24 }, () => client())))]
    const values = await Promise.all(
      readers.map(async reader => {
        const { rows } = await reader.query<{ value: string | null }>(
          "SELECT current_setting('app.store_ids', true) AS value"
        )
        return rows[0]?.value ?? ''
      })
    )
    expect(values.filter(value => value !== '')).toEqual([])
  })

  it('keeps an advisory lock of a transaction until it ends, for clients on other backends', async () => {
    // A key of this run: the lock is on the number, never on a row
    const key = `pooler-${randomUUID()}`
    const holder = await client()
    const waiter = await client()
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])

    await waiter.query('BEGIN')
    const refused = await waiter.query<{ got: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got',
      [key]
    )
    expect(refused.rows[0]?.got).toBe(false)
    await waiter.query('ROLLBACK')

    await holder.query('COMMIT')
    await waiter.query('BEGIN')
    const granted = await waiter.query<{ got: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got',
      [key]
    )
    expect(granted.rows[0]?.got).toBe(true)
    await waiter.query('COMMIT')
  })
})
