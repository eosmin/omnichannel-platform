import { randomInt, randomUUID } from 'node:crypto'

import { ApiRoutes, API_PREFIX } from '@platform/core/api'
import { MediaStatus } from '@platform/core/domain'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { type AuthTestApp, startAuthTestApp } from '../../testing/auth-test-app'

interface Reply<T = unknown> {
  status: number
  body: T
}
interface ProfileBody {
  id: string
  email: string
  name: string
  avatarMediaId: string | null
  avatarUrl: string | null
}
interface PreferencesBody {
  locale: string
  timezone: string | null
  density: string
}

const OK = 200
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const NOT_FOUND = 404

// The account routes over HTTP against the real Postgres, Redis and bucket. The cases against the
// full app (tenants, the media routes that make the avatar) are in tests/api/account.spec.ts.
describe('AccountController', () => {
  let test: AuthTestApp
  let storage: StorageService
  const keys: string[] = []

  beforeAll(async () => {
    test = await startAuthTestApp()
    storage = test.app.get(StorageService)
  })
  afterAll(async () => {
    await Promise.all(keys.map(key => storage.delete(key)))
    await test.asOwner(client =>
      client.query(`DELETE FROM media WHERE key LIKE $1`, [`users/%/avatar/%`])
    )
    await test.cleanUp()
  })

  async function call<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; token?: string } = {}
  ): Promise<Reply<T>> {
    const response = await fetch(`${test.url}${API_PREFIX}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
    const text = await response.text()
    return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T }
  }

  async function person() {
    const user = await test.createUser()
    const { accessToken } = await test.sessions.issue(user)
    return { ...user, token: accessToken }
  }

  // An avatar row of the person, with a file in the bucket when it is meant to be served
  async function avatar(userId: string, status: string, withFile = true): Promise<string> {
    const id = randomUUID()
    const key = StorageKeys.avatar(userId, id, 'me.png')
    if (withFile) {
      await storage.put(key, Buffer.from('png'), 'image/png')
      keys.push(key)
    }
    await test.asOwner(client =>
      client.query(
        `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status)
         VALUES ($1, NULL, 'avatar', $2, $3, 'me.png', 'image/png', 3, $4)`,
        [id, userId, key, status]
      )
    )
    return id
  }
  const mediaExists = (id: string): Promise<boolean> =>
    test.asOwner(
      async client => (await client.query(`SELECT 1 FROM media WHERE id = $1`, [id])).rowCount === 1
    )

  describe('without a session or an account', () => {
    it.each([
      ['GET', ApiRoutes.account.profile],
      ['PATCH', ApiRoutes.account.profile],
      ['GET', ApiRoutes.account.preferences],
      ['PATCH', ApiRoutes.account.preferences]
    ])('%s %s demands an access token', async (method, path) => {
      expect((await call(method, path, method === 'GET' ? {} : { body: {} })).status).toBe(
        UNAUTHORIZED
      )
    })

    it('answers 401 when the account is gone but the token still verifies', async () => {
      const gone = await person()
      await test.asOwner(client => client.query(`DELETE FROM users WHERE id = $1`, [gone.id]))

      const replies = await Promise.all([
        call('GET', ApiRoutes.account.profile, { token: gone.token }),
        call('PATCH', ApiRoutes.account.profile, { token: gone.token, body: { name: 'Ghost' } }),
        call('GET', ApiRoutes.account.preferences, { token: gone.token }),
        call('PATCH', ApiRoutes.account.preferences, {
          token: gone.token,
          body: { density: 'compact' }
        })
      ])

      expect(replies.map(reply => reply.status)).toEqual(Array(4).fill(UNAUTHORIZED))
    })
  })

  describe('the profile', () => {
    it('reads the name and no picture, and changes the name trimmed', async () => {
      const me = await person()

      const read = await call<ProfileBody>('GET', ApiRoutes.account.profile, { token: me.token })
      const changed = await call<ProfileBody>('PATCH', ApiRoutes.account.profile, {
        token: me.token,
        body: { name: '  Ana  ' }
      })

      expect(read.body).toEqual({
        id: me.id,
        email: me.email,
        name: 'Test User',
        avatarMediaId: null,
        avatarUrl: null
      })
      expect(changed.body).toMatchObject({ name: 'Ana', avatarMediaId: null })
    })

    it('refuses a body that names nothing, an unknown field, or a bad id', async () => {
      const me = await person()
      for (const body of [{}, { email: 'x@example.com' }, { avatarMediaId: 'nope' }]) {
        const reply = await call('PATCH', ApiRoutes.account.profile, { token: me.token, body })
        expect(reply.status).toBe(BAD_REQUEST)
      }
    })

    it('serves a picture once it is clean and re-encoded, and says nothing of one still being prepared', async () => {
      const me = await person()
      const pending = await avatar(me.id, MediaStatus.PENDING)
      const set = await call<ProfileBody>('PATCH', ApiRoutes.account.profile, {
        token: me.token,
        body: { avatarMediaId: pending }
      })
      expect(set.body).toMatchObject({ avatarMediaId: pending, avatarUrl: null })

      await test.asOwner(client =>
        client.query(`UPDATE media SET status = 'clean' WHERE id = $1`, [pending])
      )
      // Clean is not enough: the uploaded file is not served, only the one the worker re-encoded
      const scanned = await call<ProfileBody>('GET', ApiRoutes.account.profile, { token: me.token })
      expect(scanned.body).toMatchObject({ avatarMediaId: pending, avatarUrl: null })

      await test.asOwner(client =>
        client.query(`UPDATE media SET processed_at = now() WHERE id = $1`, [pending])
      )
      const clean = await call<ProfileBody>('GET', ApiRoutes.account.profile, { token: me.token })
      expect(clean.body.avatarUrl).toContain(`users/${me.id}/avatar/${pending}`)
    })

    it('reads a refused or missing picture as none', async () => {
      const me = await person()
      for (const status of [MediaStatus.INFECTED, MediaStatus.UNSCANNABLE]) {
        const id = await avatar(me.id, MediaStatus.PENDING)
        await call('PATCH', ApiRoutes.account.profile, {
          token: me.token,
          body: { avatarMediaId: id }
        })
        await test.asOwner(client =>
          client.query(`UPDATE media SET status = $2 WHERE id = $1`, [id, status])
        )
        const read = await call<ProfileBody>('GET', ApiRoutes.account.profile, { token: me.token })
        expect(read.body).toMatchObject({ avatarMediaId: null, avatarUrl: null })
      }
      // The row is gone and the pointer is left behind (the column has no foreign key)
      const lost = await avatar(me.id, MediaStatus.CLEAN, false)
      await call('PATCH', ApiRoutes.account.profile, {
        token: me.token,
        body: { avatarMediaId: lost }
      })
      await test.asOwner(client => client.query(`DELETE FROM media WHERE id = $1`, [lost]))
      const read = await call<ProfileBody>('GET', ApiRoutes.account.profile, { token: me.token })
      expect(read.body.avatarMediaId).toBeNull()
    })

    it('replaces the picture and removes the old row and file, then takes it away with null', async () => {
      const me = await person()
      const first = await avatar(me.id, MediaStatus.CLEAN)
      const second = await avatar(me.id, MediaStatus.CLEAN)
      await call('PATCH', ApiRoutes.account.profile, {
        token: me.token,
        body: { avatarMediaId: first }
      })

      await call('PATCH', ApiRoutes.account.profile, {
        token: me.token,
        body: { avatarMediaId: second }
      })
      expect(await mediaExists(first)).toBe(false)
      expect(await storage.head(StorageKeys.avatar(me.id, first, 'me.png'))).toBeNull()

      // The same picture again, or a change of name alone, removes nothing
      await call('PATCH', ApiRoutes.account.profile, {
        token: me.token,
        body: { avatarMediaId: second }
      })
      await call('PATCH', ApiRoutes.account.profile, { token: me.token, body: { name: 'Same' } })
      expect(await mediaExists(second)).toBe(true)

      const none = await call<ProfileBody>('PATCH', ApiRoutes.account.profile, {
        token: me.token,
        body: { avatarMediaId: null }
      })
      expect(none.body).toMatchObject({ avatarMediaId: null, avatarUrl: null })
      expect(await mediaExists(second)).toBe(false)
    })

    it('is a 404 for the picture of someone else, a missing id, or a file that is not an avatar', async () => {
      const me = await person()
      const other = await person()
      const theirs = await avatar(other.id, MediaStatus.CLEAN)
      const message = randomUUID()
      await test.asOwner(client =>
        client.query(
          `INSERT INTO media (id, purpose, uploaded_by, key, filename, content_type, file_size, status)
           VALUES ($1, 'message', $2, $3, 'm.png', 'image/png', 1, 'clean')`,
          [message, me.id, `users/${me.id}/avatar/${message}/m.png`]
        )
      )

      for (const id of [theirs, randomUUID(), message]) {
        const reply = await call('PATCH', ApiRoutes.account.profile, {
          token: me.token,
          body: { avatarMediaId: id }
        })
        expect(reply.status).toBe(NOT_FOUND)
      }
      const read = await call<ProfileBody>('GET', ApiRoutes.account.profile, { token: other.token })
      expect(read.body.avatarMediaId).toBeNull()
    })
  })

  describe('the preferences', () => {
    it('reads the defaults, changes what the body names and keeps the rest', async () => {
      const me = await person()
      const read = await call<PreferencesBody>('GET', ApiRoutes.account.preferences, {
        token: me.token
      })
      expect(read.body).toEqual({ locale: 'es', timezone: null, density: 'comfortable' })

      const changed = await call<PreferencesBody>('PATCH', ApiRoutes.account.preferences, {
        token: me.token,
        body: { locale: 'en', timezone: 'america/bogota' }
      })
      expect(changed.status).toBe(OK)
      expect(changed.body).toEqual({
        locale: 'en',
        timezone: 'America/Bogota',
        density: 'comfortable'
      })

      const cleared = await call<PreferencesBody>('PATCH', ApiRoutes.account.preferences, {
        token: me.token,
        body: { timezone: null, density: 'compact' }
      })
      expect(cleared.body).toEqual({ locale: 'en', timezone: null, density: 'compact' })
    })

    it('refuses nothing to change, a locale without messages, a bad timezone and a bad density', async () => {
      const me = await person()
      for (const body of [
        {},
        { locale: 'pt-BR' },
        { timezone: 'Mars/Olympus' },
        { density: 'huge' }
      ]) {
        const reply = await call('PATCH', ApiRoutes.account.preferences, { token: me.token, body })
        expect(reply.status).toBe(BAD_REQUEST)
      }
    })
  })
})
