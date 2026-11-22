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
    await worker.end()
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

  it.each([true, false])(
    'lets the worker role start in silence with the flag %s, and sets the gauge to zero',
    async contextOn => {
      const { check, set } = checkOf(worker, contextOn)

      await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()

      expect(set).toHaveBeenCalledWith(0)
      expect(warn).not.toHaveBeenCalled()
    }
  )
})
