import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { ApiLockTimeout, isLockTimeoutError } from '@platform/core/errors'

import { connectionUrls } from '../testing/connection-urls'

import { PrismaService } from './prisma.service'

const urls = connectionUrls()
const LOCK_HELD_MS = 15_000

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// A request that waits for a lock must give up, so the pool of the api does not fill with requests
// that wait for as long as a migration or a long write lasts. Against the real database, on a table of
// its own so that the suites that share the database are never blocked.
describe('the lock timeout of the api role', () => {
  it('is the value of the constant, and the worker role has none', async () => {
    await withClient(urls.app, async app => {
      const { rows } = await app.query<{ lock_timeout: string }>('SHOW lock_timeout')
      expect(rows[0]?.lock_timeout).toBe(ApiLockTimeout.SQL)
    })
    // The worker keeps what the server gives every role (nothing of ours), whatever that is here
    const serverDefault = await withClient(urls.owner, async owner => {
      const { rows } = await owner.query<{ lock_timeout: string }>('SHOW lock_timeout')
      return rows[0]?.lock_timeout
    })
    await withClient(urls.worker, async worker => {
      const { rows } = await worker.query<{ lock_timeout: string }>('SHOW lock_timeout')
      expect(rows[0]?.lock_timeout).toBe(serverDefault)
    })
  })

  it('is written in the migration with the same literal as the constant', () => {
    const sql = readFileSync(
      join(__dirname, '../prisma/migrations/20261113120000_api_lock_timeout/migration.sql'),
      'utf8'
    )
    expect(sql).toContain(`'${ApiLockTimeout.SQL}'`)
    expect(ApiLockTimeout.MS).toBe(5_000)
  })

  it('gives up on a lock held by another transaction, in about the time set, with an error the api knows', async () => {
    const table = `lock_probe_${randomUUID().slice(0, 8)}`
    const owner = new pg.Client({ connectionString: urls.owner })
    await owner.connect()
    await owner.query(`CREATE TABLE ${table} (id int)`)
    await owner.query(`GRANT SELECT, INSERT ON ${table} TO platform_app`)
    const prisma = new PrismaService({ databaseUrl: urls.app })
    let release: NodeJS.Timeout | undefined
    try {
      await owner.query('BEGIN')
      await owner.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)
      // Held longer than the timeout, but not for ever, so a regression ends the test instead of hanging it
      release = setTimeout(() => void owner.query('ROLLBACK'), LOCK_HELD_MS)
      const started = Date.now()
      let error: unknown

      try {
        await prisma.client.$queryRawUnsafe(`SELECT * FROM ${table}`)
      } catch (caught) {
        error = caught
      }

      const waited = Date.now() - started
      expect(error).toBeDefined()
      expect(isLockTimeoutError(error)).toBe(true)
      expect(waited).toBeGreaterThanOrEqual(ApiLockTimeout.MS - 500)
      // Well under the time the lock is held: it gave up by itself, it was not let go
      expect(waited).toBeLessThan(LOCK_HELD_MS - 1_000)
    } finally {
      if (release !== undefined) clearTimeout(release)
      await owner.query('ROLLBACK').catch(() => undefined)
      await owner.query(`DROP TABLE ${table}`)
      await owner.end()
      await prisma.onModuleDestroy()
    }
  }, 45_000)

  // The api runs every request in a tenant transaction: the error must come out of it as it went in
  it('gives up inside an interactive transaction too, and rolls it back', async () => {
    const table = `lock_probe_${randomUUID().slice(0, 8)}`
    const owner = new pg.Client({ connectionString: urls.owner })
    await owner.connect()
    await owner.query(`CREATE TABLE ${table} (id int)`)
    await owner.query(`GRANT SELECT, INSERT ON ${table} TO platform_app`)
    const prisma = new PrismaService({ databaseUrl: urls.app })
    let release: NodeJS.Timeout | undefined
    try {
      await owner.query('BEGIN')
      await owner.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)
      release = setTimeout(() => void owner.query('ROLLBACK'), LOCK_HELD_MS)
      let error: unknown

      try {
        await prisma.transaction(async tx => {
          await tx.$queryRawUnsafe(`SELECT * FROM ${table}`)
        })
      } catch (caught) {
        error = caught
      }

      expect(isLockTimeoutError(error)).toBe(true)
    } finally {
      if (release !== undefined) clearTimeout(release)
      await owner.query('ROLLBACK').catch(() => undefined)
      await owner.query(`DROP TABLE ${table}`)
      await owner.end()
      await prisma.onModuleDestroy()
    }
  }, 45_000)

  // The migration alters a role. A migrator that is not a superuser can do it for the role it created
  // (the first migration creates platform_app), and is refused for a role somebody else made and gave
  // it no admin option on: the deploy then fails with Postgres's own message, on purpose, rather than
  // leave the api without the limit. Both are proved with scratch roles that are dropped afterwards.
  describe('a migrator that is not a superuser', () => {
    const id = randomUUID().replaceAll('-', '').slice(0, 10)
    const migrator = `lockprobe_mig_${id}`
    const madeByMigrator = `lockprobe_own_${id}`
    const madeByOther = `lockprobe_other_${id}`
    const password = randomUUID()
    const alter = (role: string) =>
      `DO $$ BEGIN EXECUTE format('ALTER ROLE ${role} IN DATABASE %I SET lock_timeout = %L', current_database(), '${ApiLockTimeout.SQL}'); END $$`

    function asMigrator(): string {
      const url = new URL(urls.owner)
      url.username = migrator
      url.password = password
      return url.toString()
    }

    beforeAll(async () => {
      await withClient(urls.owner, async owner => {
        await owner.query(
          `CREATE ROLE ${migrator} LOGIN PASSWORD '${password}' NOSUPERUSER CREATEROLE`
        )
        await owner.query(`CREATE ROLE ${madeByOther} NOLOGIN`)
      })
    })

    afterAll(async () => {
      await withClient(urls.owner, async owner => {
        for (const role of [madeByMigrator, madeByOther, migrator]) {
          await owner.query(`DROP ROLE IF EXISTS ${role}`)
        }
      })
    })

    it('can set it on the role it created', async () => {
      await withClient(asMigrator(), async client => {
        await client.query(`CREATE ROLE ${madeByMigrator} NOLOGIN`)
        await expect(client.query(alter(madeByMigrator))).resolves.toBeDefined()
      })
    })

    it('is refused, loudly, for a role it has no admin option on', async () => {
      await withClient(asMigrator(), async client => {
        await expect(client.query(alter(madeByOther))).rejects.toThrow(
          'permission denied to alter role'
        )
      })
    })
  })
})
