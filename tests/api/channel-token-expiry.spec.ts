import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { ChannelTokenExpiryService } from '@platform/channels/connections'
import { MetaGraphClient } from '@platform/channels/meta'
import { ApiRoutes } from '@platform/core/api'
import { CredentialCipher } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChannelConnectionStatus,
  type TokenExpiryView,
  type TokenInfo,
  type TokenInspection,
  TokenKinds
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { PluginRegistry } from '@platform/plugins/runtime'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import { buildChannelPlugin, ensurePluginInstallation } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const SECRET = 'EAAB-never-stored-token'
const NEW_SECRET = 'EAAB-the-replacement-token'
const DAY_MS = 86_400_000

interface ConnectionBody {
  id: string
  tokenExpiry: TokenExpiryView
}

// What the provider says about the token of a connection, kept in its metadata and told to the people who
// set the channel up before it stops (TDD_10 section 10)
describe('The expiry of the token of a channel connection', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let registry: PluginRegistry
  let service: ChannelTokenExpiryService
  let counter = 0
  const registered: string[] = []
  const announced: { channelConnectionId: string; expiresAt: string }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(PluginRegistry, { strict: false })
    service = app.get(ChannelTokenExpiryService, { strict: false })
    app
      .get(EventEmitter2)
      .on(Events.CHANNEL_TOKEN_EXPIRING, (event: (typeof announced)[number]) =>
        announced.push(event)
      )
  })
  afterAll(async () => {
    for (const id of registered) registry.unregister(id)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    announced.length = 0
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS)
  const answer = (over: Partial<TokenInspection> = {}): TokenInspection => ({
    kind: TokenKinds.PAGE,
    isValid: true,
    expiresAt: inDays(30),
    scopes: ['pages_messaging'],
    ...over
  })

  // A plugin of its own for each test (the registry refuses an id twice); what it says about the token is
  // a function the test can change
  function register(inspect?: (token: string) => Promise<TokenInspection>) {
    counter += 1
    const id = `tok_${counter}_${randomUUID().slice(0, 6)}`
    const connectionId = `acct-${randomUUID()}`
    const plugin: ChannelPlugin = buildChannelPlugin({
      id,
      connect: input =>
        Promise.resolve({
          connectionId,
          displayName: 'Acme page',
          credentials: input.credentials,
          metadata: { region: 'sv' }
        }),
      ...(inspect === undefined
        ? {}
        : {
            inspectToken: ctx2 => inspect(String(ctx2.credentials['token']))
          })
    })
    registry.register(plugin)
    registered.push(id)
    return { id, plugin, connectionId }
  }
  async function connect(pluginId: string, token = SECRET) {
    await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId })
    return asAdmin().post(ApiRoutes.channels.connect(pluginId)).send({ credentials: { token } })
  }
  const metadataOf = async (id: string) =>
    (await owner.channelConnection.findUniqueOrThrow({ where: { id } })).metadata as Record<
      string,
      unknown
    > | null
  const infoOf = async (id: string) =>
    ((await metadataOf(id))?.['tokenInfo'] ?? null) as TokenInfo | null

  // A connection made by hand with the credentials sealed as the api seals them
  async function seeded(pluginId: string, tokenInfo?: Partial<TokenInfo>, storeId = ctx.storeA.id) {
    const installation = await ensurePluginInstallation(owner, { storeId, pluginId })
    const cipher = app.get(CredentialCipher, { strict: false })
    const row = await owner.channelConnection.create({
      data: {
        storeId,
        pluginId,
        installationId: installation.id,
        connectionId: `seed-${randomUUID()}`,
        displayName: 'seeded',
        credentials: Buffer.from(cipher.seal({ token: SECRET })),
        metadata:
          tokenInfo === undefined
            ? { region: 'sv' }
            : {
                region: 'sv',
                tokenInfo: {
                  kind: 'page',
                  isValid: true,
                  expiresAt: inDays(30).toISOString(),
                  scopes: [],
                  checkedAt: new Date().toISOString(),
                  expiryNotifiedFor: null,
                  ...tokenInfo
                }
              }
      }
    })
    return row
  }

  describe('when a connection is made', () => {
    it('asks the provider, shows the date the token stops, and keeps the token out of the metadata', async () => {
      const { id } = register(() => Promise.resolve(answer({ expiresAt: inDays(30) })))

      const response = await connect(id)

      expect(response.status).toBe(CREATED)
      const body = response.body as ConnectionBody
      expect(body.tokenExpiry).toMatchObject({ state: 'expires', kind: 'page' })
      expect(body.tokenExpiry.expiresAt).not.toBeNull()
      const metadata = await metadataOf(body.id)
      expect(metadata).toMatchObject({ region: 'sv' }) // What the plugin put there stays
      expect(JSON.stringify(metadata)).not.toContain(SECRET)
      expect(JSON.stringify(response.body)).not.toContain(SECRET)
      expect(await infoOf(body.id)).toMatchObject({
        kind: 'page',
        isValid: true,
        scopes: ['pages_messaging']
      })
    })

    it('connects anyway, and says it does not know, when the provider cannot be asked', async () => {
      const { id } = register(() => Promise.reject(new Error(`down ${SECRET}`)))

      const response = await connect(id)

      expect(response.status).toBe(CREATED)
      const body = response.body as ConnectionBody
      expect(body.tokenExpiry).toEqual({
        state: 'unknown',
        expiresAt: null,
        checkedAt: null,
        kind: 'unknown'
      })
      expect(await infoOf(body.id)).toBeNull()
      expect(JSON.stringify(await metadataOf(body.id))).not.toContain(SECRET)
    })

    it('says a token that does not expire, a user token, and a token the provider says is not valid', async () => {
      const never = register(() => Promise.resolve(answer({ expiresAt: null })))
      const user = register(() => Promise.resolve(answer({ kind: TokenKinds.USER })))
      const invalid = register(() => Promise.resolve(answer({ isValid: false })))

      const a = (await connect(never.id)).body as ConnectionBody
      const b = (await connect(user.id)).body as ConnectionBody
      const c = (await connect(invalid.id)).body as ConnectionBody

      expect(a.tokenExpiry).toMatchObject({ state: 'never', expiresAt: null })
      expect(b.tokenExpiry).toMatchObject({ state: 'expires', kind: 'user' })
      expect(c.tokenExpiry.state).toBe('invalid')
      // It is only said: the connection stays as it was
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: c.id } })).status
      ).toBe(ChannelConnectionStatus.ACTIVE)
    })

    it('does not ask a channel that cannot be asked about', async () => {
      const { id } = register()

      const body = (await connect(id)).body as ConnectionBody

      expect(body.tokenExpiry.state).toBe('unknown')
      expect(await infoOf(body.id)).toBeNull()
    })

    it('is read back by the list and by one connection', async () => {
      const { id } = register(() => Promise.resolve(answer()))
      const made = (await connect(id)).body as ConnectionBody

      const one = await asAdmin().get(ApiRoutes.channels.connectionById(made.id))
      const list = await asAdmin().get(ApiRoutes.channels.connections).query({ limit: 100 })

      expect(one.status).toBe(OK)
      expect((one.body as ConnectionBody).tokenExpiry.state).toBe('expires')
      const listed = (list.body as { data: ConnectionBody[] }).data.find(row => row.id === made.id)
      expect(listed?.tokenExpiry.state).toBe('expires')
    })
  })

  describe('when the token is replaced', () => {
    it('asks again, with the new token, and announces the new date even if the old one was announced', async () => {
      const tokens: string[] = []
      const { id } = register(token => {
        tokens.push(token)
        return Promise.resolve(answer({ expiresAt: inDays(3 + tokens.length / 10) }))
      })
      const made = (await connect(id)).body as ConnectionBody
      expect(announced).toHaveLength(1)
      expect((await infoOf(made.id))?.expiryNotifiedFor).not.toBeNull()

      const response = await asAdmin()
        .post(ApiRoutes.channels.updateToken(made.id))
        .send({ credentials: { token: NEW_SECRET } })

      expect(response.status).toBe(OK)
      expect(tokens).toEqual([SECRET, NEW_SECRET])
      expect(announced).toHaveLength(2)
      expect(announced[1]?.expiresAt).not.toBe(announced[0]?.expiresAt)
      const info = await infoOf(made.id)
      expect(info?.expiryNotifiedFor).toBe(info?.expiresAt)
      expect(JSON.stringify(await metadataOf(made.id))).not.toContain(NEW_SECRET)
    })
  })

  describe('the notice', () => {
    it('is announced once for a date within the warning time, and not for a farther one', async () => {
      // The date of a token is one date: Meta gives the same second every time it is asked
      const nearDate = inDays(3)
      const farDate = inDays(20)
      const near = register(() => Promise.resolve(answer({ expiresAt: nearDate })))
      const far = register(() => Promise.resolve(answer({ expiresAt: farDate })))
      const nearRow = await seeded(near.id)
      const farRow = await seeded(far.id)

      await service.refresh(nearRow.id, ctx.storeA.id, near.plugin)
      await service.refresh(nearRow.id, ctx.storeA.id, near.plugin)
      await service.refresh(farRow.id, ctx.storeA.id, far.plugin)

      expect(announced.map(event => event.channelConnectionId)).toEqual([nearRow.id])
    })

    it('is claimed by one of two questions that run together', async () => {
      const date = inDays(2)
      const { id, plugin } = register(() => Promise.resolve(answer({ expiresAt: date })))
      const row = await seeded(id)

      await Promise.all(
        Array.from({ length: 5 }, () => service.refresh(row.id, ctx.storeA.id, plugin))
      )

      expect(announced).toHaveLength(1)
    })

    it('is not announced for a token that is not valid, nor for one whose date has passed', async () => {
      const invalid = register(() =>
        Promise.resolve(answer({ isValid: false, expiresAt: inDays(2) }))
      )
      const passed = register(() => Promise.resolve(answer({ expiresAt: inDays(-1) })))
      const a = await seeded(invalid.id)
      const b = await seeded(passed.id)

      await service.refresh(a.id, ctx.storeA.id, invalid.plugin)
      await service.refresh(b.id, ctx.storeA.id, passed.plugin)

      expect(announced).toHaveLength(0)
      const view = await asAdmin().get(ApiRoutes.channels.connectionById(b.id))
      expect((view.body as ConnectionBody).tokenExpiry.state).toBe('expired')
    })
  })

  describe('a connection that is not up', () => {
    it('is not announced while it is in error, and is when it is up again with the date still near', async () => {
      const date = inDays(2)
      const { id, plugin } = register(() => Promise.resolve(answer({ expiresAt: date })))
      const row = await seeded(id)
      await owner.channelConnection.update({
        where: { id: row.id },
        data: { status: ChannelConnectionStatus.ERROR }
      })

      await service.refresh(row.id, ctx.storeA.id, plugin)

      expect(announced).toHaveLength(0)
      expect((await infoOf(row.id))?.expiryNotifiedFor).toBeNull() // Not claimed: nobody was told
      await owner.channelConnection.update({
        where: { id: row.id },
        data: { status: ChannelConnectionStatus.ACTIVE }
      })

      await service.refresh(row.id, ctx.storeA.id, plugin)

      expect(announced).toHaveLength(1)
    })

    it('is not written when it is disconnected while the provider answers', async () => {
      let release: () => void = () => undefined
      const waiting = new Promise<void>(resolve => {
        release = resolve
      })
      const { id, plugin } = register(async () => {
        await waiting
        return answer({ expiresAt: inDays(2) })
      })
      const row = await seeded(id)

      const asking = service.refresh(row.id, ctx.storeA.id, plugin)
      await owner.channelConnection.update({
        where: { id: row.id },
        data: { status: ChannelConnectionStatus.DISCONNECTED }
      })
      release()

      expect(await asking).toBe(false)
      expect(await infoOf(row.id)).toBeNull()
      expect(announced).toHaveLength(0)
    })
  })

  describe('when the provider cannot be asked', () => {
    it('keeps what was known and writes nothing, and never calls the token expired', async () => {
      const { id, plugin } = register(() => Promise.reject(new Error('Meta is down')))
      const known = { checkedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() }
      const row = await seeded(id, known)
      const before = await infoOf(row.id)

      const written = await service.refresh(row.id, ctx.storeA.id, plugin)

      expect(written).toBe(false)
      expect(await infoOf(row.id)).toEqual(before)
      const view = await asAdmin().get(ApiRoutes.channels.connectionById(row.id))
      expect((view.body as ConnectionBody).tokenExpiry.state).toBe('expires')
    })
  })

  describe('writing the metadata', () => {
    it('does not overwrite what another writer puts in it at the same time', async () => {
      const { id, plugin } = register(() => Promise.resolve(answer()))
      const row = await seeded(id)

      for (let round = 0; round < 10; round += 1) {
        await Promise.all([
          service.refresh(row.id, ctx.storeA.id, plugin),
          owner.$executeRaw`UPDATE channel_connections
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY['reason'], to_jsonb(${`r${round}`}::text), true)
            WHERE id = ${row.id}`
        ])
        const metadata = await metadataOf(row.id)
        expect(metadata?.['reason']).toBe(`r${round}`)
        expect(metadata?.['region']).toBe('sv')
        expect((metadata?.['tokenInfo'] as TokenInfo | undefined)?.isValid).toBe(true)
      }
    })

    it('does not write the answer about a token that was replaced while the provider answered', async () => {
      let release: () => void = () => undefined
      const waiting = new Promise<void>(resolve => {
        release = resolve
      })
      const { id, plugin } = register(async () => {
        await waiting
        return answer({ expiresAt: inDays(2) })
      })
      const row = await seeded(id)

      const asking = service.refresh(row.id, ctx.storeA.id, plugin)
      await owner.channelConnection.update({
        where: { id: row.id },
        data: { credentials: Buffer.from('another sealed token') }
      })
      release()

      expect(await asking).toBe(false)
      expect(await infoOf(row.id)).toBeNull()
      expect(announced).toHaveLength(0)
    })

    it('does not touch a connection of another store, whichever id it is given', async () => {
      const { id, plugin } = register(() => Promise.resolve(answer()))
      const theirs = await seeded(id, undefined, ctx.storeB.id)

      const written = await service.refresh(theirs.id, ctx.storeA.id, plugin)

      expect(written).toBe(false)
      expect(await infoOf(theirs.id)).toBeNull()
    })
  })

  describe('the daily round', () => {
    it('asks the ones that are due, the one asked longest ago first, up to the calls it may make', async () => {
      const asked: string[] = []
      const { id, plugin } = register(token => {
        asked.push(token)
        return Promise.resolve(answer())
      })
      const hours = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
      const never = await seeded(id) // Never asked
      const old = await seeded(id, { checkedAt: hours(30) })
      const fresh = await seeded(id, { checkedAt: hours(1) })
      const doesNotExpireRecent = await seeded(id, { expiresAt: null, checkedAt: hours(72) })
      const doesNotExpireOld = await seeded(id, { expiresAt: null, checkedAt: hours(24 * 8) })
      const ids = [never.id, old.id, fresh.id, doesNotExpireRecent.id, doesNotExpireOld.id]

      const result = await service.runDue(pluginId => (pluginId === id ? plugin : undefined), 100)

      expect(result.asked).toBeGreaterThanOrEqual(3)
      const infos = await Promise.all(ids.map(infoOf))
      const askedNow = infos.map(
        info => info !== null && Date.now() - new Date(info.checkedAt).getTime() < 60_000
      )
      expect(askedNow).toEqual([true, true, false, false, true])
    })

    it('stops at the number of calls it may make, taking the oldest first', async () => {
      const { id, plugin } = register(() => Promise.resolve(answer()))
      const old = await seeded(id, {
        checkedAt: new Date(Date.now() - 40 * 3_600_000).toISOString()
      })
      const older = await seeded(id, {
        checkedAt: new Date(Date.now() - 80 * 3_600_000).toISOString()
      })
      const oldest = await seeded(id, {
        checkedAt: new Date(Date.now() - 120 * 3_600_000).toISOString()
      })

      const result = await service.runDue(pluginId => (pluginId === id ? plugin : undefined), 2)

      expect(result.asked).toBe(2)
      const now = Date.now()
      const fresh = async (rowId: string) =>
        now - new Date((await infoOf(rowId))?.checkedAt ?? 0).getTime() < 60_000
      expect(await fresh(oldest.id)).toBe(true)
      expect(await fresh(older.id)).toBe(true)
      expect(await fresh(old.id)).toBe(false)
    })

    it('does not let connections that cannot be answered take the place of the ones that can', async () => {
      const failing = register(() => Promise.reject(new Error('Meta says no')))
      const healthy = register(() => Promise.resolve(answer()))
      const find = (pluginId: string): ChannelPlugin | undefined =>
        pluginId === failing.id
          ? failing.plugin
          : pluginId === healthy.id
            ? healthy.plugin
            : undefined
      const broken = [await seeded(failing.id), await seeded(failing.id), await seeded(failing.id)]
      const good = await seeded(healthy.id)

      // One question a round: the broken ones are asked once each, then wait for their window
      for (let round = 0; round < 4; round += 1) await service.runDue(find, 1)

      expect(await infoOf(good.id)).not.toBeNull()
      for (const row of broken) {
        expect(await infoOf(row.id)).toBeNull()
        expect((await metadataOf(row.id))?.['tokenAttemptAt']).toEqual(expect.any(String))
      }
    })

    it('leaves alone a channel that cannot be asked about, a disconnected connection and one of an unknown plugin', async () => {
      const silent = register()
      const live = register(() => Promise.resolve(answer()))
      const a = await seeded(silent.id)
      const b = await seeded(live.id)
      await owner.channelConnection.update({
        where: { id: b.id },
        data: { status: ChannelConnectionStatus.DISCONNECTED }
      })
      const c = await seeded(`gone_${randomUUID().slice(0, 6)}`)

      await service.runDue(
        pluginId =>
          pluginId === silent.id ? silent.plugin : pluginId === live.id ? live.plugin : undefined,
        100
      )

      expect(await infoOf(a.id)).toBeNull()
      expect(await infoOf(b.id)).toBeNull()
      expect(await infoOf(c.id)).toBeNull()
    })

    it('writes each connection under its own store, so a round never mixes two stores', async () => {
      const { id, plugin } = register(() => Promise.resolve(answer({ expiresAt: inDays(2) })))
      const mine = await seeded(id)
      const theirs = await seeded(id, undefined, ctx.storeB.id)

      await service.runDue(pluginId => (pluginId === id ? plugin : undefined), 100)

      expect(await infoOf(mine.id)).not.toBeNull()
      expect(await infoOf(theirs.id)).not.toBeNull()
      expect(announced.map(event => event.channelConnectionId).sort()).toEqual(
        [mine.id, theirs.id].sort()
      )
      const stores = await Promise.all(
        announced.map(async event => ({
          event,
          row: await owner.channelConnection.findUniqueOrThrow({
            where: { id: event.channelConnectionId }
          })
        }))
      )
      for (const { event, row } of stores) {
        expect((event as unknown as { storeId: string }).storeId).toBe(row.storeId)
      }
    })
  })

  describe('what is logged', () => {
    const logged = (spy: jest.SpyInstance): string => JSON.stringify(spy.mock.calls)

    it('names only the kind of failure when the provider cannot be asked, never what it said', async () => {
      const warn = jest.spyOn(PinoLogger.prototype, 'warn')
      const { id, plugin } = register(() =>
        Promise.reject(new Error(`Meta said ${SECRET} and Bearer 123|appsecret`))
      )
      const row = await seeded(id)

      await service.refresh(row.id, ctx.storeA.id, plugin)

      const text = logged(warn)
      expect(text).toContain('could not be asked about')
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('appsecret')
      warn.mockRestore()
    })

    // The whole way: the real client under the service, a network that fails with the address in its cause,
    // and every line the logger was given
    describe.each([
      ['POST', false],
      ['GET', true]
    ])('with the real client, on the %s path', (_method, fallsBackToGet) => {
      it('logs neither the address, nor the token, nor the secret of the app, nor the cause', async () => {
        const APP_SECRET = 'app-secret-0123456789abcdef'
        const address = `https://graph.facebook.com/v23.0/debug_token?input_token=${SECRET}`
        const fetchSpy = jest.spyOn(globalThis, 'fetch')
        if (fallsBackToGet) {
          fetchSpy.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { type: 'GraphMethodException', code: 100 } }), {
              status: 400,
              headers: { 'content-type': 'application/json' }
            })
          )
        }
        fetchSpy.mockRejectedValueOnce(
          new TypeError('fetch failed', {
            cause: new Error(`connect ECONNREFUSED ${address} Bearer 123|${APP_SECRET}`)
          })
        )
        const client = new MetaGraphClient({
          appId: '123',
          appSecret: APP_SECRET,
          verifyToken: 'v',
          graphVersion: 'v23.0'
        })
        const { id, plugin } = register(token => client.debugToken(token))
        const row = await seeded(id)
        const capture: jest.SpyInstance[] = [
          jest.spyOn(PinoLogger.prototype, 'warn'),
          jest.spyOn(PinoLogger.prototype, 'error'),
          jest.spyOn(PinoLogger.prototype, 'info')
        ]

        const written = await service.refresh(row.id, ctx.storeA.id, plugin)

        expect(written).toBe(false)
        const text = capture.map(logged).join(' ')
        expect(text).toContain('could not be asked about')
        for (const secret of [SECRET, APP_SECRET, 'debug_token', 'ECONNREFUSED', 'input_token']) {
          expect(text).not.toContain(secret)
        }
        for (const spy of capture) spy.mockRestore()
        fetchSpy.mockRestore()
      })
    })

    it('says in a warning that a connection is up while its token is reported as not valid', async () => {
      const warn = jest.spyOn(PinoLogger.prototype, 'warn')
      const { id, plugin } = register(() => Promise.resolve(answer({ isValid: false })))
      const row = await seeded(id)

      await service.refresh(row.id, ctx.storeA.id, plugin)

      expect(logged(warn)).toContain('token is reported as not valid')
      expect(logged(warn)).toContain(row.id)
      expect(logged(warn)).not.toContain(SECRET)
      warn.mockRestore()
    })
  })
})
