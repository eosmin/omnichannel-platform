import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import pg, { type ClientBase } from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

import {
  NOT_VALID_CONSTRAINTS,
  revertToNotValid,
  safeError,
  statusOf,
  validateConstraint,
  type ConstraintRef
} from '../../scripts/lib/not-valid-constraints'

// The tool that validates the CHECK constraints added NOT VALID (scripts/validate-not-valid-constraints.ts), on a table of its own
// in a schema of its own, so that nothing of the shared test database changes. Each case is its own table.
const SCHEMA = 'not_valid_constraints_spec'

const checkOf = (table: string): ConstraintRef => ({
  schema: SCHEMA,
  table,
  name: `${table}_actor_check`
})

describe('Validating the constraints added NOT VALID', () => {
  let owner: pg.Client
  let other: pg.Client

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    other = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    await other.connect()
    await owner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await owner.query(`CREATE SCHEMA ${SCHEMA}`)
  })
  afterAll(async () => {
    await owner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await owner.end()
    await other.end()
  })

  // A table with the shape of the real checks: a person or a plugin made it, never both
  async function table(name: string, rows: string): Promise<ConstraintRef> {
    await owner.query(
      `CREATE TABLE ${SCHEMA}.${name} (id serial PRIMARY KEY, created_by text, created_by_plugin_id text)`
    )
    if (rows !== '')
      await owner.query(
        `INSERT INTO ${SCHEMA}.${name} (created_by, created_by_plugin_id) VALUES ${rows}`
      )
    await owner.query(
      `ALTER TABLE ${SCHEMA}.${name} ADD CONSTRAINT ${name}_actor_check CHECK (created_by IS NULL OR created_by_plugin_id IS NULL) NOT VALID`
    )
    return checkOf(name)
  }

  it('validates a constraint that no row breaks, and skips it the second time', async () => {
    const constraint = await table('clean', `('u1', NULL), (NULL, 'p1'), (NULL, NULL)`)
    expect((await statusOf(owner, constraint)).state).toBe('not-valid')
    expect((await validateConstraint(owner, constraint)).result).toBe('validated')
    expect((await statusOf(owner, constraint)).state).toBe('valid')
    expect((await validateConstraint(owner, constraint)).result).toBe('already-valid')
  })

  it('refuses a constraint that a row breaks, counts the rows and leaves it NOT VALID', async () => {
    // The value of a violating row is a person's: it is in the DETAIL of the error of the database, and nowhere in the outcome
    const constraint = await table(
      'broken',
      `('someone@example.com', 'p1'), ('u2', 'p2'), ('u3', NULL)`
    )
    const outcome = await validateConstraint(owner, constraint)
    expect(outcome).toEqual({ ref: constraint, result: 'violated', violatingRows: 2 })
    expect(JSON.stringify(outcome)).not.toContain('someone@example.com')
    expect((await statusOf(owner, constraint)).state).toBe('not-valid')
  })

  it('still checks every new write while the constraint is NOT VALID', async () => {
    const constraint = await table('enforced', `('u1', 'p1')`)
    await expect(
      owner.query(
        `INSERT INTO ${SCHEMA}.enforced (created_by, created_by_plugin_id) VALUES ('u', 'p')`
      )
    ).rejects.toMatchObject({ code: '23514' })
    expect((await statusOf(owner, constraint)).state).toBe('not-valid')
  })

  it('does not wait for a writer, and a writer does not wait for it (it takes no lock that writes need)', async () => {
    const constraint = await table('busy', `('u1', NULL)`)
    await other.query('BEGIN')
    try {
      await other.query(`INSERT INTO ${SCHEMA}.busy (created_by) VALUES ('u2')`)
      const started = Date.now()
      expect((await validateConstraint(owner, constraint)).result).toBe('validated')
      expect(Date.now() - started).toBeLessThan(3000)
      // And the writer, with the constraint validated, goes on writing
      await other.query(`INSERT INTO ${SCHEMA}.busy (created_by_plugin_id) VALUES ('p2')`)
    } finally {
      await other.query('ROLLBACK')
    }
  })

  it('gives up on a lock it cannot get, and a second run finishes the job', async () => {
    const constraint = await table('locked', `('u1', NULL)`)
    await other.query('BEGIN')
    try {
      await other.query(`LOCK TABLE ${SCHEMA}.locked IN SHARE ROW EXCLUSIVE MODE`)
      expect((await validateConstraint(owner, constraint)).result).toBe('lock-timeout')
      expect((await statusOf(owner, constraint)).state).toBe('not-valid')
    } finally {
      await other.query('ROLLBACK')
    }
    expect((await validateConstraint(owner, constraint)).result).toBe('validated')
  }, 30_000)

  it('reports a constraint that does not exist', async () => {
    const outcome = await validateConstraint(owner, checkOf('nothing_here'))
    expect(outcome.result).toBe('missing')
  })

  it('goes back to NOT VALID with the same definition, and keeps checking writes', async () => {
    const constraint = await table('back', `('u1', NULL)`)
    await validateConstraint(owner, constraint)
    const before = await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1`,
      [constraint.name]
    )
    expect(await revertToNotValid(owner, constraint)).toBe('reverted')
    expect((await statusOf(owner, constraint)).state).toBe('not-valid')
    const after = await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1`,
      [constraint.name]
    )
    expect(after.rows[0]?.definition).toBe(`${before.rows[0]?.definition} NOT VALID`)
    await expect(
      owner.query(`INSERT INTO ${SCHEMA}.back (created_by, created_by_plugin_id) VALUES ('u', 'p')`)
    ).rejects.toMatchObject({ code: '23514' })
    expect(await revertToNotValid(owner, constraint)).toBe('already-not-valid')
    expect(await revertToNotValid(owner, checkOf('nothing_here'))).toBe('missing')
  })

  // A client that lets everything through except the statements that match
  const failing = (client: pg.Client, matches: RegExp, detail: string): ClientBase =>
    new Proxy(client, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property) as unknown
        return (sql: unknown, ...rest: unknown[]) => {
          if (typeof sql === 'string' && matches.test(sql)) {
            return Promise.reject(
              Object.assign(new Error(`failed. DETAIL: ${detail}`), { code: '23505', detail })
            )
          }
          return (target.query as (...args: unknown[]) => Promise<unknown>)(sql, ...rest)
        }
      }
    })

  it('never repeats the DETAIL of a database error that it cannot explain', async () => {
    const constraint = await table('secret', `('u1', NULL)`)
    const secret = 'Key (email)=(someone@example.com) is secret'
    await expect(
      validateConstraint(failing(owner, /VALIDATE CONSTRAINT/, secret), constraint)
    ).rejects.toThrow(/SQLSTATE 23505/)
    await validateConstraint(failing(owner, /VALIDATE CONSTRAINT/, secret), constraint).catch(
      (error: Error) => {
        expect(error.message).not.toContain('someone@example.com')
        expect(String(error.stack)).not.toContain('someone@example.com')
      }
    )
    expect(safeError(constraint, { code: '23505', detail: secret }).message).not.toContain(
      'someone@example.com'
    )
    expect(JSON.stringify(await statusOf(owner, constraint))).toContain('not-valid')
  })

  it('keeps the check in place when the ADD of a revert fails (the drop is rolled back)', async () => {
    const constraint = await table('keeps', `('u1', NULL)`)
    await validateConstraint(owner, constraint)
    await expect(
      revertToNotValid(failing(owner, /ADD CONSTRAINT/, 'x'), constraint)
    ).rejects.toThrow(/SQLSTATE/)
    expect((await statusOf(owner, constraint)).state).toBe('valid')
    await expect(
      owner.query(
        `INSERT INTO ${SCHEMA}.keeps (created_by, created_by_plugin_id) VALUES ('u', 'p')`
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('knows every constraint of the list in the migrated database', async () => {
    const states = await Promise.all(NOT_VALID_CONSTRAINTS.map(entry => statusOf(owner, entry)))
    expect(states.filter(entry => entry.state === 'missing').map(entry => entry.ref.name)).toEqual(
      []
    )
  })

  it('the command refuses to change a database that is not confirmed, before any statement', () => {
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/validate-not-valid-constraints.ts', ...args],
        {
          cwd: join(__dirname, '../..'),
          env: { DIRECT_DATABASE_URL: connectionUrls().owner },
          encoding: 'utf8'
        }
      )
    const refused = run('run')
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('Nothing changed')
    expect(run('status').status).not.toBe(2)
  }, 60_000)
})
