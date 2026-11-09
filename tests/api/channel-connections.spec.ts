import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import {
  CONNECTION_ROW_SELECT,
  ChannelHealthService,
  ProviderTimeoutError
} from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { RoleNames } from '@platform/core/auth'
import { CredentialCipher } from '@platform/core/crypto'
import { ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  ChannelConnectionListStates,
  ChannelConnectionStatus,
  ChannelHealthErrors,
  MembershipStatus,
  MessageType,
  PaginationLimits,
  PluginInstallationStatus
} from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes, PluginChecks } from '@platform/core/errors'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability, type ChannelPlugin, PluginError } from '@platform/plugins/sdk'

import {
  buildChannelPlugin,
  createChannelConnection,
  createConversation,
  createCustomerIdentity,
  ensurePluginInstallation
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const SECRET = 'EAAB-super-secret-token'

interface ErrorBody {
  error: { code: string; message?: string; metadata?: Record<string, unknown> }
}
interface ConnectionBody {
  id: string
  pluginId: string
  pluginName?: string
  displayName: string
  status: string
  lastError: string | null
  capabilities: string[]
  profile?: {
    failedIdentities: number
    errors: { code: string; identities: number }[]
    setupKey: string | null
  } | null
}

interface ConnectionPageBody {
  data: ConnectionBody[]
  nextCursor: string | null
  hasMore: boolean
}

describe('The channel connections of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let registry: PluginRegistry
  let counter = 0
  const disconnected: string[] = []
  // The registry is the process's: what a case registers is taken out when the file ends
  const registered: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(PluginRegistry, { strict: false })
  })
  afterAll(async () => {
    for (const id of registered) registry.unregister(id)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  // Every page of the list, followed by its cursor: the store holds the connections of all the cases
  async function allConnections(agent = asAdmin): Promise<ConnectionBody[]> {
    const rows: ConnectionBody[] = []
    let cursor: string | null = null
    do {
      const page: { body: ConnectionPageBody } = await agent()
        .get(ApiRoutes.channels.connections)
        .query({ limit: 100, ...(cursor === null ? {} : { cursor }) })
      rows.push(...page.body.data)
      cursor = page.body.nextCursor
    } while (cursor !== null)
    return rows
  }

  // A plugin of its own for each test: the registry refuses an id twice
  function register(over: Partial<ChannelPlugin> = {}, connectionId = `acct-${randomUUID()}`) {
    counter += 1
    const id = `conn_${counter}`
    const plugin = buildChannelPlugin({
      id,
      connect: input =>
        Promise.resolve({
          connectionId,
          displayName: 'Acme account',
          credentials: input.credentials,
          metadata: { region: 'sv' }
        }),
      disconnect: () => {
        disconnected.push(id)
        return Promise.resolve()
      },
      ...over
    })
    registry.register(plugin)
    registered.push(id)
    return { id, plugin, connectionId }
  }
  // The plugin is installed in both stores first, as the catalog would do: connecting needs it
  const connect = async (pluginId: string, agent = asAdmin) => {
    await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId })
    await ensurePluginInstallation(owner, { storeId: ctx.storeB.id, pluginId })
    return agent()
      .post(ApiRoutes.channels.connect(pluginId))
      .send({ credentials: { token: SECRET } })
  }

  async function auditCount(action: string, resourceId: string, expected: number) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = await owner.auditLog.count({ where: { action, resourceId } })
      if (count >= expected) return count
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return owner.auditLog.count({ where: { action, resourceId } })
  }

  describe('connecting', () => {
    it('stores it active, with the credentials encrypted, and audits it', async () => {
      const { id } = register()

      const response = await connect(id)

      expect(response.status).toBe(CREATED)
      const body = response.body as ConnectionBody
      expect(body).toMatchObject({ pluginId: id, displayName: 'Acme account', status: 'active' })
      expect(JSON.stringify(body)).not.toContain(SECRET)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(Buffer.from(row.credentials).toString('utf8')).not.toContain(SECRET)
      const cipher = app.get(CredentialCipher, { strict: false })
      expect(cipher.open(row.credentials)).toEqual({ token: SECRET })
      expect(await auditCount(AuditAction.CHANNEL_CONNECTED, body.id, 1)).toBe(1)
    })

    it('keeps the name of an account when it is connected again and the plugin could only make one up', async () => {
      let call = 0
      const accountId = `acct-${randomUUID()}`
      const { id } = register({
        connect: input => {
          call += 1
          const name =
            call === 1
              ? { displayName: 'Acme Page' }
              : call === 2
                ? { displayName: 'Page 109', displayNameIsPlaceholder: true }
                : { displayName: 'Acme Page renamed' }
          return Promise.resolve({
            connectionId: accountId,
            ...name,
            credentials: input.credentials,
            metadata: {}
          })
        }
      })

      const first = (await connect(id)).body as ConnectionBody
      const second = (await connect(id)).body as ConnectionBody
      expect(second.id).toBe(first.id)
      expect(second.displayName).toBe('Acme Page')
      // A name the provider did say is written, as ever
      const third = (await connect(id)).body as ConnectionBody
      expect(third.displayName).toBe('Acme Page renamed')
    })

    it('uses the made-up name for an account that has no other', async () => {
      const { id } = register({
        connect: input =>
          Promise.resolve({
            connectionId: `acct-${randomUUID()}`,
            displayName: 'Page 109',
            displayNameIsPlaceholder: true,
            credentials: input.credentials,
            metadata: {}
          })
      })

      const body = (await connect(id)).body as ConnectionBody

      expect(body.displayName).toBe('Page 109')
    })

    it('updates the same account of the same store instead of making another', async () => {
      const { id } = register()

      const first = await connect(id)
      const second = await connect(id)

      expect((second.body as ConnectionBody).id).toBe((first.body as ConnectionBody).id)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
    })

    it('refuses an account that another store already connected, with its own code, and leaves it as it was', async () => {
      const { id } = register()
      const theirs = await connect(id, asAdminB)

      const response = await connect(id)

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_ACCOUNT_IN_USE)
      const row = await owner.channelConnection.findUniqueOrThrow({
        where: { id: (theirs.body as ConnectionBody).id }
      })
      expect(row.storeId).toBe(ctx.storeB.id)
    })

    // The other store is named only to somebody who is an active member of it (and the answer is the
    // same for everybody else, so a stranger learns nothing about where an account lives)
    describe('who is told which store has the account', () => {
      const storeBName = async () =>
        (
          await owner.store.findUniqueOrThrow({
            where: { id: ctx.storeB.id },
            select: { name: true }
          })
        ).name
      const joinStoreB = async (status: string) =>
        ensureMembership(owner, {
          userId: ctx.adminA.id,
          organizationId: ctx.orgB.id,
          storeId: ctx.storeB.id,
          roleId: ctx.roleIds[RoleNames.ADMIN]
        }).then(() =>
          owner.membership.updateMany({
            where: { userId: ctx.adminA.id, storeId: ctx.storeB.id },
            data: { status }
          })
        )
      // Nobody else in the suites belongs to two stores
      afterEach(async () => {
        await owner.membership.deleteMany({
          where: { userId: ctx.adminA.id, storeId: ctx.storeB.id }
        })
      })

      it('names the store to an active member of it', async () => {
        const { id } = register()
        await connect(id, asAdminB)
        await joinStoreB(MembershipStatus.ACTIVE)

        const response = await connect(id)

        expect(response.status).toBe(CONFLICT)
        expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_ACCOUNT_IN_USE)
        expect((response.body as ErrorBody).error.metadata).toEqual({
          storeName: await storeBName()
        })
      })

      it('says nothing of the store to a member whose membership was ended (revokedAt) but still reads active', async () => {
        const { id } = register()
        await connect(id, asAdminB)
        await joinStoreB(MembershipStatus.ACTIVE)
        await owner.membership.updateMany({
          where: { userId: ctx.adminA.id, storeId: ctx.storeB.id },
          data: { revokedAt: new Date() }
        })

        const response = await connect(id)

        expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_ACCOUNT_IN_USE)
        expect((response.body as ErrorBody).error.metadata).toEqual({})
        expect(JSON.stringify(response.body)).not.toContain(await storeBName())
      })

      it.each([
        ['somebody who is not a member of it', null],
        ['a member who is suspended there', MembershipStatus.SUSPENDED],
        ['a member who was removed from it', MembershipStatus.REVOKED]
      ])('says nothing of the store to %s', async (_label, status) => {
        const { id } = register()
        await connect(id, asAdminB)
        if (status !== null) await joinStoreB(status)

        const response = await connect(id)

        expect(response.status).toBe(CONFLICT)
        expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_ACCOUNT_IN_USE)
        expect((response.body as ErrorBody).error.metadata).toEqual({})
        const text = JSON.stringify(response.body)
        for (const secret of [ctx.storeB.id, ctx.orgB.id, await storeBName()]) {
          expect(text).not.toContain(secret)
        }
      })
    })

    it('does not say what the provider said when it refuses the credentials', async () => {
      const { id } = register({
        connect: () => Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID))
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      expect(JSON.stringify(response.body)).not.toContain(SECRET)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })

    describe('the reason it gives when the provider does not accept the connection', () => {
      const reasonOf = (body: unknown): unknown =>
        (body as { error: { metadata: Record<string, unknown> } }).error.metadata['reason']

      it.each(Object.values(ChannelConnectFailureReasons))(
        'says %s as a name of the list, and still the same code, so an older page shows its generic message',
        async reason => {
          const { id } = register({
            connect: () =>
              Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { reason }))
          })

          const response = await connect(id)

          expect(response.status).toBe(BAD_REQUEST)
          expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
          expect(reasonOf(response.body)).toBe(reason)
          expect(JSON.stringify(response.body)).not.toContain(SECRET)
        }
      )

      it('says the reason of the local check that refused', async () => {
        const { id } = register({
          connect: () =>
            Promise.reject(
              new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
                failedCheck: PluginChecks.ACCOUNT_ID_MISMATCH
              })
            )
        })

        const response = await connect(id)

        expect(reasonOf(response.body)).toBe(ChannelConnectFailureReasons.OTHER_ACCOUNT)
      })

      it.each([
        ['an error that is not of a plugin and holds the token', new Error(`Bearer ${SECRET}`)],
        ['a plugin error with no reason', new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)]
      ])('says no reason for %s, and nothing of its text', async (_name, failure) => {
        const { id } = register({ connect: () => Promise.reject(failure) })

        const response = await connect(id)

        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
        expect(reasonOf(response.body)).toBeUndefined()
        expect(JSON.stringify(response.body)).not.toContain(SECRET)
      })

      it('says the provider is unavailable when the whole call to it timed out', async () => {
        const { id } = register({ connect: () => Promise.reject(new ProviderTimeoutError()) })

        const response = await connect(id)

        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
        expect(reasonOf(response.body)).toBe(ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE)
      })

      it('does not carry a reason a plugin made up, nor its text', async () => {
        const forged = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
        Object.defineProperty(forged, 'reason', { value: `Bearer ${SECRET}` })
        const { id } = register({ connect: () => Promise.reject(forged) })

        const response = await connect(id)

        expect(reasonOf(response.body)).toBeUndefined()
        expect(JSON.stringify(response.body)).not.toContain(SECRET)
      })
    })

    it('gives the same new account to one of two stores that ask at the same moment, never a 500', async () => {
      const { id } = register()

      const [a, b] = await Promise.all([connect(id), connect(id, asAdminB)])

      expect([a.status, b.status].sort()).toEqual([CREATED, CONFLICT])
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
    })

    it('makes one connection of two clicks of the same store', async () => {
      const { id } = register()

      const [a, b] = await Promise.all([connect(id), connect(id)])

      expect([a.status, b.status]).toEqual([CREATED, CREATED])
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
    })

    it('gives an account that its store disconnected to another store, keeping the old row', async () => {
      const { id } = register()
      const first = (await connect(id)).body as ConnectionBody
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id))

      const second = await connect(id, asAdminB)

      expect(second.status).toBe(CREATED)
      const old = await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })
      expect(old).toMatchObject({
        storeId: ctx.storeA.id,
        status: ChannelConnectionStatus.DISCONNECTED
      })
      expect(old.connectionId).toContain('~released~')
      const fresh = await owner.channelConnection.findUniqueOrThrow({
        where: { id: (second.body as ConnectionBody).id }
      })
      expect(fresh.storeId).toBe(ctx.storeB.id)
    })

    it.each([
      ['an account id with a NUL character', { connectionId: 'acct\u0000x' }],
      ['metadata with a NUL character', { metadata: { name: 'a\u0000b' } }]
    ])('answers 400, not 500, for %s', async (_label, over) => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-nul',
            displayName: 'x',
            credentials: {},
            metadata: {},
            ...over
          })
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })

    it('uses the account id when nothing is left of the name after it is cleaned', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-blank',
            displayName: '\u200B\u200B',
            credentials: {},
            metadata: {}
          })
      })

      const response = await connect(id)

      expect((response.body as ConnectionBody).displayName).toBe('acct-blank')
    })

    it('cleans the name that a plugin gives to the account before it is kept', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-name',
            displayName: 'Acme\u202E evil\u200B name',
            credentials: {},
            metadata: {}
          })
      })

      const response = await connect(id)

      expect((response.body as ConnectionBody).displayName).toBe('Acme evil name')
    })

    it('refuses credentials that cannot be written down, as a plugin that answered badly', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: 'acct-big',
            displayName: 'x',
            credentials: { n: BigInt(1) },
            metadata: {}
          })
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    })

    it('does not keep what a plugin returns that does not fit', async () => {
      const { id } = register({
        connect: () =>
          Promise.resolve({
            connectionId: '',
            displayName: 'x',
            credentials: {},
            metadata: {}
          })
      })

      const response = await connect(id)

      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })

    it('is not there for a channel nobody registered, or one private to another store', async () => {
      counter += 1
      const privateId = `conn_${counter}`
      registry.register(buildChannelPlugin({ id: privateId }), { storeIds: [ctx.storeA2.id] })

      const unknown = await connect('telegram')
      const foreign = await connect(privateId)

      expect(unknown.status).toBe(NOT_FOUND)
      expect(foreign.status).toBe(NOT_FOUND)
    })

    it('needs the permission to change settings', async () => {
      const { id } = register()

      const response = await connect(id, asAgent)

      expect(response.status).toBe(FORBIDDEN)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(0)
    })
  })

  describe('updating the token of a connection', () => {
    const NEW_SECRET = 'EAAB-the-new-token'
    const update = (connectionId: string, credentials: Record<string, unknown>, agent = asAdmin) =>
      agent().post(ApiRoutes.channels.updateToken(connectionId)).send({ credentials })
    const reasonOf = (body: unknown): unknown =>
      (body as { error: { metadata?: Record<string, unknown> } }).error.metadata?.['reason']
    const openCredentials = async (rowId: string) =>
      app
        .get(CredentialCipher, { strict: false })
        .open(
          (await owner.channelConnection.findUniqueOrThrow({ where: { id: rowId } })).credentials
        )

    // A plugin that records what it was asked, in order, and tells the account a token belongs to
    function recording(accountOf: (token: string) => string, connectionId: string) {
      const calls: string[] = []
      const credentialsSeen: Record<string, unknown>[] = []
      const { id } = register(
        {
          healthCheck: ctx => {
            calls.push('healthCheck')
            credentialsSeen.push(ctx.credentials)
            if (accountOf(String(ctx.credentials['token'])) !== ctx.connectionId) {
              return Promise.reject(
                new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
                  failedCheck: PluginChecks.ACCOUNT_ID_MISMATCH
                })
              )
            }
            return Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() })
          },
          connect: input => {
            calls.push('connect')
            return Promise.resolve({
              connectionId: accountOf(String(input.credentials['token'])),
              displayName: 'Renamed by the provider',
              credentials: input.credentials,
              metadata: { region: 'sv' }
            })
          }
        },
        connectionId
      )
      return { id, calls, credentialsSeen }
    }

    it('replaces the credentials of the same connection, keeps its name and conversations, and audits it', async () => {
      const mine = recording(() => 'acct-same', 'acct-same')
      const first = (await connect(mine.id)).body as ConnectionBody
      mine.calls.length = 0
      // The plugin names the account differently now: the connection keeps the name it has
      await owner.channelConnection.update({
        where: { id: first.id },
        data: { displayName: 'My own name' }
      })

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(OK)
      const body = response.body as ConnectionBody
      expect(body).toMatchObject({ id: first.id, displayName: 'My own name', status: 'active' })
      expect(mine.calls).toEqual(['healthCheck', 'connect'])
      expect(JSON.stringify(response.body)).not.toContain(NEW_SECRET)
      expect(await openCredentials(first.id)).toEqual({ token: NEW_SECRET })
      expect(await owner.channelConnection.count({ where: { pluginId: mine.id } })).toBe(1)
      expect(await auditCount(AuditAction.CHANNEL_TOKEN_UPDATED, first.id, 1)).toBe(1)
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { action: AuditAction.CHANNEL_TOKEN_UPDATED, resourceId: first.id }
      })
      expect(JSON.stringify(audit)).not.toContain(NEW_SECRET)
      expect(JSON.stringify(audit)).not.toContain(SECRET)
    })

    it('brings a connection in error back to active and forgets the error', async () => {
      const mine = recording(() => 'acct-err', 'acct-err')
      const first = (await connect(mine.id)).body as ConnectionBody
      await owner.channelConnection.update({
        where: { id: first.id },
        data: {
          status: ChannelConnectionStatus.ERROR,
          lastError: ChannelHealthErrors.TOKEN_REJECTED
        }
      })

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ status: 'active', lastError: null })
    })

    it('reads who the new token belongs to before it subscribes or writes anything, and refuses another account', async () => {
      const mine = recording(
        token => (token === NEW_SECRET ? 'acct-other' : 'acct-mine'),
        'acct-mine'
      )
      const first = (await connect(mine.id)).body as ConnectionBody
      mine.calls.length = 0

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      expect(reasonOf(response.body)).toBe(ChannelConnectFailureReasons.OTHER_ACCOUNT)
      // The read-only check ran, the one that subscribes did not
      expect(mine.calls).toEqual(['healthCheck'])
      expect(JSON.stringify(response.body)).not.toContain('acct-other')
      expect(JSON.stringify(response.body)).not.toContain(NEW_SECRET)
      expect(await openCredentials(first.id)).toEqual({ token: SECRET })
      expect(await owner.channelConnection.count({ where: { pluginId: mine.id } })).toBe(1)
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.CHANNEL_TOKEN_UPDATED, resourceId: first.id }
        })
      ).toBe(0)
    })

    it('refuses an account that the subscribing call names differently, and leaves the row as it was', async () => {
      // Not reachable with an honest plugin (the read says the same), but the write is guarded all the same
      let answers = 'acct-guard'
      const { id } = register(
        {
          connect: input =>
            Promise.resolve({
              connectionId: answers,
              displayName: 'x',
              credentials: input.credentials,
              metadata: {}
            })
        },
        'acct-guard'
      )
      const first = (await connect(id)).body as ConnectionBody
      answers = 'acct-somebody-else'

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(BAD_REQUEST)
      expect(reasonOf(response.body)).toBe(ChannelConnectFailureReasons.OTHER_ACCOUNT)
      expect(await openCredentials(first.id)).toEqual({ token: SECRET })
      // What it subscribed on the account it named is let go, since no row holds that account
      expect(disconnected).toContain(id)
    })

    it('does not go on to subscribe when the check answers something that is not a plain healthy report', async () => {
      const calls: string[] = []
      const { id } = register(
        {
          healthCheck: () => Promise.resolve({ healthy: 'false', checkedAt: 'now' } as never),
          connect: input => {
            calls.push('connect')
            return Promise.resolve({
              connectionId: 'acct-report',
              displayName: 'x',
              credentials: input.credentials,
              metadata: {}
            })
          }
        },
        'acct-report'
      )
      const first = (await connect(id)).body as ConnectionBody
      calls.length = 0

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(BAD_REQUEST)
      expect(calls).toEqual([])
      expect(await openCredentials(first.id)).toEqual({ token: SECRET })
    })

    it.each([
      ChannelConnectFailureReasons.TOKEN_REJECTED,
      ChannelConnectFailureReasons.PERMISSION_MISSING,
      ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
    ])('says %s when the read fails that way, and keeps the old token', async reason => {
      const { id } = register({
        healthCheck: () =>
          Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { reason }))
      })
      const first = (await connect(id)).body as ConnectionBody

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(BAD_REQUEST)
      expect(reasonOf(response.body)).toBe(reason)
      expect(JSON.stringify(response.body)).not.toContain(NEW_SECRET)
      expect(await openCredentials(first.id)).toEqual({ token: SECRET })
    })

    it('says no reason for a failure that holds the token, and nothing of its text', async () => {
      const { id } = register({
        healthCheck: () => Promise.reject(new Error(`Bearer ${NEW_SECRET}`))
      })
      const first = (await connect(id)).body as ConnectionBody

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      expect(reasonOf(response.body)).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toContain(NEW_SECRET)
    })

    it('asks only for what is secret: the rest of the credentials stay, and a field that is not secret is ignored', async () => {
      const seen: Record<string, unknown>[] = []
      const { id } = register(
        {
          connectFields: [
            {
              key: 'token',
              labelKey: 'settings.channels.connect.test_channel.token',
              secret: true,
              required: true,
              multiple: false
            },
            {
              key: 'phoneId',
              labelKey: 'settings.channels.connect.test_channel.token',
              secret: false,
              required: true,
              multiple: false
            }
          ],
          connect: input => {
            seen.push(input.credentials)
            return Promise.resolve({
              connectionId: 'acct-fields',
              displayName: 'Acme account',
              credentials: input.credentials,
              metadata: {}
            })
          }
        },
        'acct-fields'
      )
      await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId: id })
      const first = (
        await asAdmin()
          .post(ApiRoutes.channels.connect(id))
          .send({ credentials: { token: SECRET, phoneId: '111' } })
      ).body as ConnectionBody

      const response = await update(first.id, { token: NEW_SECRET, phoneId: '999' })

      expect(response.status).toBe(OK)
      expect(seen.at(-1)).toEqual({ token: NEW_SECRET, phoneId: '111' })
      expect(await openCredentials(first.id)).toEqual({ token: NEW_SECRET, phoneId: '111' })
    })

    it('is refused for a channel that has no token to replace', async () => {
      const { id } = register({ connectFields: [] })
      const first = (await connect(id)).body as ConnectionBody

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(CONFLICT)
      expect(await openCredentials(first.id)).toEqual({ token: SECRET })
    })

    it('is refused for a connection that was disconnected', async () => {
      const { id } = register()
      const first = (await connect(id)).body as ConnectionBody
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id)).send({})

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(CONFLICT)
    })

    it('answers a connection of another store exactly as one that does not exist, and changes nothing', async () => {
      const { id } = register()
      const theirs = (await connect(id, asAdminB)).body as ConnectionBody

      const foreign = await update(theirs.id, { token: NEW_SECRET })
      const missing = await update(randomUUID(), { token: NEW_SECRET })

      expect(foreign.status).toBe(NOT_FOUND)
      expect(foreign.status).toBe(missing.status)
      expect((foreign.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
      expect(await openCredentials(theirs.id)).toEqual({ token: SECRET })
    })

    it('needs the permission to change settings', async () => {
      const { id } = register()
      const first = (await connect(id)).body as ConnectionBody

      const response = await update(first.id, { token: NEW_SECRET }, asAgent)

      expect(response.status).toBe(FORBIDDEN)
      expect(await openCredentials(first.id)).toEqual({ token: SECRET })
    })

    it('keeps one row and one of the two tokens when two updates arrive at once', async () => {
      const { id } = register()
      const first = (await connect(id)).body as ConnectionBody

      const [a, b] = await Promise.all([
        update(first.id, { token: 'EAAB-token-a' }),
        update(first.id, { token: 'EAAB-token-b' })
      ])

      // One of them is certain to win; the other either wins after it or is told the connection changed
      expect([a.status, b.status]).toContain(OK)
      expect([OK, CONFLICT]).toContain(a.status)
      expect([OK, CONFLICT]).toContain(b.status)
      expect(['EAAB-token-a', 'EAAB-token-b']).toContain((await openCredentials(first.id))['token'])
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
    })

    it('does not overwrite credentials that were replaced while the provider answered', async () => {
      let release: () => void = () => undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const { id } = register({
        healthCheck: async () => {
          await gate
          return { healthy: true, checkedAt: new Date().toISOString() }
        }
      })
      const first = (await connect(id)).body as ConnectionBody

      const pending = update(first.id, { token: 'EAAB-the-slow-one' }).then(response => response)
      await new Promise(resolve => setTimeout(resolve, 200))
      // Meanwhile somebody disconnects it and connects the same account again with another token
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id)).send({})
      await asAdmin()
        .post(ApiRoutes.channels.connect(id))
        .send({ credentials: { token: 'EAAB-the-reconnect' } })
      release()
      const response = await pending

      expect(response.status).toBe(CONFLICT)
      expect(await openCredentials(first.id)).toEqual({ token: 'EAAB-the-reconnect' })
    })

    it('keeps the metadata when the saved credentials cannot be read, so the right token is not called foreign', async () => {
      // Instagram keeps its Page id in the metadata and compares it in the check
      const { id } = register({
        healthCheck: ctx =>
          ctx.metadata['pageId'] === 'page-1'
            ? Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() })
            : Promise.reject(
                new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
                  failedCheck: PluginChecks.PAGE_ID_MISMATCH
                })
              ),
        connect: input =>
          Promise.resolve({
            connectionId: 'acct-unreadable',
            displayName: 'Acme account',
            credentials: input.credentials,
            metadata: { pageId: 'page-1' }
          })
      })
      const installation = await ensurePluginInstallation(owner, {
        storeId: ctx.storeA.id,
        pluginId: id
      })
      const row = await owner.channelConnection.create({
        data: {
          storeId: ctx.storeA.id,
          pluginId: id,
          installationId: installation.id,
          connectionId: 'acct-unreadable',
          displayName: 'Acme account',
          // Not something the cipher can open
          credentials: Buffer.from('garbage'),
          metadata: { pageId: 'page-1' },
          status: ChannelConnectionStatus.ERROR,
          lastError: ChannelHealthErrors.CREDENTIALS_UNREADABLE
        },
        select: { id: true }
      })

      const response = await update(row.id, { token: NEW_SECRET })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ status: 'active', lastError: null })
      expect(await openCredentials(row.id)).toEqual({ token: NEW_SECRET })
    })

    it('does not let a health check that asked with the old token put the fixed connection back in error', async () => {
      const { id } = register()
      const first = (await connect(id)).body as ConnectionBody
      const stale = await owner.channelConnection.findUniqueOrThrow({
        where: { id: first.id },
        select: CONNECTION_ROW_SELECT
      })

      await update(first.id, { token: NEW_SECRET })
      await app
        .get(ChannelHealthService, { strict: false })
        .record(stale, { healthy: false, error: ChannelHealthErrors.TOKEN_REJECTED })

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })
      expect(row.status).toBe(ChannelConnectionStatus.ACTIVE)
      expect(row.lastError).toBeNull()
    })

    it('keeps a secret that is not sent, and refuses a request that sends none of them', async () => {
      const seen: Record<string, unknown>[] = []
      const secret = (key: string) => ({
        key,
        labelKey: 'settings.channels.connect.test_channel.token',
        secret: true,
        required: true,
        multiple: false
      })
      const { id } = register(
        {
          connectFields: [secret('token'), secret('appSecret')],
          connect: input => {
            seen.push(input.credentials)
            return Promise.resolve({
              connectionId: 'acct-two-secrets',
              displayName: 'Acme account',
              credentials: input.credentials,
              metadata: {}
            })
          }
        },
        'acct-two-secrets'
      )
      await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId: id })
      const first = (
        await asAdmin()
          .post(ApiRoutes.channels.connect(id))
          .send({ credentials: { token: SECRET, appSecret: 'the-app-secret' } })
      ).body as ConnectionBody

      const replaced = await update(first.id, { token: NEW_SECRET })
      const nothing = await update(first.id, {})

      expect(replaced.status).toBe(OK)
      expect(seen.at(-1)).toEqual({ token: NEW_SECRET, appSecret: 'the-app-secret' })
      expect(nothing.status).toBe(BAD_REQUEST)
      expect(reasonOf(nothing.body)).toBe(ChannelConnectFailureReasons.TOKEN_MALFORMED)
      expect(await openCredentials(first.id)).toEqual({
        token: NEW_SECRET,
        appSecret: 'the-app-secret'
      })
    })

    it('is refused when the plugin is no longer installed in the store, and changes nothing', async () => {
      const { id } = register()
      const first = (await connect(id)).body as ConnectionBody
      await owner.pluginInstallation.updateMany({
        where: { storeId: ctx.storeA.id, pluginId: id },
        data: { status: PluginInstallationStatus.REVOKED }
      })

      const response = await update(first.id, { token: NEW_SECRET })

      expect(response.status).toBe(CONFLICT)
      expect(await openCredentials(first.id)).toEqual({ token: SECRET })
    })

    it('does not bring back a connection that was disconnected while the provider answered', async () => {
      let release: () => void = () => undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const { id } = register({
        healthCheck: async () => {
          await gate
          return { healthy: true, checkedAt: new Date().toISOString() }
        }
      })
      const first = (await connect(id)).body as ConnectionBody

      const pending = update(first.id, { token: NEW_SECRET }).then(response => response)
      await new Promise(resolve => setTimeout(resolve, 200))
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id)).send({})
      release()
      const response = await pending

      expect(response.status).toBe(CONFLICT)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
    })
  })

  describe('naming a connection', () => {
    const rename = (connectionId: string, label: unknown, agent = asAdmin) =>
      agent().put(ApiRoutes.channels.label(connectionId)).send({ label })
    interface Named extends ConnectionBody {
      label: string | null
      accountName: string
    }
    const NEW_SECRET = 'EAAB-after-the-rename'

    it('shows the label as the name, keeps the name of the account, and audits it', async () => {
      const { id, connectionId } = register()
      const first = (await connect(id)).body as Named

      const response = await rename(first.id, '  Instagram principal  ')

      expect(response.status).toBe(OK)
      const body = response.body as Named
      expect(body).toMatchObject({
        id: first.id,
        displayName: 'Instagram principal',
        label: 'Instagram principal',
        accountName: 'Acme account'
      })
      // The id of the account at the provider is not touched
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })
      expect(row.label).toBe('Instagram principal')
      expect(row.displayName).toBe('Acme account')
      expect(row.connectionId).toBe(connectionId)
      expect(await auditCount(AuditAction.CHANNEL_RENAMED, first.id, 1)).toBe(1)
      // The list, the one connection and the directory of the inbox all name it the same
      const listed = (await allConnections()).find(item => item.id === first.id) as Named
      expect(listed).toMatchObject({
        displayName: 'Instagram principal',
        label: 'Instagram principal'
      })
      const one = await asAdmin().get(ApiRoutes.channels.connectionById(first.id))
      expect((one.body as Named).displayName).toBe('Instagram principal')
      const directory = await asAgent().get(ApiRoutes.channels.directory)
      expect(
        (directory.body as { id: string; displayName: string }[]).find(item => item.id === first.id)
          ?.displayName
      ).toBe('Instagram principal')
    })

    it('goes back to the name of the account when the label is cleared', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named
      await rename(first.id, 'Main')

      const response = await rename(first.id, null)

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ displayName: 'Acme account', label: null })
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })).label
      ).toBeNull()
    })

    it('is kept by a connect of the same account and by a new token', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named
      await rename(first.id, 'My own name')

      const again = await connect(id)
      const updated = await asAdmin()
        .post(ApiRoutes.channels.updateToken(first.id))
        .send({ credentials: { token: NEW_SECRET } })

      expect((again.body as Named).id).toBe(first.id)
      expect((again.body as Named).displayName).toBe('My own name')
      expect(updated.status).toBe(OK)
      expect((updated.body as Named).displayName).toBe('My own name')
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })).label
      ).toBe('My own name')
    })

    it.each([
      ['empty', ''],
      ['only spaces', '   '],
      ['a line break', 'two\nlines'],
      ['an invisible character', 'sneaky\u200bname'],
      ['a NUL character', 'nul\u0000name'],
      ['more than the limit', 'x'.repeat(81)],
      ['not text', 7]
    ])('refuses a label that is %s, and keeps the one it had', async (_name, label) => {
      const { id } = register()
      const first = (await connect(id)).body as Named
      await rename(first.id, 'Kept')

      const response = await rename(first.id, label)

      expect(response.status).toBe(BAD_REQUEST)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })).label
      ).toBe('Kept')
    })

    it('refuses a field it does not know, so nothing else of the connection can be written through it', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named

      const response = await asAdmin()
        .put(ApiRoutes.channels.label(first.id))
        .send({ label: 'Fine', connectionId: 'someone-else', status: 'disconnected' })

      expect(response.status).toBe(BAD_REQUEST)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })
      expect(row.label).toBeNull()
      expect(row.status).toBe(ChannelConnectionStatus.ACTIVE)
    })

    it('keeps text that looks like markup as plain text, to be drawn escaped', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named

      const response = await rename(first.id, '<b>Ventas</b> & co')

      expect(response.status).toBe(OK)
      expect((response.body as Named).label).toBe('<b>Ventas</b> & co')
    })

    it('is refused for a connection that was disconnected', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id)).send({})

      const response = await rename(first.id, 'Too late')

      expect(response.status).toBe(CONFLICT)
    })

    it('audits what the name was and what it is, once for a change and not at all for the same name', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named

      await rename(first.id, 'Ventas')
      await rename(first.id, 'Ventas')
      await rename(first.id, null)

      expect(await auditCount(AuditAction.CHANNEL_RENAMED, first.id, 2)).toBe(2)
      const rows = await owner.auditLog.findMany({
        where: { action: AuditAction.CHANNEL_RENAMED, resourceId: first.id },
        orderBy: { timestamp: 'asc' }
      })
      expect(rows.map(row => row.metadata)).toEqual([
        { pluginId: id, label: 'Ventas', previousLabel: null },
        { pluginId: id, label: null, previousLabel: 'Ventas' }
      ])
    })

    it('writes no audit row for a name that is refused, and leaves the label of a disconnected connection as it was', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named
      await rename(first.id, 'Kept')
      await rename(first.id, 'x'.repeat(81))
      await rename(first.id, 'Nope', asAgent)
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id)).send({})

      const late = await rename(first.id, 'Too late')

      expect(late.status).toBe(CONFLICT)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })).label
      ).toBe('Kept')
      expect(await auditCount(AuditAction.CHANNEL_RENAMED, first.id, 1)).toBe(1)
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.CHANNEL_RENAMED, resourceId: first.id }
        })
      ).toBe(1)
    })

    it('is still there when the same account is connected again after it was disconnected', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named
      await rename(first.id, 'Ventas')
      await asAdmin().post(ApiRoutes.channels.disconnect(first.id)).send({})

      const again = await connect(id)

      expect((again.body as Named).id).toBe(first.id)
      expect((again.body as Named).displayName).toBe('Ventas')
    })

    it('answers a connection of another store exactly as one that does not exist, and changes nothing', async () => {
      const { id } = register()
      const theirs = (await connect(id, asAdminB)).body as Named

      const foreign = await rename(theirs.id, 'Mine now')
      const missing = await rename(randomUUID(), 'Mine now')

      expect(foreign.status).toBe(NOT_FOUND)
      expect((foreign.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: theirs.id } })).label
      ).toBeNull()
    })

    it('needs the permission to change settings', async () => {
      const { id } = register()
      const first = (await connect(id)).body as Named

      const response = await rename(first.id, 'Agent was here', asAgent)

      expect(response.status).toBe(FORBIDDEN)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: first.id } })).label
      ).toBeNull()
    })
  })

  describe('seeing them', () => {
    it('lists those of the store only, with no credentials', async () => {
      const mine = register()
      const theirs = register()
      await connect(mine.id)
      await connect(theirs.id, asAdminB)

      const items = await allConnections()

      const ids = items.map(item => item.pluginId)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
      expect(JSON.stringify(items)).not.toContain('credentials')
    })

    it('says what each channel can do, so that the web app draws only that', async () => {
      const { id, plugin } = register()
      await connect(id)

      const expected = [...new Set(plugin.capabilities)].sort()
      const item = (await allConnections()).find(each => each.pluginId === id)
      expect(item?.capabilities.slice().sort()).toEqual(expected)
      // The same view comes from every route that returns a connection
      const one = await asAdmin().get(ApiRoutes.channels.connectionById(item?.id ?? ''))
      expect((one.body as ConnectionBody).capabilities.slice().sort()).toEqual(expected)
    })
  })

  describe('paging the list', () => {
    const MINUTE = 60_000
    const FIRST_SEEDED_AT = Date.UTC(2001, 0, 1)
    let seeded = 0
    // The other cases leave connections in the store: the rows made here are told apart by id. Their
    // dates are old and a minute apart, so they come first and in a known order, whatever the clock
    // of the insert and however many connections the other cases left
    async function seedMany(
      storeId: string,
      count: number,
      status = ChannelConnectionStatus.ACTIVE
    ) {
      const ids: string[] = []
      const base = FIRST_SEEDED_AT + MINUTE * (seeded += 1000)
      for (let index = 0; index < count; index += 1) {
        const row = await createChannelConnection(owner, {
          storeId,
          channelType: 'test_channel',
          status,
          createdAt: new Date(base + index * MINUTE)
        })
        ids.push(row.id)
      }
      return ids
    }
    const page = (query: Record<string, string | number>, agent = asAdmin) =>
      agent().get(ApiRoutes.channels.connections).query(query)

    it('answers a page with the oldest first, a cursor, and no row twice', async () => {
      const ids = await seedMany(ctx.storeA.id, 5)
      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const response: { status: number; body: ConnectionPageBody } = await page({
          limit: 2,
          state: ChannelConnectionListStates.LIVE,
          ...(cursor === null ? {} : { cursor })
        })
        expect(response.status).toBe(OK)
        // A page is full unless it is the last
        if (response.body.hasMore) expect(response.body.data).toHaveLength(2)
        else expect(response.body.data.length).toBeLessThanOrEqual(2)
        seen.push(...response.body.data.map(row => row.id))
        expect(response.body.hasMore).toBe(response.body.nextCursor !== null)
        cursor = response.body.nextCursor
        pages += 1
      } while (cursor !== null)
      expect(pages).toBeGreaterThan(1)
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen).toEqual(expect.arrayContaining(ids))
      // The order is the creation order of the rows we made
      expect(seen.filter(id => ids.includes(id))).toEqual(ids)
    })

    it('keeps the live and the disconnected apart', async () => {
      const [live] = await seedMany(ctx.storeA.id, 1)
      const [gone] = await seedMany(ctx.storeA.id, 1, ChannelConnectionStatus.DISCONNECTED)
      const liveIds = (await page({ state: ChannelConnectionListStates.LIVE, limit: 100 }))
        .body as ConnectionPageBody
      const pastIds = (await page({ state: ChannelConnectionListStates.PAST, limit: 100 }))
        .body as ConnectionPageBody
      expect(liveIds.data.map(row => row.id)).toContain(live)
      expect(liveIds.data.map(row => row.id)).not.toContain(gone)
      expect(pastIds.data.map(row => row.id)).toContain(gone)
      expect(
        pastIds.data.every(row => row.status === String(ChannelConnectionStatus.DISCONNECTED))
      ).toBe(true)
    })

    it('answers a page of the default size, and exactly the limit asked', async () => {
      // One more than a page, whatever the other cases left in the store
      await seedMany(ctx.storeA.id, PaginationLimits.DEFAULT + 1)
      const byDefault = (await page({})).body as ConnectionPageBody
      expect(byDefault.data).toHaveLength(PaginationLimits.DEFAULT)
      expect(byDefault.hasMore).toBe(true)
      const three = (await page({ limit: 3 })).body as ConnectionPageBody
      expect(three.data).toHaveLength(3)
      expect(three.hasMore).toBe(true)
    })

    it('says there is no more only when the limit meets the last row', async () => {
      await seedMany(ctx.storeB.id, 2)
      const total = (await allConnections(asAdminB)).length
      expect(total).toBeGreaterThan(1)
      expect(total).toBeLessThanOrEqual(PaginationLimits.MAX)
      const exact = (await page({ limit: total }, asAdminB)).body as ConnectionPageBody
      expect(exact.data).toHaveLength(total)
      expect(exact.hasMore).toBe(false)
      expect(exact.nextCursor).toBeNull()
      const short = (await page({ limit: total - 1 }, asAdminB)).body as ConnectionPageBody
      expect(short.data).toHaveLength(total - 1)
      expect(short.hasMore).toBe(true)
      expect(short.nextCursor).not.toBeNull()
    })

    it('refuses a limit out of range and a state that is not one of ours', async () => {
      for (const limit of [0, PaginationLimits.MAX + 1, -1, 'x']) {
        const response = await page({ limit })
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect((await page({ state: 'everything' })).status).toBe(BAD_REQUEST)
    })

    it('refuses a cursor that is not ours', async () => {
      const response = await page({ cursor: 'not-a-cursor' })
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('never shows another store through a cursor taken from it', async () => {
      const mineB = await seedMany(ctx.storeB.id, 3)
      const first = (await page({ limit: 1 }, asAdminB)).body as ConnectionPageBody
      expect(first.nextCursor).not.toBeNull()
      const own = (await allConnections()).map(row => row.id)
      for (const id of mineB) expect(own).not.toContain(id)
      // The cursor of store B, used by store A, is only a position (a date and an id): what comes back
      // is rows of store A and of no other
      const stolen = (await page({ cursor: first.nextCursor ?? '', limit: 100 }))
        .body as ConnectionPageBody
      expect(stolen.data.length).toBeGreaterThan(0)
      for (const row of stolen.data) expect(own).toContain(row.id)
    })
  })

  describe('the directory for an agent', () => {
    it('names the channels of the store to who may not manage them, with no error text or date', async () => {
      const { id, plugin } = register()
      await connect(id)

      const settings = await asAgent().get(ApiRoutes.channels.connections)
      const list = await asAgent().get(ApiRoutes.channels.directory)

      expect(settings.status).toBe(FORBIDDEN)
      expect(list.status).toBe(OK)
      const item = (list.body as ConnectionBody[]).find(each => each.pluginId === id)
      expect(Object.keys(item ?? {}).sort()).toEqual([
        'capabilities',
        'descriptor',
        'displayName',
        'id',
        'limits',
        'media',
        'pluginId',
        'pluginName',
        'status'
      ])
      expect(item?.pluginName).toBe(plugin.name)
      expect((item as { descriptor?: unknown } | undefined)?.descriptor).toEqual({
        displayName: { es: plugin.name, en: plugin.name },
        iconKey: 'message-square',
        anonymousCustomers: false,
        managementSurface: null,
        helpSteps: []
      })
      expect((item as { limits?: unknown } | undefined)?.limits).toEqual({
        textMaxLength: plugin.limits.textMaxLength,
        caption: null
      })
      expect(item?.capabilities.slice().sort()).toEqual([...new Set(plugin.capabilities)].sort())
    })

    it('says what the channel takes of each kind of file, and one file per message while several are off', async () => {
      const takes = register({
        capabilities: [ChannelCapability.TEXT, ChannelCapability.IMAGE],
        media: {
          maxFilesPerMessage: 5,
          kinds: { image: { types: ['image/png'], maxBytes: 2048 } }
        }
      })
      const text = register({ capabilities: [ChannelCapability.TEXT] })
      await connect(takes.id)
      await connect(text.id)

      const list = await asAgent().get(ApiRoutes.channels.directory)

      const mediaOf = (pluginId: string) =>
        (list.body as { pluginId: string; media: unknown[] }[]).find(
          item => item.pluginId === pluginId
        )?.media
      // The switch for several files is off in the suite: the channel's five become one, as the route says
      expect(mediaOf(takes.id)).toEqual([
        {
          type: MessageType.IMAGE,
          maxFiles: 1,
          types: ['image/png'],
          maxBytes: 2048,
          captionsPerFile: false
        }
      ])
      // A channel with no file capability lists no kind
      expect(mediaOf(text.id)).toEqual([])
    })

    it('leaves out the connections of another store, and lists those of its own', async () => {
      const mine = register()
      const theirs = register()
      await connect(mine.id)
      await connect(theirs.id, asAdminB)

      const list = await asAgent().get(ApiRoutes.channels.directory)

      const ids = (list.body as ConnectionBody[]).map(item => item.pluginId)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
    })

    it('cleans and cuts the name a plugin gave itself, and falls back to its id', async () => {
      const long = register({ name: `  \u202EWhats${'x'.repeat(80)}\u{1F600}  ` })
      const blank = register({ name: '   ' })
      // A plugin of the kind the registry lets in: nothing checks `name` when it registers, so the case
      // forces the value the type forbids
      const missing = register({ name: undefined as unknown as string })
      const emoji = register({ name: `Shop \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u2028x\u200Bx` })
      await connect(long.id)
      await connect(blank.id)
      await connect(missing.id)
      await connect(emoji.id)

      const list = await asAgent().get(ApiRoutes.channels.directory)

      const nameOf = (pluginId: string) =>
        (list.body as ConnectionBody[]).find(item => item.pluginId === pluginId)?.pluginName
      expect(list.status).toBe(OK)
      expect(Array.from(nameOf(long.id) ?? '')).toHaveLength(60)
      expect(nameOf(long.id)).toMatch(/^Whatsx+$/)
      expect(nameOf(blank.id)).toBe(blank.id)
      expect(nameOf(missing.id)).toBe(missing.id)
      // The joiners of the emoji family stay; the separator and the zero width space become a space
      expect(nameOf(emoji.id)).toBe('Shop \u{1F468}\u200D\u{1F469}\u200D\u{1F467} x x')
    })

    it('tells a channel that is down, and one whose installation is gone, without saying why', async () => {
      const broken = register()
      const orphan = register()
      const brokenConnection = await connect(broken.id)
      const orphanConnection = await connect(orphan.id)
      await owner.channelConnection.update({
        where: { id: (brokenConnection.body as ConnectionBody).id },
        data: { status: ChannelConnectionStatus.ERROR, lastError: 'token expired: SECRET-DETAIL' }
      })
      await owner.pluginInstallation.updateMany({
        where: { storeId: ctx.storeA.id, pluginId: orphan.id },
        data: { status: PluginInstallationStatus.REVOKED }
      })

      const list = await asAgent().get(ApiRoutes.channels.directory)

      const statusOf = (connection: { body: unknown }) =>
        (list.body as ConnectionBody[]).find(
          item => item.id === (connection.body as ConnectionBody).id
        )?.status
      expect(statusOf(brokenConnection)).toBe(ChannelConnectionStatus.ERROR)
      expect(statusOf(orphanConnection)).toBe(ChannelConnectionStatus.ERROR)
      expect(JSON.stringify(list.body)).not.toContain('SECRET-DETAIL')
    })

    it('is open to a viewer, who may see conversations', async () => {
      const viewer = await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.channels.directory)

      expect(viewer.status).toBe(OK)
    })
  })

  describe('testing one', () => {
    it('puts it in error when the plugin says it is not well, and back when it is', async () => {
      let healthy = false
      const { id } = register({
        healthCheck: () =>
          Promise.resolve({
            healthy,
            checkedAt: new Date().toISOString(),
            ...(healthy ? {} : { error: `the token ${SECRET}\nwas revoked` })
          })
      })
      const made = (await connect(id)).body as ConnectionBody

      const down = await asAdmin().post(ApiRoutes.channels.test(made.id))
      const afterDown = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      healthy = true
      const up = await asAdmin().post(ApiRoutes.channels.test(made.id))
      const afterUp = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })

      expect(down.status).toBe(OK)
      expect(down.body).toMatchObject({ healthy: false })
      expect(afterDown.status).toBe(ChannelConnectionStatus.ERROR)
      expect(afterDown.lastError).not.toContain('\n')
      expect(up.body).toMatchObject({ healthy: true })
      expect(afterUp).toMatchObject({ status: ChannelConnectionStatus.ACTIVE, lastError: null })
    })

    it('says the credentials cannot be read when another key sealed them, with no error and no key in the answer', async () => {
      const { id } = register()
      const made = (await connect(id)).body as ConnectionBody
      // As if the connection were saved under a different encryption key
      await owner.channelConnection.update({
        where: { id: made.id },
        data: { credentials: new CredentialCipher(Buffer.alloc(32, 7)).seal({ token: SECRET }) }
      })

      const response = await asAdmin().post(ApiRoutes.channels.test(made.id))
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        healthy: false,
        error: ChannelHealthErrors.CREDENTIALS_UNREADABLE
      })
      expect(row).toMatchObject({
        status: ChannelConnectionStatus.ERROR,
        lastError: ChannelHealthErrors.CREDENTIALS_UNREADABLE
      })
      expect(JSON.stringify(response.body)).not.toMatch(/decrypt|wrong key|altered/i)
    })

    it('stores the reason of a plugin without the credential it repeated', async () => {
      const { id } = register({
        healthCheck: () =>
          Promise.resolve({
            healthy: false,
            checkedAt: new Date().toISOString(),
            error: `401 for Bearer ${SECRET} (access_token=${SECRET}, password: hunter2)`
          })
      })
      const made = (await connect(id)).body as ConnectionBody

      await asAdmin().post(ApiRoutes.channels.test(made.id))
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })

      expect(row.status).toBe(ChannelConnectionStatus.ERROR)
      expect(row.lastError).toBe(
        '401 for Bearer [redacted] (access_token=[redacted], password: [redacted])'
      )
    })

    it('counts a plugin that throws or answers nonsense as not well, and keeps what it said out', async () => {
      const throwing = register({ healthCheck: () => Promise.reject(new Error(`bad ${SECRET}`)) })
      const nonsense = register({ healthCheck: () => Promise.resolve({ ok: true } as never) })
      const a = (await connect(throwing.id)).body as ConnectionBody
      const b = (await connect(nonsense.id)).body as ConnectionBody

      const first = await asAdmin().post(ApiRoutes.channels.test(a.id))
      const second = await asAdmin().post(ApiRoutes.channels.test(b.id))

      expect(first.body).toMatchObject({ healthy: false })
      expect(second.body).toMatchObject({ healthy: false })
      expect(JSON.stringify([first.body, second.body])).not.toContain(SECRET)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: a.id } })
      expect(row.lastError ?? '').not.toContain(SECRET)
    })

    it("keeps what the owner has to fix as a name of the list, and nothing of the provider's text", async () => {
      const refused = register({
        healthCheck: () =>
          Promise.reject(
            new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
              reason: ChannelConnectFailureReasons.TOKEN_REJECTED,
              providerCode: 190
            })
          )
      })
      const made = (await connect(refused.id)).body as ConnectionBody

      const checked = await asAdmin().post(ApiRoutes.channels.test(made.id))

      expect(checked.body).toMatchObject({ healthy: false })
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.lastError).toBe('token_rejected')
      const listed = (await allConnections()).find(item => item.id === made.id)
      expect(listed).toMatchObject({ status: 'error', lastError: 'token_rejected' })
      expect(JSON.stringify([checked.body, listed])).not.toContain(SECRET)
    })

    it('keeps the code too when the reason is only invisible characters', async () => {
      const { id } = register({
        healthCheck: () =>
          Promise.resolve({
            healthy: false,
            checkedAt: new Date().toISOString(),
            error: '\u200B\u200B  '
          })
      })
      const made = (await connect(id)).body as ConnectionBody

      await asAdmin().post(ApiRoutes.channels.test(made.id))

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.lastError).toBe(ChannelHealthErrors.UNSPECIFIED)
    })

    it('keeps a code, not an English sentence, when the plugin gave no reason', async () => {
      const { id } = register({
        healthCheck: () => Promise.resolve({ healthy: false, checkedAt: new Date().toISOString() })
      })
      const made = (await connect(id)).body as ConnectionBody

      await asAdmin().post(ApiRoutes.channels.test(made.id))

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.lastError).toBe(ChannelHealthErrors.UNSPECIFIED)
    })

    it('does not reach the connection of another store', async () => {
      const { id } = register()
      const theirs = (await connect(id, asAdminB)).body as ConnectionBody

      const response = await asAdmin().post(ApiRoutes.channels.test(theirs.id))

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('the round of the scheduler', () => {
    it('checks every connection that is up or in error and says how many were not well', async () => {
      const well = register()
      const ill = register({
        healthCheck: () => Promise.resolve({ healthy: false, checkedAt: new Date().toISOString() })
      })
      const a = (await connect(well.id)).body as ConnectionBody
      const b = (await connect(ill.id)).body as ConnectionBody
      const plugins = new Map([well, ill].map(entry => [entry.id, entry.plugin]))

      const result = await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(pluginId => plugins.get(pluginId))

      expect(result.checked).toBeGreaterThanOrEqual(2)
      expect(result.unhealthy).toBeGreaterThanOrEqual(1)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: a.id } })).status
      ).toBe(ChannelConnectionStatus.ACTIVE)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: b.id } })).status
      ).toBe(ChannelConnectionStatus.ERROR)
    })

    it('does not undo a disconnect that happened while the check was running', async () => {
      const { id, plugin } = register()
      const made = (await connect(id)).body as ConnectionBody
      const stale = await owner.channelConnection.findUniqueOrThrow({
        where: { id: made.id },
        select: CONNECTION_ROW_SELECT
      })
      await asAdmin().post(ApiRoutes.channels.disconnect(made.id))
      const health = app.get(ChannelHealthService, { strict: false })

      await health.record(stale, { healthy: true })
      await health.record(stale, { healthy: false, error: 'late' })
      await health.checkAll(() => plugin, 0)

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
    })

    it('puts in error, with its own reason, a connection whose credentials cannot be opened, and goes on with the round', async () => {
      const { id, plugin } = register()
      // Written by a builder with bytes that this key never sealed, as after a change of key
      const installation = await ensurePluginInstallation(owner, {
        storeId: ctx.storeA.id,
        pluginId: id
      })
      const row = await owner.channelConnection.create({
        data: {
          storeId: ctx.storeA.id,
          pluginId: id,
          installationId: installation.id,
          connectionId: `broken-${randomUUID()}`,
          displayName: 'broken',
          credentials: Buffer.from('not a sealed value')
        }
      })

      const result = await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(pluginId => (pluginId === id ? plugin : undefined))

      expect(result.checked).toBeGreaterThanOrEqual(1)
      const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: row.id } })
      expect(after).toMatchObject({
        status: ChannelConnectionStatus.ERROR,
        lastError: ChannelHealthErrors.CREDENTIALS_UNREADABLE
      })
    })

    it('starts no check when the budget of the round is spent', async () => {
      const { id, plugin } = register()
      await connect(id)

      const result = await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(() => plugin, 0)

      expect(result).toEqual({ checked: 0, unhealthy: 0 })
    })

    it('leaves a connection alone when its plugin is not registered any more', async () => {
      const { id } = register()
      const made = (await connect(id)).body as ConnectionBody

      await app.get(ChannelHealthService, { strict: false }).checkAll(() => undefined)

      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })).status
      ).toBe(ChannelConnectionStatus.ACTIVE)
    })

    it('does not bring a disconnected connection back', async () => {
      const { id, plugin } = register()
      const made = (await connect(id)).body as ConnectionBody
      await asAdmin().post(ApiRoutes.channels.disconnect(made.id))

      await app
        .get(ChannelHealthService, { strict: false })
        .checkAll(pluginId => (pluginId === id ? plugin : undefined))

      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })).status
      ).toBe(ChannelConnectionStatus.DISCONNECTED)
    })
  })

  describe('disconnecting', () => {
    it('tells the provider, empties the credentials and keeps the row, once however often it is asked', async () => {
      const { id } = register()
      const made = (await connect(id)).body as ConnectionBody

      const first = await asAdmin().post(ApiRoutes.channels.disconnect(made.id))
      const second = await asAdmin().post(ApiRoutes.channels.disconnect(made.id))

      expect(first.status).toBe(OK)
      expect(first.body).toMatchObject({ status: 'disconnected' })
      expect(second.status).toBe(OK)
      expect(disconnected.filter(entry => entry === id)).toHaveLength(1)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
      expect(app.get(CredentialCipher, { strict: false }).open(row.credentials)).toEqual({})
      expect(await auditCount(AuditAction.CHANNEL_DISCONNECTED, made.id, 1)).toBe(1)
    })

    it('audits and announces one disconnect when two arrive at the same moment', async () => {
      const { id } = register()
      const made = (await connect(id)).body as ConnectionBody

      const [a, b] = await Promise.all([
        asAdmin().post(ApiRoutes.channels.disconnect(made.id)),
        asAdmin().post(ApiRoutes.channels.disconnect(made.id))
      ])

      expect([a.status, b.status]).toEqual([OK, OK])
      expect(await auditCount(AuditAction.CHANNEL_DISCONNECTED, made.id, 1)).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.CHANNEL_DISCONNECTED, resourceId: made.id }
        })
      ).toBe(1)
    })

    it('goes down here even when the provider does not answer', async () => {
      const { id } = register({ disconnect: () => Promise.reject(new Error(`down ${SECRET}`)) })
      const made = (await connect(id)).body as ConnectionBody

      const response = await asAdmin().post(ApiRoutes.channels.disconnect(made.id))

      expect(response.status).toBe(OK)
      expect(JSON.stringify(response.body)).not.toContain(SECRET)
    })

    it('does not reach the connection of another store', async () => {
      const { id } = register()
      const theirs = (await connect(id, asAdminB)).body as ConnectionBody

      const response = await asAdmin().post(ApiRoutes.channels.disconnect(theirs.id))

      expect(response.status).toBe(NOT_FOUND)
      expect(
        (await owner.channelConnection.findUniqueOrThrow({ where: { id: theirs.id } })).status
      ).toBe(ChannelConnectionStatus.ACTIVE)
    })
  })

  describe('the profile status of a connection', () => {
    const SETUP_KEY = 'settings.channels.setup.fakeProfileAccess'
    const profilePlugin = () =>
      register({
        capabilities: [ChannelCapability.TEXT, ChannelCapability.CUSTOMER_PROFILE],
        fetchProfile: () => Promise.resolve(null),
        profileSetupKey: SETUP_KEY
      })
    const connectionOf = async (agent: typeof asAdmin, pluginId: string) =>
      (await connect(pluginId, agent)).body as ConnectionBody
    // An identity of the store that failed to read, with a conversation through the connection
    async function failedIdentity(
      storeId: string,
      connectionId: string,
      pluginId: string,
      code: string | null,
      conversations = 1
    ) {
      const identity = await createCustomerIdentity(owner, { storeId, channelType: pluginId })
      await owner.customerIdentity.update({
        where: { id: identity.id },
        data: { profileFetchError: code }
      })
      for (let i = 0; i < conversations; i += 1) {
        await createConversation(owner, {
          storeId,
          customerId: identity.customerId,
          customerIdentityId: identity.id,
          channelType: pluginId,
          channelConnectionId: connectionId
        })
      }
      return identity
    }

    it('counts each failed customer once, by the code stored, and names the step to take', async () => {
      const { id } = profilePlugin()
      const made = await connectionOf(asAdmin, id)
      await failedIdentity(ctx.storeA.id, made.id, id, ErrorCodes.CHANNEL_CREDENTIALS_INVALID, 2)
      await failedIdentity(ctx.storeA.id, made.id, id, ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      await failedIdentity(ctx.storeA.id, made.id, id, ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE)
      await failedIdentity(ctx.storeA.id, made.id, id, null)

      const one = (await asAdmin().get(ApiRoutes.channels.connectionById(made.id)))
        .body as ConnectionBody
      const list = await allConnections()

      const expected = {
        failedIdentities: 3,
        errors: [
          { code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID, identities: 2 },
          { code: ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE, identities: 1 }
        ],
        setupKey: SETUP_KEY
      }
      expect(one.profile).toEqual(expected)
      expect(list.find(row => row.id === made.id)?.profile).toEqual(expected)
    })

    it('forgets the failed reads of its customers when the account is connected again, and asks for them anew', async () => {
      const { id } = profilePlugin()
      const made = await connectionOf(asAdmin, id)
      const failed = await failedIdentity(
        ctx.storeA.id,
        made.id,
        id,
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      )
      await owner.customerIdentity.update({
        where: { id: failed.id },
        data: { profileFetchedAt: new Date(), profileRetryAfter: new Date(Date.now() + 3_600_000) }
      })
      // A failure on another connection of the same store is not this connection's to forget
      const other = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: id
      })
      const elsewhere = await failedIdentity(
        ctx.storeA.id,
        other.id,
        id,
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      )

      const again = (await connect(id)).body as ConnectionBody

      expect(again.id).toBe(made.id)
      expect(again.profile).toEqual({ failedIdentities: 0, errors: [], setupKey: null })
      const forgotten = await owner.customerIdentity.findUniqueOrThrow({ where: { id: failed.id } })
      expect(forgotten).toMatchObject({
        profileFetchError: null,
        profileFetchedAt: null,
        profileRetryAfter: null
      })
      const kept = await owner.customerIdentity.findUniqueOrThrow({ where: { id: elsewhere.id } })
      expect(kept.profileFetchError).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    })

    it('leaves the read customers alone when the account is connected again', async () => {
      const { id } = profilePlugin()
      const made = await connectionOf(asAdmin, id)
      const read = await failedIdentity(ctx.storeA.id, made.id, id, null)
      const stamp = new Date('2026-10-01T00:00:00.000Z')
      await owner.customerIdentity.update({
        where: { id: read.id },
        data: { profileFetchedAt: stamp }
      })

      await connect(id)

      const row = await owner.customerIdentity.findUniqueOrThrow({ where: { id: read.id } })
      expect(row.profileFetchedAt?.toISOString()).toBe(stamp.toISOString())
    })

    it('says nothing is wrong, and gives no step, while no read has failed', async () => {
      const { id } = profilePlugin()
      const made = await connectionOf(asAdmin, id)
      await failedIdentity(ctx.storeA.id, made.id, id, null)

      expect(made.profile).toEqual({ failedIdentities: 0, errors: [], setupKey: null })
      const one = (await asAdmin().get(ApiRoutes.channels.connectionById(made.id)))
        .body as ConnectionBody
      expect(one.profile).toEqual({ failedIdentities: 0, errors: [], setupKey: null })
    })

    it('has no profile status for a channel that reads no profiles', async () => {
      const { id } = register()
      const made = await connectionOf(asAdmin, id)

      expect(made.profile).toBeNull()
      expect(
        ((await asAdmin().get(ApiRoutes.channels.connectionById(made.id))).body as ConnectionBody)
          .profile
      ).toBeNull()
    })

    it('counts only the customers that wrote through this connection of this store', async () => {
      const { id } = profilePlugin()
      const mine = await connectionOf(asAdmin, id)
      const theirs = await createChannelConnection(owner, {
        storeId: ctx.storeB.id,
        channelType: id
      })
      const other = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: id
      })
      await failedIdentity(ctx.storeA.id, mine.id, id, ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      // Another connection of the same store, and the connection of another store
      await failedIdentity(ctx.storeA.id, other.id, id, ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      await failedIdentity(ctx.storeB.id, theirs.id, id, ErrorCodes.CHANNEL_CREDENTIALS_INVALID)

      const own = (await asAdmin().get(ApiRoutes.channels.connectionById(mine.id)))
        .body as ConnectionBody
      const foreign = (await asAdminB().get(ApiRoutes.channels.connectionById(theirs.id)))
        .body as ConnectionBody

      expect(own.profile?.failedIdentities).toBe(1)
      // In the list the connections are counted in one query: each row keeps its own customers
      const list = await allConnections()
      expect(list.find(row => row.id === mine.id)?.profile?.failedIdentities).toBe(1)
      expect(list.find(row => row.id === other.id)?.profile?.failedIdentities).toBe(1)
      expect(list.some(row => row.id === theirs.id)).toBe(false)
      expect(foreign.profile?.failedIdentities).toBe(1)
      // A store cannot ask about the connection of another, so it cannot read its count either
      expect((await asAdmin().get(ApiRoutes.channels.connectionById(theirs.id))).status).toBe(
        NOT_FOUND
      )
    })

    it('does not give the profile status to the directory of an agent', async () => {
      const { id } = profilePlugin()
      await connectionOf(asAdmin, id)

      const response = await asAgent().get(ApiRoutes.channels.directory)

      expect(response.status).toBe(OK)
      for (const entry of response.body as object[]) expect(entry).not.toHaveProperty('profile')
      expect(JSON.stringify(response.body)).not.toContain(SETUP_KEY)
    })
  })
})
