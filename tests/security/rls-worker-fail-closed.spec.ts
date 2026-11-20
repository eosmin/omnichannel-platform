import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { assertSeesEveryRow, JobContextError, PrismaService } from '@platform/core/database'
import { connectionUrls, workerRoleBoundInSuites } from '@platform/core/database-testing'

// The worker with row security ON (RLS phase 0b). A sweep that decides by what it does not find must refuse to run when row security
// hides rows from it: "no row" would then mean "a row I may not see", and the sweep would delete what it should keep. The probe table
// gets the policy the real tables get and is enforced alone (rls_set_enforcement with `only`), as in rls-isolation.spec.ts.
// platform_worker still skips row security until the last phase; platform_app never does, and it is the role that stands for the
// worker once the skip is gone.
describe('the worker fails closed when row security hides rows', () => {
  const table = `rls_probe_w_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  const urls = connectionUrls()
  const owner = new pg.Client({ connectionString: urls.owner })
  const asApp = new PrismaService({ databaseUrl: urls.app })
  const asWorker = new PrismaService({ databaseUrl: urls.worker })

  beforeAll(async () => {
    await owner.connect()
    await owner.query(`CREATE TABLE ${table} (id text PRIMARY KEY, store_id text NOT NULL)`)
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO platform_app, platform_worker`
    )
    await owner.query('SELECT rls_apply_policy($1::regclass, $2)', [table, 'store'])
    await owner.query(`INSERT INTO ${table} (id, store_id) VALUES ('a', 's1'), ('b', 's2')`)
    await owner.query('SELECT rls_set_enforcement(true, $1::text[])', [[table]])
    await asApp.onModuleInit()
    await asWorker.onModuleInit()
  })

  afterAll(async () => {
    await asApp.onModuleDestroy()
    await asWorker.onModuleDestroy()
    await owner.query(`DROP TABLE IF EXISTS ${table}`)
    await owner.end()
  })

  const rowsLeft = async (): Promise<number> =>
    Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n)

  it('refuses a sweep when row security applies to its connection with no context', async () => {
    await expect(assertSeesEveryRow(asApp, [table])).rejects.toBeInstanceOf(JobContextError)
  })

  // The role that skips row security sweeps; once stage E binds it (its flag on) it is refused like the api, which is the point
  it('lets the role that skips row security sweep, and refuses it once it is bound', async () => {
    const check = expect(assertSeesEveryRow(asWorker, [table]))
    if (workerRoleBoundInSuites()) {
      await check.rejects.toBeInstanceOf(JobContextError)
    } else {
      await check.resolves.toBeUndefined()
    }
  })

  it('does not delete a row when the guard refuses, even though the sweep sees an empty table', async () => {
    const orphans = await asApp.client.$queryRawUnsafe<unknown[]>(`SELECT id FROM ${table}`)
    // What the sweep would read without the guard: nothing, and "nothing" is how a row that is hidden looks like one that is gone
    expect(orphans).toEqual([])
    const sweep = async (): Promise<void> => {
      await assertSeesEveryRow(asApp, [table])
      await asApp.client.$executeRawUnsafe(`DELETE FROM ${table}`)
    }
    await expect(sweep()).rejects.toBeInstanceOf(JobContextError)
    expect(await rowsLeft()).toBe(2)
  })

  it('no longer has a function that tells the store of a file, an export or a report from its id', async () => {
    // Every job of these carries its store (or, for an avatar, its person): no role may ask which store owns an arbitrary id
    const { rows } = await owner.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname IN ('rls_store_of_media', 'rls_store_of_export', 'rls_store_of_scheduled_report')`
    )
    expect(rows).toEqual([])
  })

  it('answers the lookup of a channel connection that does not exist with no row, for both roles', async () => {
    for (const role of [asApp, asWorker]) {
      const none = randomUUID()
      expect(
        await role.client.$queryRaw<unknown[]>`
          SELECT * FROM rls_resolve_channel_connection(${none}, ${none})`
      ).toEqual([])
    }
  })

  it('returns of a channel connection its ids and statuses and nothing else', async () => {
    const [row] = await owner
      .query<{ names: string[] }>(
        "SELECT proargnames AS names FROM pg_proc WHERE proname = 'rls_resolve_channel_connection'"
      )
      .then(result => result.rows)
    expect(row?.names).toEqual([
      'p_plugin_id',
      'p_connection_id',
      'id',
      'store_id',
      'status',
      'installation_status',
      'plugin_status'
    ])
  })
})
