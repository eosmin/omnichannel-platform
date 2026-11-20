import pg from 'pg'

import {
  connectionUrls,
  DatabaseRoles,
  rlsEnforcementRequested,
  workerRoleBoundInSuites
} from '@platform/core/database-testing'

// What the harness depends on, said once and checked against the database (TDD_01 section 3.2, layer 3). The suites seed and clean as
// the owner and call the api as platform_app; that is only a test of Row-Level Security if the owner can skip it, platform_app
// cannot, and platform_worker (the role of the sweeps and processors) skips it by design. A role that drifted (an app role that
// became a superuser, an owner that lost BYPASSRLS) would turn the isolation suites green or red for the wrong reason.
describe('the roles the suites rely on', () => {
  const owner = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    await owner.connect()
  })
  afterAll(async () => {
    await owner.end()
  })

  async function role(
    name: string
  ): Promise<{ rolsuper: boolean; rolbypassrls: boolean } | undefined> {
    const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [name]
    )
    return rows[0]
  }

  it('binds platform_app: not a superuser, no BYPASSRLS, and it owns no table', async () => {
    expect(await role(DatabaseRoles.APP)).toEqual({ rolsuper: false, rolbypassrls: false })
    const { rows } = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = $1`,
      [DatabaseRoles.APP]
    )
    expect(rows).toEqual([])
  })

  it('is not a member of a role that skips row security', async () => {
    const { rows } = await owner.query<{ rolname: string }>(
      `SELECT g.rolname FROM pg_roles me
         JOIN pg_auth_members m ON m.member = me.oid
         JOIN pg_roles g ON g.oid = m.roleid
        WHERE me.rolname = $1 AND (g.rolsuper OR g.rolbypassrls)`,
      [DatabaseRoles.APP]
    )
    expect(rows).toEqual([])
  })

  // The worker is bound exactly where its flag is on (stage E; the startup check of the worker refuses the other two states): the jobs
  // of the enforced run (WORKER_RLS_CONTEXT=true, the role without bypass) and the plain run (flag off, the role as it was created)
  it('leaves platform_worker without BYPASSRLS where its flag is on, and with it where it is off, never a superuser', async () => {
    const bound = workerRoleBoundInSuites()
    expect(await role(DatabaseRoles.WORKER)).toEqual({ rolsuper: false, rolbypassrls: !bound })
  })

  it('lets the owner of the database set up and clean the suites: a superuser or BYPASSRLS', async () => {
    const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
    // The seeds and cleanUp run as this role with no context. The policies also give the owner of a table an explicit way in
    // (the <table>_owner policy), so this holds for a role that only owns the tables too, but the suites need it for any table
    expect(rows[0]?.rolsuper === true || rows[0]?.rolbypassrls === true).toBe(true)
  })

  // Only when the run asked for enforcement (TEST_RLS_ENFORCE, the job that runs the whole suite as platform_app): the other jobs
  // keep the policies off while the phases land, so a table that is not enforced is not an error there
  const enforced = rlsEnforcementRequested() ? it : it.skip
  enforced('has every table that has a policy enabled and forced', async () => {
    const { rows } = await owner.query<{ table_name: string; enabled: boolean; forced: boolean }>(
      'SELECT table_name, enabled, forced FROM rls_status ORDER BY table_name'
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter(row => !(row.enabled && row.forced)).map(row => row.table_name)).toEqual([])
  })
})
