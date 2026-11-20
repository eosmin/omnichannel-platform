import pg from 'pg'

import { connectionUrls, DatabaseRoles } from '@platform/core/database-testing'

import {
  connectionsProblem,
  readReachedDatabases,
  readWorkerConnections
} from '../../scripts/lib/rls-worker-role'

// The two queries of `pnpm db:rls:worker-role` against a real server (E-2 debts (c) and (f)): the databases the role reaches, and the
// sessions of the role that `nobypass` refuses to leave open. The script's own file only wires them to the connection of the owner.
describe('the facts the worker-role script reads from the server', () => {
  const owner = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    await owner.connect()
  })
  afterAll(async () => {
    await owner.end()
  })

  it('lists the database of the run among the ones the worker role can connect to, and no template', async () => {
    const current = await owner.query<{ name: string }>('SELECT current_database() AS name')
    const reached = await readReachedDatabases(owner)
    expect(reached).toContain(current.rows[0]?.name)
    expect(reached).not.toContain('template0')
    expect(reached).not.toContain('template1')
    expect([...reached].sort()).toEqual(reached)
  })

  it('counts the open sessions of the worker role, refuses nobypass while one is open and lets it go after it closes', async () => {
    const facts = await readWorkerConnections(owner)
    if (!facts.visible) {
      // An owner that is neither a superuser nor a member of pg_read_all_stats cannot see other sessions: the script refuses then
      expect(connectionsProblem('nobypass', facts, false)).toContain('pg_read_all_stats')
      return
    }
    const worker = new pg.Client({ connectionString: connectionUrls().worker })
    await worker.connect()
    try {
      const open = await readWorkerConnections(owner)
      const total = open.connections.reduce((sum, row) => sum + row.count, 0)
      expect(total).toBeGreaterThanOrEqual(1)
      expect(connectionsProblem('nobypass', open, false)).toContain(
        `of ${DatabaseRoles.WORKER} are open`
      )
      expect(connectionsProblem('nobypass', open, true)).toBeUndefined()
    } finally {
      await worker.end()
    }
  })
})
