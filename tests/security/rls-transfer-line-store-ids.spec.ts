import pg from 'pg'

import { connectionUrls, DatabaseRoles } from '@platform/core/database-testing'

// The function that tells the stores of the lines of a transfer (migration 20270123000000): a SECURITY DEFINER read that the write
// routes of a plugin use to REFUSE a transfer that holds a line of a sibling store. What the database says of it is fixed here, so a
// later migration that widens who may call it, or loosens how it runs, fails this suite. What it answers is proved by
// tests/api/rls-plugin-transfer-writes.spec.ts.
describe('rls_transfer_line_store_ids', () => {
  const owner = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    await owner.connect()
  })
  afterAll(async () => {
    await owner.end()
  })

  it('is a definer read with a fixed search path, answers a list of ids, and only the role of the api may call it', async () => {
    const result = await owner.query<{
      definer: boolean
      volatility: string
      config: string[] | null
      returns: string
      public_exec: boolean
      app_exec: boolean
      worker_exec: boolean
      arguments: string
    }>(
      `SELECT p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
              p.prorettype::regtype::text AS returns,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('${DatabaseRoles.APP}', p.oid, 'EXECUTE') AS app_exec,
              has_function_privilege('${DatabaseRoles.WORKER}', p.oid, 'EXECUTE') AS worker_exec,
              pg_get_function_identity_arguments(p.oid) AS arguments
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rls_transfer_line_store_ids'`
    )

    expect(result.rows).toEqual([
      {
        definer: true,
        volatility: 's',
        config: ['search_path=pg_catalog, public, pg_temp'],
        returns: 'text[]',
        public_exec: false,
        app_exec: true,
        worker_exec: false,
        // One argument, the transfer: no organization and no store comes from the caller
        arguments: 'p_transfer_id text'
      }
    ])
  })

  it('is refused for a context with no organization, never answered', async () => {
    await owner.query('BEGIN')
    try {
      await owner.query(`SELECT set_config('app.organization_ids', '', true)`)
      await expect(
        owner.query(`SELECT public.rls_transfer_line_store_ids('x')`)
      ).rejects.toMatchObject({ code: '22023' })
    } finally {
      await owner.query('ROLLBACK')
    }
  })
})
