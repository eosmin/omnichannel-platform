import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'
import { MediaStatus } from '@platform/core/domain'

// Row-Level Security, phase 5, PR B2 (migration 20270122300000_rls_worker_cleanup_definers): the functions that the cleaners of the worker
// call for the audit log and the avatar. What is proved with one client and ROLLBACK: only the worker may call them (the api gets 42501),
// the search_path is fixed with pg_temp last, a page outside 1..1000 or a half cursor is an error and never a clamp, and the one write
// does nothing for an id that is not an avatar of nobody's store.

const FUNCTIONS = [
  'rls_audit_oldest_before(timestamp)',
  'rls_audit_count_between(timestamp, timestamp)',
  'rls_audit_logs_for_cold_export(timestamp, timestamp, timestamp, text, integer)',
  'rls_list_avatar_media(text[], timestamp, timestamp, text[], text, integer)',
  'rls_list_orphan_avatars(timestamp, text[], text[], text, integer)',
  'rls_clear_orphan_avatar(text, timestamp)',
  'rls_avatar_media_keys(text[])'
] as const

describe('row-level security, phase 5: the cleanup definers of the worker', () => {
  const raw = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    await raw.connect()
  })
  afterAll(async () => {
    await raw.end().catch(() => undefined)
  })

  async function asRole<T>(
    role: string,
    work: (query: pg.Client['query']) => Promise<T>
  ): Promise<T> {
    await raw.query('BEGIN')
    try {
      await raw.query(`SET LOCAL ROLE ${role}`)
      return await work(raw.query.bind(raw))
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined)
    }
  }

  it('grants every function to the worker alone and fixes its search_path with pg_temp last', async () => {
    for (const fn of FUNCTIONS) {
      const { rows } = await raw.query<{
        app: boolean
        worker: boolean
        pub: boolean
        config: string[]
        definer: boolean
      }>(
        `SELECT has_function_privilege('platform_app', $1::regprocedure, 'EXECUTE') AS app,
                has_function_privilege('platform_worker', $1::regprocedure, 'EXECUTE') AS worker,
                has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub,
                p.proconfig AS config, p.prosecdef AS definer
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [`public.${fn}`]
      )
      expect(rows[0]).toMatchObject({ app: false, worker: true, pub: false, definer: true })
      expect(rows[0]?.config).toEqual(['search_path=pg_catalog, public, pg_temp'])
    }
  })

  it('refuses the api role with 42501', async () => {
    await expect(
      asRole('platform_app', query =>
        query('SELECT rls_audit_oldest_before($1::timestamp)', ['2000-01-01'])
      )
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('answers an empty window and refuses a page that would cut the list or a half cursor', async () => {
    await asRole('platform_worker', async query => {
      const count = await query<{ total: string }>(
        'SELECT rls_audit_count_between($1::timestamp, $2::timestamp) AS total',
        ['1990-01-01', '1990-02-01']
      )
      expect(Number(count.rows[0]?.total)).toBe(0)
      const oldest = await query<{ oldest: Date | null }>(
        'SELECT rls_audit_oldest_before($1::timestamp) AS oldest',
        ['1990-01-01']
      )
      expect(oldest.rows[0]?.oldest).toBeNull()
    })
    for (const limit of [0, 1001]) {
      await expect(
        asRole('platform_worker', query =>
          query(
            'SELECT * FROM rls_audit_logs_for_cold_export($1::timestamp, $2::timestamp, NULL, NULL, $3::integer)',
            ['1990-01-01', '1990-02-01', limit]
          )
        )
      ).rejects.toMatchObject({ code: '22023' })
    }
    await expect(
      asRole('platform_worker', query =>
        query(
          'SELECT * FROM rls_audit_logs_for_cold_export($1::timestamp, $2::timestamp, $3::timestamp, NULL, 10)',
          ['1990-01-01', '1990-02-01', '1990-01-05']
        )
      )
    ).rejects.toMatchObject({ code: '22023' })
    await expect(
      asRole('platform_worker', query =>
        query('SELECT * FROM rls_avatar_media_keys($1::text[])', [
          Array.from({ length: 1001 }, (_, i) => String(i))
        ])
      )
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('fixes the refused states of the write to the enum of the code', async () => {
    const { rows } = await raw.query<{ src: string }>(
      "SELECT pg_get_functiondef('public.rls_clear_orphan_avatar(text, timestamp)'::regprocedure) AS src"
    )
    const literals = [...(rows[0]?.src.matchAll(/v_status IN \(([^)]*)\)/g) ?? [])].flatMap(match =>
      [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map(item => item[1])
    )
    expect([...literals].sort()).toEqual([MediaStatus.INFECTED, MediaStatus.UNSCANNABLE].sort())
  })

  it('removes nothing for an id that is no avatar, and lists avatars as ids and keys only', async () => {
    await asRole('platform_worker', async query => {
      const cleared = await query<{ key: string | null }>(
        'SELECT rls_clear_orphan_avatar($1::text, $2::timestamp) AS key',
        ['00000000-0000-0000-0000-000000000000', '2000-01-01']
      )
      expect(cleared.rows[0]?.key).toBeNull()
      const listed = await query(
        'SELECT * FROM rls_list_orphan_avatars($1::timestamp, $2::text[], NULL, NULL, 5)',
        ['1990-01-01', ['infected']]
      )
      expect(listed.fields.map(field => field.name)).toEqual(['id', 'key'])
    })
  })
})
