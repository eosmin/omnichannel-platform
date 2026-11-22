import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

// Step 7.2-H1a (migration 20270125100000_dsr_flow): the two lookups of the PUBLIC data request flow, which run before there is a tenant
// context. `resolve_dsr_store` turns the public key a store gave to its form into the ids that open that store's context, and
// `resolve_dsr_verification` turns the hash of a mail token into the request that waits for it. Everything runs in a transaction that ends
// in ROLLBACK, as the api role with NO context: the key must resolve to exactly one store or to nothing, a token that is used, expired, of
// another kind or of a request that no longer waits opens nothing, and only the application roles may call them.

const FUNCTIONS = ['public.resolve_dsr_store(text)', 'public.resolve_dsr_verification(text)']

interface Fixture {
  store: string
  organization: string
  key: string
  request: string
  tokenHash: string
  query: pg.Client['query']
}

describe('row-level security, public data requests: resolve_dsr_store and resolve_dsr_verification', () => {
  const raw = new pg.Client({ connectionString: connectionUrls().owner })

  beforeAll(async () => {
    await raw.connect()
  })
  afterAll(async () => {
    await raw.end().catch(() => undefined)
  })

  async function withFixture<T>(
    work: (fixture: Fixture) => Promise<T>,
    options: {
      requestStatus?: string
      tokenType?: string
      expired?: boolean
      used?: boolean
      publicKey?: string | null
    } = {}
  ): Promise<T> {
    const run = randomUUID().slice(0, 8)
    const fixture = {
      organization: `org-${run}`,
      store: `store-${run}`,
      key: `dsr-key-${run}-${'k'.repeat(12)}`,
      request: `req-${run}`,
      tokenHash: `hash-${run}`
    }
    await raw.query('BEGIN')
    try {
      await raw.query(
        `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, 'fixture', $1, now())`,
        [fixture.organization]
      )
      await raw.query(
        `INSERT INTO stores (id, organization_id, name, slug, dsr_public_key, updated_at) VALUES ($1, $2, 'fixture', $1, $3, now())`,
        [
          fixture.store,
          fixture.organization,
          options.publicKey === undefined ? fixture.key : options.publicKey
        ]
      )
      await raw.query(
        `INSERT INTO data_subject_requests (id, organization_id, store_id, type, status, subject_type, deadline_at)
         VALUES ($1, $2, $3, 'access', $4, 'customer', now() + interval '30 days')`,
        [
          fixture.request,
          fixture.organization,
          fixture.store,
          options.requestStatus ?? 'pending_verification'
        ]
      )
      await raw.query(
        `INSERT INTO verification_tokens (id, type, token_hash, subject, expires_at, used_at)
         VALUES ($1, $2, $3, $4, now() + ($5)::interval, $6)`,
        [
          `tok-${run}`,
          options.tokenType ?? 'dsr_verification',
          fixture.tokenHash,
          fixture.request,
          options.expired === true ? '-1 minute' : '7 days',
          options.used === true ? new Date() : null
        ]
      )
      await raw.query('SET LOCAL ROLE platform_app')
      await raw.query(
        "SELECT set_config('app.store_ids', '', true), set_config('app.organization_ids', '', true)"
      )
      return await work({ ...fixture, query: raw.query.bind(raw) })
    } finally {
      await raw.query('ROLLBACK').catch(() => undefined)
    }
  }

  const store = (f: Fixture, key: string) =>
    f.query<{ id: string; store_id: string; organization_id: string }>(
      'SELECT * FROM resolve_dsr_store($1)',
      [key]
    )
  const verification = (f: Fixture, hash: string) =>
    f.query<{ id: string; store_id: string; organization_id: string }>(
      'SELECT * FROM resolve_dsr_verification($1)',
      [hash]
    )

  it('are definer functions granted to the api and the worker only, with the search_path fixed and pg_temp last', async () => {
    for (const name of FUNCTIONS) {
      const { rows } = await raw.query<{
        app: boolean
        worker: boolean
        pub: boolean
        definer: boolean
        config: string[]
      }>(
        `SELECT has_function_privilege('platform_app', $1::regprocedure, 'EXECUTE') AS app,
                has_function_privilege('platform_worker', $1::regprocedure, 'EXECUTE') AS worker,
                has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub,
                p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [name]
      )
      expect(rows[0]).toMatchObject({ app: true, worker: true, pub: false, definer: true })
      expect(rows[0]?.config.at(-1)).toContain('pg_temp')
    }
  })

  describe('resolve_dsr_store', () => {
    it('answers the store and its organization for the exact key, with no context', async () => {
      await withFixture(async f => {
        const { rows } = await store(f, f.key)
        expect(rows).toEqual([{ id: f.store, store_id: f.store, organization_id: f.organization }])
      })
    })

    it.each([
      ['an unknown key', (key: string) => `${key}x`],
      ['the key in another case', (key: string) => key.toUpperCase()],
      ['an empty key', () => ''],
      ['a pattern', () => '%']
    ])('answers nothing for %s', async (_name, change) => {
      await withFixture(async f => {
        expect((await store(f, change(f.key))).rows).toEqual([])
      })
    })

    it('answers nothing for a store that took no public key (NULL is not a key)', async () => {
      await withFixture(
        async f => {
          expect((await store(f, '')).rows).toEqual([])
          expect((await store(f, f.key)).rows).toEqual([])
        },
        { publicKey: null }
      )
    })
  })

  describe('resolve_dsr_verification', () => {
    it('answers the request, its store and organization for a live token, with no context', async () => {
      await withFixture(async f => {
        const { rows } = await verification(f, f.tokenHash)
        expect(rows).toEqual([
          { id: f.request, store_id: f.store, organization_id: f.organization }
        ])
      })
    })

    it('answers nothing for an unknown hash', async () => {
      await withFixture(async f => {
        expect((await verification(f, `${f.tokenHash}x`)).rows).toEqual([])
      })
    })

    it.each([
      ['a token already used', { used: true }],
      ['an expired token', { expired: true }],
      ['a token of another kind (a magic link)', { tokenType: 'magic_link' }],
      ['a request that no longer waits', { requestStatus: 'manual_review' }]
    ])('answers nothing for %s', async (_name, options) => {
      await withFixture(async f => {
        expect((await verification(f, f.tokenHash)).rows).toEqual([])
      }, options)
    })
  })
})
