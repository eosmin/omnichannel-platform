import type { INestApplication } from '@nestjs/common'

import { ApiError, createApiClient, fetchTeamPresence, sendMessage } from '@platform/api-client'
import { RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PresenceStatus, RealtimeEvents } from '@platform/core/realtime'

import {
  openRealtimeConnection,
  type RealtimeConnection
} from '../../apps/web/lib/realtime/connection'
import {
  type ConnectionStatusStore,
  ConnectionStatuses,
  createConnectionStatusStore
} from '../../apps/web/lib/realtime/connection-status'
import { OfflineQueue } from '../../apps/web/lib/realtime/offline-queue'
import { RealtimeClientTiming } from '../../apps/web/lib/realtime/realtime-config'
import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { assertNoOtherBridgeListener } from '../helpers/bridge-listeners'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const WAIT_MS = 6000
const POLL_MS = 20
const FAST_RECONNECT = {
  RECONNECT_DELAY_MS: 20,
  RECONNECT_DELAY_MAX_MS: 100,
  RED_BANNER_AFTER_FAILURES: 50
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(POLL_MS)
  }
  throw new Error(`timed out waiting for ${what}`)
}

interface Actor {
  id: string
  token: string
}

// The browser of one person: its socket, its queue and a network that the test can cut. A cut
// network refuses the request of the api and the request for a token, as a laptop with no wifi does.
interface Browser {
  connection: RealtimeConnection
  status: ConnectionStatusStore
  queue: OfflineQueue
  client: ReturnType<typeof createApiClient>
  network: { up: boolean }
}

describe('The realtime client against the real api', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let url: string
  let agent2: Actor
  const browsers: Browser[] = []

  beforeAll(async () => {
    await assertNoOtherBridgeListener()
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    url = await app.getUrl()
    agent2 = await createActor(owner, app, {
      prefix,
      name: 'agent2A',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
  })
  afterEach(() => {
    browsers.splice(0).forEach(browser => browser.connection.close())
  })
  afterAll(async () => {
    browsers.forEach(browser => browser.connection.close())
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  function browserOf(actor: Actor): Browser {
    const network = { up: true }
    const status = createConnectionStatusStore()
    const client = createApiClient({
      baseUrl: url,
      getAccessToken: () => actor.token,
      refreshAccessToken: () => Promise.resolve(actor.token),
      fetchImpl: (input, init) =>
        network.up ? fetch(input, init) : Promise.reject(new TypeError('fetch failed'))
    })
    const connection = openRealtimeConnection({
      url,
      storeId: ctx.storeA.id,
      getAccessToken: () =>
        network.up
          ? Promise.resolve(actor.token)
          : Promise.reject(new ApiError(0, ErrorCodes.INTERNAL_ERROR, 'offline')),
      status,
      timing: FAST_RECONNECT
    })
    const storage = new Map<string, string>()
    let counter = 0
    const queue = new OfflineQueue({
      storage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value)
      },
      send: (storeId, input) => sendMessage(client, storeId, input),
      newId: () => `queued-${prefix}-${++counter}`,
      now: () => new Date(),
      autoSendWindowMs: RealtimeClientTiming.QUEUE_AUTO_SEND_WINDOW_MS
    })
    connection.onConnect(() => void queue.flush(actor.id))
    const browser = { connection, status, queue, client, network }
    browsers.push(browser)
    return browser
  }

  const connected = (browser: Browser): Promise<void> =>
    until(() => browser.status.get() === ConnectionStatuses.CONNECTED, 'the socket to connect')

  const mk = () => createConversationOf(owner, { storeId: ctx.storeA.id })
  const messagesOf = (conversationId: string) =>
    owner.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } })

  it('sends once, when the connection returns, a message written while it was down', async () => {
    const agent = browserOf(ctx.agentA)
    await connected(agent)
    const { id: conversationId } = await mk()

    // The connection drops: the transport closes and the network does not come back at once
    agent.network.up = false
    agent.connection.socket.io.engine.close()
    await until(() => agent.status.get() !== ConnectionStatuses.CONNECTED, 'the loss to show')

    const pending = agent.queue.enqueue({
      userId: ctx.agentA.id,
      storeId: ctx.storeA.id,
      conversationId,
      type: MessageType.TEXT,
      content: 'written with no connection'
    })
    // An attempt while the network is down fails and keeps the message
    await agent.queue.flush(ctx.agentA.id)
    expect(agent.queue.waiting(ctx.agentA.id)).toHaveLength(1)
    expect(await messagesOf(conversationId)).toHaveLength(0)

    // It is back: the reconnection flushes the queue
    agent.network.up = true
    await connected(agent)
    await until(
      async () => (await messagesOf(conversationId)).length === 1,
      'the message to arrive'
    )

    expect(agent.queue.waiting(ctx.agentA.id)).toEqual([])
    const [stored] = await messagesOf(conversationId)
    expect(stored).toMatchObject({
      content: 'written with no connection',
      idempotencyKey: pending.id,
      authorId: ctx.agentA.id
    })

    // A second send of the same message (another tab flushing the same queue) is the message that
    // exists, not another one
    const again = await sendMessage(agent.client, ctx.storeA.id, {
      type: MessageType.TEXT,
      conversationId,
      content: 'written with no connection',
      idempotencyKey: pending.id
    })
    expect(again.id).toBe(stored?.id)
    expect(await messagesOf(conversationId)).toHaveLength(1)
  })

  it('lets two sockets of one store hear each other', async () => {
    const admin = browserOf(ctx.adminA)
    const heardOnline: unknown[] = []
    admin.connection.socket.on(RealtimeEvents.USER_ONLINE, payload => heardOnline.push(payload))
    await connected(admin)

    const agent = browserOf(agent2)
    await connected(agent)
    await until(
      () =>
        heardOnline.some(item => JSON.stringify(item) === JSON.stringify({ userId: agent2.id })),
      'the agent to be heard coming online'
    )

    const heardQueued: unknown[] = []
    admin.connection.socket.on(RealtimeEvents.MESSAGE_QUEUED, payload => heardQueued.push(payload))
    const { id: conversationId } = await mk()
    const pending = agent.queue.enqueue({
      userId: agent2.id,
      storeId: ctx.storeA.id,
      conversationId,
      type: MessageType.TEXT,
      content: 'seen by the other socket'
    })
    await agent.queue.flush(agent2.id)

    await until(() => heardQueued.length === 1, 'the other socket to hear the message')
    // The id of the request travels back, so the optimistic bubble can be matched to it
    expect(heardQueued[0]).toMatchObject({ conversationId, clientMessageId: pending.id })
  })

  it('reads the presence of the team once the sockets heartbeat', async () => {
    const viewer = browserOf(ctx.viewerA)
    await connected(viewer)
    const admin = browserOf(ctx.adminA)
    await connected(admin)

    await until(async () => {
      const team = await fetchTeamPresence(admin.client, ctx.storeA.id)
      return team.some(
        item => item.userId === ctx.viewerA.id && item.status === PresenceStatus.ONLINE
      )
    }, 'the viewer to show as online')
  })
})
