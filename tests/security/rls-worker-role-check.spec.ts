import { Logger } from '@nestjs/common'
import pg from 'pg'

import { connectionUrls, DatabaseRoles } from '@platform/core/database-testing'

import { WorkerRoleCheck } from '../../apps/worker/src/health/worker-role.check'

// The start check of the worker (`WorkerRoleCheck`, TDD_01 §3.2) against the real `pg_roles`: its unit spec answers the query with
// a stub, so only a real server proves that the SQL reads the attribute of the role the connection runs as, and that the flag
// WORKER_RLS_CONTEXT agrees with it. The owner of the test database skips row security; the role of the worker must not.
describe('the worker role check against pg_roles', () => {
  const owner = new pg.Client({ connectionString: connectionUrls().owner })
  const worker = new pg.Client({ connectionString: connectionUrls().worker })
  let warn: jest.SpyInstance

  // The two members the check uses of the database service: the context-free read and the tagged raw query
  const databaseOf = (client: pg.Client) =>
    ({
      withoutTenantContext: (_reason: string, work: () => Promise<unknown>) => work(),
      client: {
        $queryRaw: async (strings: TemplateStringsArray): Promise<unknown[]> =>
          (await client.query<Record<string, unknown>>(strings.join(''))).rows
      }
    }) as never

  const checkOf = (client: pg.Client, contextOn: boolean) => {
    const set = jest.fn()
    return { check: new WorkerRoleCheck(databaseOf(client), contextOn, { set } as never), set }
  }

  beforeAll(async () => {
    await owner.connect()
    await worker.connect()
  })
  afterAll(async () => {
    await worker.end().catch(() => undefined)
    await owner.end()
  })
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('runs as the roles it is meant to tell apart', async () => {
    const users = await Promise.all([
      owner.query<{ name: string }>('SELECT current_user AS name'),
      worker.query<{ name: string }>('SELECT current_user AS name')
    ])
    expect(users[1].rows[0]?.name).toBe(DatabaseRoles.WORKER)
    expect(users[0].rows[0]?.name).not.toBe(DatabaseRoles.WORKER)
  })

  it('has an owner that skips row security, the premise of the two cases below', async () => {
    const rows = await owner.query<{ bypass: boolean }>(
      'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user'
    )
    expect(rows.rows[0]?.bypass).toBe(true)
  })

  it('fails the start of a worker that connects as the owner, with the flag on, and sets the gauge to one', async () => {
    const { check, set } = checkOf(owner, true)

    await expect(check.onApplicationBootstrap()).rejects.toThrow(/BYPASSRLS/)

    expect(set).toHaveBeenCalledWith(1)
  })

  it('only warns for the same role with the flag off', async () => {
    const { check, set } = checkOf(owner, false)

    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()

    expect(set).toHaveBeenCalledWith(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // Whether the worker role skips row security depends on how the database was prepared: the expectation is read from the catalog
  it.each([true, false])(
    'reads the worker role as the database has it, with the flag %s',
    async contextOn => {
      const attributes = await owner.query<{ bypass: boolean }>(
        'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = $1',
        [DatabaseRoles.WORKER]
      )
      const bypasses = attributes.rows[0]?.bypass === true
      const { check, set } = checkOf(worker, contextOn)

      if (bypasses && contextOn) {
        await expect(check.onApplicationBootstrap()).rejects.toThrow(/BYPASSRLS/)
      } else {
        await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
      }

      expect(set).toHaveBeenCalledWith(bypasses ? 1 : 0)
      expect(warn).toHaveBeenCalledTimes(bypasses && !contextOn ? 1 : 0)
    }
  )
})
