import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { JwtService } from '@nestjs/jwt'
import type { Redis } from 'ioredis'
import { io, type Socket } from 'socket.io-client'

import { ApiRoutes } from '@platform/core/api'
import { Permissions, RoleNames } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import type { OwnerClient } from '@platform/core/database-testing'
import { ensureMembership } from '@platform/core/database-testing'
import { AuthorType, ChannelIds, ConversationStatus, MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { EventsBridge } from '@platform/core/event-bus'
import { Events, EVENTS_BRIDGE_CHANNEL } from '@platform/core/events'
import {
  PresenceStatus,
  RealtimeEvents,
  RealtimeNamespaces,
  PresenceTiming,
  RoomNames,
  SocketLimits
} from '@platform/core/realtime'
import { REDIS_CLIENT } from '@platform/core/redis'

import { PresenceService } from '../../apps/api/src/modules/realtime/presence.service'
import { RealtimeService } from '../../apps/api/src/modules/realtime/realtime.service'
import { REALTIME_TIMING } from '../../apps/api/src/modules/realtime/realtime.types'
import { SocketAccessService } from '../../apps/api/src/modules/realtime/socket-access.service'
import { TenantContextService } from '../../apps/api/src/modules/tenancy'
import { createConversationOf, createRole } from '../builders'
import { createTestApp } from '../helpers/app'
import { assertNoOtherBridgeListener } from '../helpers/bridge-listeners'
import {
  createActor as createActorRaw,
  seedTestContext,
  type TestContext
} from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const FORBIDDEN = 403
const WAIT_MS = 4000
const SETTLE_MS = 250
const POLL_MS = 20

interface Heard {
  event: string
  payload: Record<string, unknown>
}

// A connected socket and what it has heard since
class Probe {
  readonly heard: Heard[] = []
  constructor(readonly socket: Socket) {
    socket.onAny((event: string, payload: Record<string, unknown>) => {
      this.heard.push({ event, payload })
    })
  }
  of(event: string): Heard[] {
    return this.heard.filter(item => item.event === event)
  }
  join(conversationId: string): Promise<{ joined: boolean }> {
    return this.socket.timeout(WAIT_MS).emitWithAck(RealtimeEvents.JOIN_CONVERSATION, {
      conversationId
    }) as Promise<{ joined: boolean }>
  }
}

// Who a probe has been told is online (the store hears about everybody, itself included)
const onlineOf = (probe: Probe, userId: string): Heard[] =>
  probe.of(RealtimeEvents.USER_ONLINE).filter(item => item.payload['userId'] === userId)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(POLL_MS)
  }
  throw new Error('timed out waiting for the condition')
}

// The users the tests made, for the clean-up of what they leave in Redis
const madeActors: { id: string }[] = []
async function createActor(...args: Parameters<typeof createActorRaw>) {
  const actor = await createActorRaw(...args)
  madeActors.push(actor)
  return actor
}

// Whether the typing of `sender` in the room `blocked` reaches `watcher`. The sender then types in
// `control`, a room where it is allowed to stay: when that is heard, the first one has had its chance
// (a socket's messages are handled in order), so that "nothing arrived" is not just "not yet".
async function typingReaches(
  sender: Probe,
  watcher: Probe,
  blocked: string,
  control: string
): Promise<boolean> {
  const from = watcher.of(RealtimeEvents.TYPING_START).length
  sender.socket.emit(RealtimeEvents.TYPING_START, { conversationId: blocked })
  sender.socket.emit(RealtimeEvents.TYPING_START, { conversationId: control })
  const heard = (): Heard[] => watcher.of(RealtimeEvents.TYPING_START).slice(from)
  await until(() => heard().some(item => item.payload['conversationId'] === control))
  return heard().some(item => item.payload['conversationId'] === blocked)
}

describe('The realtime gateway', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let agent2: { id: string; email: string; token: string }
  let redis: Redis
  let presence: PresenceService
  const open: Socket[] = []

  beforeAll(async () => {
    await assertNoOtherBridgeListener()
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    agent2 = await createActor(owner, app, {
      prefix,
      name: 'agent2A',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
    redis = app.get<Redis>(REDIS_CLIENT)
    presence = app.get(PresenceService, { strict: false })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    const closing = open.splice(0).map(socket => {
      const id = socket.id
      socket.disconnect()
      return id
    })
    // Until the server has taken every closed socket out of the presence: a handler that ran after
    // the reset would leave a ghost for the next test
    await until(async () => {
      const pipeline = redis.pipeline()
      for (const key of presenceKeys()) {
        for (const id of closing) if (id !== undefined) pipeline.zscore(key, id)
      }
      const results = (await pipeline.exec()) ?? []
      return results.every(([, score]) => score === null)
    })
    await resetPresence()
  })

  // The sockets key of every user the suite has, in every store it has
  function presenceKeys(): string[] {
    const users = [ctx.adminA, ctx.agentA, ctx.viewerA, agent2, ctx.adminB, ...madeActors]
    const stores = [ctx.storeA, ctx.storeA2, ctx.storeB]
    return users.flatMap(user => stores.map(store => CacheKeys.presence.sockets(store.id, user.id)))
  }

  // The sockets, the handshakes and the presence of the users of the suite, so that a test does not
  // find what another left (a ghost socket counts toward the cap)
  async function resetPresence(): Promise<void> {
    const users = [ctx.adminA, ctx.agentA, ctx.viewerA, agent2, ctx.adminB, ...madeActors]
    const stores = [ctx.storeA, ctx.storeA2, ctx.storeB]
    const keys = [
      ...users.map(user => CacheKeys.realtime.handshakes(user.id)),
      ...users.flatMap(user =>
        stores.flatMap(store => [
          CacheKeys.presence.sockets(store.id, user.id),
          CacheKeys.presence.lastActivity(store.id, user.id)
        ])
      ),
      ...stores.map(store => CacheKeys.presence.store(store.id))
    ]
    await redis.del(...keys)
    // The handshakes counted by address (the tests all come from this machine)
    const byAddress = await redis.keys(CacheKeys.realtime.addressHandshakes('*'))
    if (byAddress.length > 0) await redis.del(...byAddress)
  }

  // What the worker has: a bridge that publishes (it holds no connection of its own)
  const workerBridge = (): EventsBridge =>
    new EventsBridge({ mode: 'publish' }, redis, app.get(EventEmitter2))
  // A message on the channel of the bridge as anyone with access to Redis could write it
  const rawPublish = (event: string, payload: unknown): Promise<number> =>
    redis.publish(EVENTS_BRIDGE_CHANNEL, JSON.stringify({ id: randomUUID(), event, payload }))

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const mk = (input: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...input })

  // Connects as `token` to `storeId` and resolves once the socket is accepted
  async function connect(
    token: string,
    storeId: string,
    target: INestApplication = app
  ): Promise<Probe> {
    const socket = io(`${await target.getUrl()}${RealtimeNamespaces.AGENTS}`, {
      auth: { token, storeId },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true
    })
    open.push(socket)
    const probe = new Probe(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
    })
    return probe
  }

  // The code of the refusal of a connection
  async function refusedWith(auth: Record<string, unknown>): Promise<unknown> {
    const socket = io(`${await app.getUrl()}${RealtimeNamespaces.AGENTS}`, {
      auth,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true
    })
    open.push(socket)
    return new Promise((resolve, reject) => {
      socket.once('connect', () => reject(new Error('the connection was accepted')))
      socket.once('connect_error', (error: Error & { data?: { code?: unknown } }) =>
        resolve(error.data?.code)
      )
    })
  }

  // 'open' when the connection was accepted (and closed again), the code when it was refused
  async function refusedWithOrOpen(
    auth: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<unknown> {
    const socket = io(`${await app.getUrl()}${RealtimeNamespaces.AGENTS}`, {
      auth,
      extraHeaders: headers,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true
    })
    return new Promise(resolve => {
      socket.once('connect', () => {
        socket.disconnect()
        resolve('open')
      })
      socket.once('connect_error', (error: Error & { data?: { code?: unknown } }) => {
        socket.disconnect()
        resolve(error.data?.code)
      })
    })
  }

  const asA = (actor: { token: string }) => connect(actor.token, ctx.storeA.id)

  describe('the connection', () => {
    it('is accepted with a good token for a store the user belongs to', async () => {
      const probe = await asA(ctx.agentA)

      expect(probe.socket.connected).toBe(true)
    })

    it('is refused without a token, with a token that does not verify, or with no store', async () => {
      expect(await refusedWith({ storeId: ctx.storeA.id })).toBe(ErrorCodes.AUTH_TOKEN_INVALID)
      expect(await refusedWith({ token: 'not-a-token', storeId: ctx.storeA.id })).toBe(
        ErrorCodes.AUTH_TOKEN_INVALID
      )
      expect(await refusedWith({ token: ctx.agentA.token })).toBe(ErrorCodes.AUTH_TOKEN_INVALID)
      expect(await refusedWith({ token: ctx.agentA.token, storeId: 'not-a-uuid' })).toBe(
        ErrorCodes.AUTH_TOKEN_INVALID
      )
    })

    it('is refused with an expired token, and says so', async () => {
      const expired = app
        .get(JwtService)
        .sign(
          { sub: ctx.agentA.id, sid: randomUUID(), email: ctx.agentA.email },
          { expiresIn: -10 }
        )

      expect(await refusedWith({ token: expired, storeId: ctx.storeA.id })).toBe(
        ErrorCodes.AUTH_TOKEN_EXPIRED
      )
    })

    it('is refused for a store the user does not belong to, as for one that does not exist', async () => {
      const elsewhere = await refusedWith({ token: ctx.adminB.token, storeId: ctx.storeA.id })
      const missing = await refusedWith({ token: ctx.adminB.token, storeId: randomUUID() })

      expect(elsewhere).toBe(ErrorCodes.TENANT_ACCESS_DENIED)
      expect(missing).toBe(elsewhere)
    })
  })

  describe('what the store hears', () => {
    it('lets two sockets of one store hear each other: a reply reaches both, and who comes online', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await until(() => onlineOf(admin, ctx.agentA.id).length === 1)
      const idempotencyKey = randomUUID()

      const sent = await asAgent()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: id,
          content: 'A secret price',
          idempotencyKey
        })
        .expect(CREATED)
      const messageId = (sent.body as { id: string }).id

      await until(() => admin.of(RealtimeEvents.MESSAGE_QUEUED).length === 1)
      await until(() => agent.of(RealtimeEvents.MESSAGE_QUEUED).length === 1)
      // Ids only: the text of a message travels through the api, which applies who may read it
      const expected = { conversationId: id, messageId, clientMessageId: idempotencyKey }
      expect(admin.of(RealtimeEvents.MESSAGE_QUEUED)[0]?.payload).toEqual(expected)
      expect(agent.of(RealtimeEvents.MESSAGE_QUEUED)[0]?.payload).toEqual(expected)
      expect(JSON.stringify([admin.heard, agent.heard])).not.toContain('A secret price')
      expect(onlineOf(admin, ctx.agentA.id)[0]?.payload).toEqual({ userId: ctx.agentA.id })
    })

    it('tells a socket of another store nothing of this one', async () => {
      const mine = await asA(ctx.agentA)
      const other = await connect(ctx.adminB.token, ctx.storeB.id)
      const { id } = await mk()

      await asAgent()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: id,
          content: 'Hello',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await until(() => mine.of(RealtimeEvents.MESSAGE_QUEUED).length === 1)
      await sleep(SETTLE_MS)

      expect(other.heard.filter(item => item.event !== RealtimeEvents.USER_ONLINE)).toEqual([])
      expect(JSON.stringify(other.heard)).not.toContain(ctx.agentA.id)
    })

    it('tells a reply to who may read the conversation and a note only to who may read notes', async () => {
      const agent = await asA(ctx.agentA)
      const viewer = await asA(ctx.viewerA)
      const { id } = await mk()

      const note = await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.INTERNAL_NOTE,
          conversationId: id,
          content: 'Do not tell',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await until(() => agent.of(RealtimeEvents.MESSAGE_NOTE_ADDED).length === 1)
      await sleep(SETTLE_MS)

      expect(agent.of(RealtimeEvents.MESSAGE_NOTE_ADDED)[0]?.payload).toEqual({
        conversationId: id,
        messageId: (note.body as { id: string }).id,
        createdAt: expect.any(String) as string
      })
      expect(viewer.of(RealtimeEvents.MESSAGE_NOTE_ADDED)).toEqual([])
      expect(JSON.stringify([agent.heard, viewer.heard])).not.toContain('Do not tell')

      // The reader who may not read notes hears a reply
      await asAgent()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: id,
          content: 'A reply',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await until(() => viewer.of(RealtimeEvents.MESSAGE_QUEUED).length === 1)
    })

    it('tells the edit and the deletion of a note only to who may read notes, with ids only', async () => {
      const agent = await asA(ctx.agentA)
      const viewer = await asA(ctx.viewerA)
      const { id } = await mk()
      const note = await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.INTERNAL_NOTE,
          conversationId: id,
          content: 'First draft',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      const noteId = (note.body as { id: string }).id

      await asAdmin()
        .patch(ApiRoutes.messages.byId(noteId))
        .send({ content: 'Second draft', version: 1 })
        .expect(OK)
      await asAdmin().delete(ApiRoutes.messages.byId(noteId)).expect(NO_CONTENT)
      await until(
        () =>
          agent.of(RealtimeEvents.MESSAGE_EDITED).length === 1 &&
          agent.of(RealtimeEvents.MESSAGE_DELETED).length === 1
      )
      await sleep(SETTLE_MS)

      expect(agent.of(RealtimeEvents.MESSAGE_EDITED)[0]?.payload).toEqual({
        conversationId: id,
        messageId: noteId
      })
      expect(agent.of(RealtimeEvents.MESSAGE_DELETED)[0]?.payload).toEqual({
        conversationId: id,
        messageId: noteId
      })
      expect(viewer.of(RealtimeEvents.MESSAGE_EDITED)).toEqual([])
      expect(viewer.of(RealtimeEvents.MESSAGE_DELETED)).toEqual([])
      expect(JSON.stringify([agent.heard, viewer.heard])).not.toContain('draft')
    })

    it('tells an assigned conversation to its assignee and who sees all, not to the others', async () => {
      const admin = await asA(ctx.adminA)
      const assignee = await asA(agent2)
      const bystander = await asA(ctx.agentA)
      const { id } = await mk({ assignedTo: agent2.id })

      await asAdmin()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.RESOLVED })
        .expect(OK)
      await until(() => admin.of(RealtimeEvents.CONVERSATION_STATUS_CHANGED).length === 1)
      await until(() => assignee.of(RealtimeEvents.CONVERSATION_STATUS_CHANGED).length === 1)
      await sleep(SETTLE_MS)

      expect(assignee.of(RealtimeEvents.CONVERSATION_STATUS_CHANGED)[0]?.payload).toEqual({
        conversationId: id,
        status: ConversationStatus.RESOLVED,
        previousStatus: ConversationStatus.OPEN
      })
      expect(bystander.of(RealtimeEvents.CONVERSATION_STATUS_CHANGED)).toEqual([])
    })

    it('tells the assignee who loses a conversation that it left, and not the others', async () => {
      const formerAssignee = await asA(agent2)
      const newAssignee = await asA(ctx.agentA)
      const viewer = await asA(ctx.viewerA)
      const { id } = await mk({ assignedTo: agent2.id })

      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: ctx.agentA.id })
        .expect(OK)
      await until(() => formerAssignee.of(RealtimeEvents.CONVERSATION_ASSIGNED).length === 1)
      await until(() => newAssignee.of(RealtimeEvents.CONVERSATION_ASSIGNED).length === 1)
      await sleep(SETTLE_MS)

      expect(newAssignee.of(RealtimeEvents.CONVERSATION_ASSIGNED)[0]?.payload).toEqual({
        conversationId: id,
        assignedTo: ctx.agentA.id,
        assignedBy: ctx.adminA.id
      })
      // The one who lost it hears who has it now, to drop it from their screen
      expect(formerAssignee.of(RealtimeEvents.CONVERSATION_ASSIGNED)[0]?.payload).toEqual({
        conversationId: id,
        assignedTo: ctx.agentA.id,
        assignedBy: ctx.adminA.id
      })
      expect(viewer.of(RealtimeEvents.CONVERSATION_ASSIGNED)).toEqual([])
    })

    it('keeps an archived conversation from who may not archive', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk({ status: ConversationStatus.RESOLVED })

      await asAdmin()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.ARCHIVED })
        .expect(OK)
      await until(() => admin.of(RealtimeEvents.CONVERSATION_STATUS_CHANGED).length === 1)
      await sleep(SETTLE_MS)

      // The agent saw the conversation before (it was open), so is told that it left; the next
      // event about it, now that it is hidden, does not reach the agent
      await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.INTERNAL_NOTE,
          conversationId: id,
          content: 'Archived note',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await until(() => admin.of(RealtimeEvents.MESSAGE_NOTE_ADDED).length === 1)
      await sleep(SETTLE_MS)

      expect(agent.of(RealtimeEvents.CONVERSATION_STATUS_CHANGED)).toHaveLength(1)
      expect(agent.of(RealtimeEvents.MESSAGE_NOTE_ADDED)).toEqual([])
    })

    it('tells what a user has read to their own sockets and to nobody else', async () => {
      const first = await asA(ctx.agentA)
      const second = await asA(ctx.agentA)
      const admin = await asA(ctx.adminA)
      const { id } = await mk()

      await asAgent().post(ApiRoutes.conversations.read(id)).expect(OK)
      await until(() => first.of(RealtimeEvents.CONVERSATION_READ).length === 1)
      await until(() => second.of(RealtimeEvents.CONVERSATION_READ).length === 1)
      await sleep(SETTLE_MS)

      expect(first.of(RealtimeEvents.CONVERSATION_READ)[0]?.payload).toEqual({
        conversationId: id,
        userId: ctx.agentA.id
      })
      expect(admin.of(RealtimeEvents.CONVERSATION_READ)).toEqual([])
    })
  })

  describe('joining a conversation', () => {
    it('is allowed for a conversation of the store that the user sees', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()

      expect(await agent.join(id)).toEqual({ joined: true })
    })

    it('is refused for a conversation of another store, one that does not exist and a bad id, all alike', async () => {
      const other = await mk()
      const elsewhere = await createConversationOf(owner, { storeId: ctx.storeB.id })
      const adminB = await connect(ctx.adminB.token, ctx.storeB.id)
      const agent = await asA(ctx.agentA)

      expect(await adminB.join(other.id)).toEqual({ joined: false })
      expect(await agent.join(elsewhere.id)).toEqual({ joined: false })
      expect(await agent.join(randomUUID())).toEqual({ joined: false })
      expect(await agent.join('not-a-uuid')).toEqual({ joined: false })
      expect(
        await (agent.socket.timeout(WAIT_MS).emitWithAck(RealtimeEvents.JOIN_CONVERSATION, {
          nonsense: true
        }) as Promise<unknown>)
      ).toEqual({ joined: false })
    })

    it('is refused for a conversation assigned to someone else, and for a hidden one, to who may not see it', async () => {
      const agent = await asA(ctx.agentA)
      const admin = await asA(ctx.adminA)
      const assigned = await mk({ assignedTo: agent2.id })
      const archived = await mk({ status: ConversationStatus.ARCHIVED })

      expect(await agent.join(assigned.id)).toEqual({ joined: false })
      expect(await agent.join(archived.id)).toEqual({ joined: false })
      expect(await admin.join(assigned.id)).toEqual({ joined: true })
      expect(await admin.join(archived.id)).toEqual({ joined: true })
    })

    it('relays typing to the others in the conversation, and only from a socket that is in it', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const outsider = await asA(agent2)
      const { id } = await mk()
      await admin.join(id)
      await agent.join(id)

      outsider.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      await until(() => admin.of(RealtimeEvents.TYPING_START).length === 1)
      await sleep(SETTLE_MS)

      expect(admin.of(RealtimeEvents.TYPING_START)).toEqual([
        {
          event: RealtimeEvents.TYPING_START,
          payload: { conversationId: id, userId: ctx.agentA.id, userName: 'agentA' }
        }
      ])
      // The socket that never joined sent one too, and nobody heard it
      expect(agent.of(RealtimeEvents.TYPING_START)).toEqual([])
    })

    it('allows a few conversations open at once and no more', async () => {
      const agent = await asA(ctx.agentA)
      const answers: boolean[] = []
      for (let opened = 0; opened < SocketLimits.MAX_CONVERSATION_ROOMS + 1; opened += 1) {
        const { id } = await mk()
        answers.push((await agent.join(id)).joined)
      }

      expect(answers.slice(0, SocketLimits.MAX_CONVERSATION_ROOMS).every(Boolean)).toBe(true)
      expect(answers[SocketLimits.MAX_CONVERSATION_ROOMS]).toBe(false)
    })

    it('treats an id in capitals as the same conversation', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      expect(await admin.join(id.toUpperCase())).toEqual({ joined: true })
      expect(await agent.join(id)).toEqual({ joined: true })

      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      await until(() => admin.of(RealtimeEvents.TYPING_START).length === 1)
    })

    it('still relays that someone stopped typing after the budget of the socket is spent', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await admin.join(id)
      await agent.join(id)

      for (
        let keystroke = 0;
        keystroke < SocketLimits.MAX_DB_EVENTS_PER_WINDOW + 5;
        keystroke += 1
      ) {
        agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      }
      agent.socket.emit(RealtimeEvents.TYPING_STOP, { conversationId: id })

      await until(() => admin.of(RealtimeEvents.TYPING_STOP).length === 1)
      // The join took one of the budget: the rest, and no more, got through
      expect(admin.of(RealtimeEvents.TYPING_START)).toHaveLength(
        SocketLimits.MAX_DB_EVENTS_PER_WINDOW - 1
      )
    })

    it('takes a socket out of a conversation room at once when the user may no longer see it', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      const control = await mk()
      for (const room of [id, control.id]) {
        await admin.join(room)
        await agent.join(room)
      }

      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: agent2.id })
        .expect(OK)
      await until(() => agent.of(RealtimeEvents.CONVERSATION_ASSIGNED).length === 1)
      await sleep(SETTLE_MS)

      expect(await typingReaches(agent, admin, id, control.id)).toBe(false)
    })

    it('tells the others that someone stopped typing when the conversation is taken from them', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await admin.join(id)
      await agent.join(id)
      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      await until(() => admin.of(RealtimeEvents.TYPING_START).length === 1)

      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: agent2.id })
        .expect(OK)

      await until(() => admin.of(RealtimeEvents.TYPING_STOP).length === 1)
      expect(admin.of(RealtimeEvents.TYPING_STOP)[0]?.payload).toEqual({
        conversationId: id,
        userId: ctx.agentA.id
      })
    })

    it('stops answering a socket that sends more than a person does', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()

      const answers: boolean[] = []
      for (let sent = 0; sent < SocketLimits.MAX_DB_EVENTS_PER_WINDOW + 5; sent += 1)
        answers.push((await agent.join(id)).joined)

      expect(answers.slice(0, 5)).toEqual([true, true, true, true, true])
      expect(answers.slice(-3)).toEqual([false, false, false])
    })
  })

  describe('who may not see conversations at all', () => {
    it('connects, but joins no conversation and hears nothing of them', async () => {
      const role = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.TEAM_VIEW]
      })
      const outsider = await createActor(owner, app, {
        prefix,
        name: 'noConversations',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: role.id
      })
      const probe = await asA(outsider)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()

      expect(await probe.join(id)).toEqual({ joined: false })
      await asAgent()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: id,
          content: 'Hello',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: agent2.id })
        .expect(OK)
      await until(() => agent.of(RealtimeEvents.MESSAGE_QUEUED).length === 1)
      await sleep(SETTLE_MS)

      expect(probe.heard.filter(item => item.event !== RealtimeEvents.USER_ONLINE)).toEqual([])
    })

    it('lets a member who may not write join a conversation but not show that they are typing', async () => {
      const admin = await asA(ctx.adminA)
      const viewer = await asA(ctx.viewerA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await admin.join(id)
      await agent.join(id)
      expect(await viewer.join(id)).toEqual({ joined: true })

      // The viewer types first, and an agent after: when the agent is heard, the viewer's had its turn
      viewer.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      await until(() => admin.of(RealtimeEvents.TYPING_START).length >= 1)
      await sleep(SETTLE_MS)

      const typists = admin.of(RealtimeEvents.TYPING_START).map(item => item.payload['userId'])
      expect(typists).toEqual([ctx.agentA.id])
    })
  })

  describe('a socket that asks too much', () => {
    it('is not let into more conversation rooms by messages that arrive together', async () => {
      const agent = await asA(ctx.agentA)
      const ids = await Promise.all(
        Array.from({ length: SocketLimits.MAX_CONVERSATION_ROOMS + 10 }, () =>
          mk().then(item => item.id)
        )
      )

      const answers = await Promise.all(ids.map(id => agent.join(id)))

      expect(answers.filter(answer => answer.joined)).toHaveLength(
        SocketLimits.MAX_CONVERSATION_ROOMS
      )
    })

    it('is refused a connection beyond the devices a person has', async () => {
      for (let device = 0; device < SocketLimits.MAX_SOCKETS_PER_USER; device += 1)
        await asA(ctx.viewerA)
      await sleep(SETTLE_MS)

      expect(await refusedWith({ token: ctx.viewerA.token, storeId: ctx.storeA.id })).toBe(
        ErrorCodes.RATE_LIMIT_EXCEEDED
      )
    })

    it('is cut off when it sends more than any client does', async () => {
      const probe = await asA(ctx.agentA)

      for (let sent = 0; sent < SocketLimits.MAX_EVENTS_PER_WINDOW + 50; sent += 1) {
        probe.socket.emit(RealtimeEvents.TYPING_STOP, { conversationId: randomUUID() })
      }

      await until(() => !probe.socket.connected)
    })
  })

  describe('the limits that must hold under concurrency and failure', () => {
    it('lets in no more sockets of a user than a person has devices, even when they arrive together', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: SocketLimits.MAX_SOCKETS_PER_USER + 20 }, () => asA(ctx.viewerA))
      )

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
        SocketLimits.MAX_SOCKETS_PER_USER
      )
    })

    it('refuses a user who tries to connect again and again', async () => {
      const looper = await createActor(owner, app, {
        prefix,
        name: 'looper',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.VIEWER]
      })
      let refused: unknown = null
      for (
        let attempt = 0;
        attempt < SocketLimits.MAX_HANDSHAKES_PER_MINUTE + 5 && refused === null;
        attempt += 1
      ) {
        const probe = await refusedWithOrOpen({ token: looper.token, storeId: ctx.storeA.id })
        if (probe !== 'open') refused = probe
      }

      expect(refused).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
    })

    it('tells what a user read only to their sockets of that store', async () => {
      const both = await createActor(owner, app, {
        prefix,
        name: 'twoStores',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      await ensureMembership(owner, {
        userId: both.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const here = await connect(both.token, ctx.storeA.id)
      const there = await connect(both.token, ctx.storeA2.id)
      const { id } = await mk()

      await api(app, both, ctx.storeA).post(ApiRoutes.conversations.read(id)).expect(OK)
      await until(() => here.of(RealtimeEvents.CONVERSATION_READ).length === 1)
      await sleep(SETTLE_MS)

      expect(there.of(RealtimeEvents.CONVERSATION_READ)).toEqual([])
    })

    it('takes a user out of the room of a conversation even when telling the others fails', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await admin.join(id)
      await agent.join(id)
      const spy = jest
        .spyOn(app.get(RealtimeService, { strict: false }), 'toStoreWhere')
        .mockRejectedValueOnce(new Error('fetchSockets timed out'))

      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: agent2.id })
        .expect(OK)
      await sleep(SETTLE_MS * 2)
      spy.mockRestore()
      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      await sleep(SETTLE_MS)

      expect(admin.of(RealtimeEvents.TYPING_START)).toEqual([])
    })

    it('does not leave in a room the user who lost the conversation while the join was checked', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk({ assignedTo: agent2.id })
      await admin.join(id)
      // The first look finds the conversation visible, as it was before the reassignment; the next,
      // after the join, finds the truth
      const spy = jest
        .spyOn(app.get(SocketAccessService, { strict: false }), 'mayJoin')
        .mockResolvedValueOnce(true)

      const answer = await agent.join(id)
      spy.mockRestore()
      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      await sleep(SETTLE_MS)

      expect(answer).toEqual({ joined: false })
      expect(admin.of(RealtimeEvents.TYPING_START)).toEqual([])
    })

    it('keeps counting a socket that went quiet a while ago, until the gateway has closed it', async () => {
      const key = CacheKeys.presence.sockets(ctx.storeA.id, ctx.viewerA.id)
      const ghosts = Array.from(
        { length: SocketLimits.MAX_SOCKETS_PER_USER },
        (_, index) => `quiet-${index}`
      )
      await redis.del(key)
      // Silent for 100 s: not online any more, not yet closed
      for (const ghost of ghosts)
        await redis.zadd(key, Date.now() - (SocketLimits.COUNTS_FOR_CAP_SECONDS - 50) * 1000, ghost)
      expect(await refusedWith({ token: ctx.viewerA.token, storeId: ctx.storeA.id })).toBe(
        ErrorCodes.RATE_LIMIT_EXCEEDED
      )

      // Silent for 200 s: long closed, so it holds no place
      await redis.del(key)
      for (const ghost of ghosts)
        await redis.zadd(key, Date.now() - (SocketLimits.COUNTS_FOR_CAP_SECONDS + 50) * 1000, ghost)
      const probe = await asA(ctx.viewerA)
      expect(probe.socket.connected).toBe(true)
    })

    it('does not leave in the room a user whose second look at the conversation fails', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      const control = await mk()
      await admin.join(id)
      await admin.join(control.id)
      await agent.join(control.id)
      const spy = jest
        .spyOn(app.get(SocketAccessService, { strict: false }), 'mayJoin')
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('database blip'))

      const answer = await agent.join(id)
      spy.mockRestore()

      expect(answer).toEqual({ joined: false })
      expect(await typingReaches(agent, admin, id, control.id)).toBe(false)
    })

    it('keeps the sockets of a user for as long as it counts them toward the cap', async () => {
      await asA(ctx.viewerA)
      const key = CacheKeys.presence.sockets(ctx.storeA.id, ctx.viewerA.id)

      expect(await redis.ttl(key)).toBeGreaterThan(SocketLimits.COUNTS_FOR_CAP_SECONDS - 50)
    })

    it('does not bring back a socket that is not registered with a heartbeat', async () => {
      const key = CacheKeys.presence.sockets(ctx.storeA.id, ctx.viewerA.id)

      const known = await presence.heartbeat(ctx.storeA.id, ctx.viewerA.id, 'a-closed-socket', true)

      expect(known).toBe(false)
      expect(await redis.zscore(key, 'a-closed-socket')).toBeNull()
    })

    it('does not take a user out of a room on the word of an event that the conversation does not bear out', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await admin.join(id)
      await agent.join(id)
      const onBus: string[] = []
      const noteAssignment = (event: string | string[]): void => {
        if (event === Events.CONVERSATION_ASSIGNED) onBus.push(event)
      }
      app.get(EventEmitter2).onAny(noteAssignment)

      // A late event that says the conversation went to someone else, while it is nobody's
      await rawPublish(Events.CONVERSATION_ASSIGNED, {
        storeId: ctx.storeA.id,
        conversationId: id,
        assignedTo: agent2.id,
        previousAssignee: null,
        assignedBy: { type: 'user', id: ctx.adminA.id },
        visibility: { hidden: false, assignedTo: agent2.id }
      })
      // Wait until the instance has passed it on, and its eviction ran
      try {
        await until(() => onBus.length >= 1)
        await sleep(SETTLE_MS * 2)
        agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })

        await until(() => admin.of(RealtimeEvents.TYPING_START).length === 1)
      } finally {
        app.get(EventEmitter2).offAny(noteAssignment)
      }
    })

    it('keeps delivering after a name that is a property of every object instead of an event', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await redis.publish(
        EVENTS_BRIDGE_CHANNEL,
        JSON.stringify({ id: randomUUID(), event: 'constructor', payload: {} })
      )
      const worker = workerBridge()
      worker.publish(Events.CONVERSATION_READ, {
        storeId: ctx.storeA.id,
        conversationId: id,
        userId: ctx.agentA.id,
        visibility: { hidden: false, assignedTo: null }
      })

      await until(() => agent.of(RealtimeEvents.CONVERSATION_READ).length >= 1)
    })

    it('relays that someone stopped typing only after they started', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await admin.join(id)
      await agent.join(id)

      agent.socket.emit(RealtimeEvents.TYPING_STOP, { conversationId: id })
      await sleep(SETTLE_MS)
      expect(admin.of(RealtimeEvents.TYPING_STOP)).toEqual([])

      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      agent.socket.emit(RealtimeEvents.TYPING_STOP, { conversationId: id })
      await until(() => admin.of(RealtimeEvents.TYPING_STOP).length === 1)
    })

    it('hears an event of the bridge whose ids come in capitals', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()

      await redis.publish(
        EVENTS_BRIDGE_CHANNEL,
        JSON.stringify({
          id: randomUUID(),
          event: Events.CONVERSATION_READ,
          payload: {
            storeId: ctx.storeA.id.toUpperCase(),
            conversationId: id.toUpperCase(),
            userId: ctx.agentA.id.toUpperCase(),
            visibility: { hidden: false, assignedTo: null }
          }
        })
      )

      await until(() => agent.of(RealtimeEvents.CONVERSATION_READ).length >= 1)
      expect(agent.of(RealtimeEvents.CONVERSATION_READ)[0]?.payload).toEqual({
        conversationId: id,
        userId: ctx.agentA.id
      })
    })

    it('keeps the entry of a slow socket when another one closes, so that its next heartbeat finds it', async () => {
      const closing = await asA(ctx.viewerA)
      const key = CacheKeys.presence.sockets(ctx.storeA.id, ctx.viewerA.id)
      // A tab whose timers are throttled: its last heartbeat was 90 s ago
      await redis.zadd(
        key,
        Date.now() - (PresenceTiming.SOCKET_TTL_SECONDS + 30) * 1000,
        'a-slow-background-tab'
      )

      const closingId = closing.socket.id as string
      closing.socket.disconnect()
      // Until the server has taken the closed socket out: only then is the other entry the survivor
      await until(async () => (await redis.zscore(key, closingId)) === null)

      expect(await redis.zscore(key, 'a-slow-background-tab')).not.toBeNull()
    })

    it('takes a user out of the room when the conversation cannot be read to check', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      const control = await mk()
      for (const room of [id, control.id]) {
        await admin.join(room)
        await agent.join(room)
      }
      const spy = jest
        .spyOn(app.get(SocketAccessService, { strict: false }), 'mayJoin')
        .mockRejectedValue(new Error('database blip'))

      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: agent2.id })
        .expect(OK)
      await sleep(SETTLE_MS * 2)
      spy.mockRestore()

      expect(await typingReaches(agent, admin, id, control.id)).toBe(false)
    })

    it('does not keep a client in the main namespace, which has nothing to serve', async () => {
      const socket = io(`${await app.getUrl()}/`, {
        transports: ['websocket'],
        reconnection: false
      })
      open.push(socket)

      const refused = await new Promise<boolean>(resolve => {
        socket.once('connect', () => resolve(false))
        socket.once('connect_error', () => resolve(true))
      })

      expect(refused).toBe(true)
    })

    it('tells the others that someone stopped typing when they leave the room or close the tab', async () => {
      const admin = await asA(ctx.adminA)
      const leaver = await asA(ctx.agentA)
      const closer = await asA(agent2)
      const { id } = await mk()
      await admin.join(id)
      await leaver.join(id)
      await closer.join(id)
      leaver.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      closer.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })
      await until(() => admin.of(RealtimeEvents.TYPING_START).length === 2)

      leaver.socket.emit(RealtimeEvents.LEAVE_CONVERSATION, { conversationId: id })
      closer.socket.disconnect()

      await until(() => admin.of(RealtimeEvents.TYPING_STOP).length === 2)
    })

    it('sends the bridge only the events the api acts on', async () => {
      const heardOnChannel: string[] = []
      const listener = redis.duplicate()
      listener.on('message', (_channel: string, message: string) => heardOnChannel.push(message))
      await listener.subscribe(EVENTS_BRIDGE_CHANNEL)
      const worker = workerBridge()

      try {
        worker.publish(Events.ORDER_CREATED, {
          storeId: ctx.storeA.id,
          contentPreview: 'A private message'
        })
        worker.publish(Events.CONVERSATION_READ, {
          storeId: ctx.storeA.id,
          conversationId: randomUUID(),
          userId: ctx.agentA.id,
          visibility: { hidden: false, assignedTo: null }
        })
        await until(() => heardOnChannel.length >= 1)
        await sleep(SETTLE_MS)
      } finally {
        await listener.quit()
      }

      expect(heardOnChannel).toHaveLength(1)
      expect(heardOnChannel.join()).not.toContain('A private message')
    })
  })

  describe('a socket that never says it is alive', () => {
    let impatient: INestApplication

    beforeAll(async () => {
      impatient = await createTestApp([], builder =>
        builder.overrideProvider(REALTIME_TIMING).useValue({ recheckMs: 100, silentMs: 600 })
      )
    })
    afterAll(async () => {
      await impatient.close()
    })

    it('is closed, so that it cannot hold a place the cap does not see', async () => {
      const probe = await connect(ctx.viewerA.token, ctx.storeA.id, impatient)

      await until(() => !probe.socket.connected)
    })
  })

  describe('what is asked of the handshake and of the messages', () => {
    it('does not let a user who retries keep the window of the budget open', async () => {
      const key = CacheKeys.realtime.handshakes(ctx.adminB.id)
      await redis.del(key)
      await refusedWithOrOpen({ token: ctx.adminB.token, storeId: ctx.storeB.id })
      await sleep(1200)
      await refusedWithOrOpen({ token: ctx.adminB.token, storeId: ctx.storeB.id })

      const left = await redis.ttl(key)
      expect(left).toBeGreaterThan(0)
      expect(left).toBeLessThanOrEqual(59)
    })

    it('refuses an address that tries too many times, however it writes the header', async () => {
      const address = `203.0.113.${Math.floor(Math.random() * 250) + 1}`
      const key = CacheKeys.realtime.addressHandshakes(address)
      let refused: unknown = null
      // The proxy appends the address it saw; whatever the client wrote before it changes each time
      for (
        let attempt = 0;
        attempt < SocketLimits.MAX_HANDSHAKES_PER_ADDRESS_PER_MINUTE + 5 && refused === null;
        attempt += 1
      ) {
        const code = await refusedWithOrOpen(
          { token: 'not-a-token', storeId: ctx.storeA.id },
          { 'x-forwarded-for': `10.9.${attempt % 250}.1, ${address}` }
        )
        if (code === ErrorCodes.RATE_LIMIT_EXCEEDED) refused = code
      }

      expect(refused).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
      // Another address is not touched by it, and is looked at as usual
      expect(
        await refusedWithOrOpen(
          { token: 'not-a-token', storeId: ctx.storeA.id },
          { 'x-forwarded-for': '203.0.113.251' }
        )
      ).toBe(ErrorCodes.AUTH_TOKEN_INVALID)
      expect(await redis.ttl(key)).toBeGreaterThan(0)
    })

    it('cuts off a socket that floods with names nobody listens to', async () => {
      const probe = await asA(ctx.agentA)

      for (let sent = 0; sent < SocketLimits.MAX_EVENTS_PER_WINDOW + 50; sent += 1)
        probe.socket.emit('nobody.listens', { n: sent })

      await until(() => !probe.socket.connected)
    })

    it('keeps a user who may read conversations but not messages out of their rooms', async () => {
      const role = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW]
      })
      const reader = await createActor(owner, app, {
        prefix,
        name: 'noMessages',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: role.id
      })
      const probe = await asA(reader)
      const { id } = await mk()

      expect(await probe.join(id)).toEqual({ joined: false })
    })
  })

  describe('presence', () => {
    it('keeps a user online while one of their two sockets is open, and offline when the last closes', async () => {
      const admin = await asA(ctx.adminA)
      const first = await asA(ctx.agentA)
      const second = await asA(ctx.agentA)
      await until(async () =>
        (await presence.getStorePresence(ctx.storeA.id)).some(item => item.userId === ctx.agentA.id)
      )

      const firstId = first.socket.id as string
      const key = CacheKeys.presence.sockets(ctx.storeA.id, ctx.agentA.id)
      first.socket.disconnect()
      await until(async () => (await redis.zscore(key, firstId)) === null)
      expect(await presence.getStorePresence(ctx.storeA.id)).toContainEqual({
        userId: ctx.agentA.id,
        status: PresenceStatus.ONLINE
      })
      expect(admin.of(RealtimeEvents.USER_OFFLINE)).toEqual([])

      second.socket.disconnect()
      await until(() => admin.of(RealtimeEvents.USER_OFFLINE).length === 1)

      expect(admin.of(RealtimeEvents.USER_OFFLINE)[0]?.payload).toEqual({ userId: ctx.agentA.id })
      expect(await presence.getStorePresence(ctx.storeA.id)).not.toContainEqual(
        expect.objectContaining({ userId: ctx.agentA.id })
      )
    })

    it('tells a user is online once, however many sockets they open', async () => {
      const admin = await asA(ctx.adminA)
      await asA(ctx.viewerA)
      await asA(ctx.viewerA)
      await until(() => onlineOf(admin, ctx.viewerA.id).length >= 1)
      await sleep(SETTLE_MS)

      expect(onlineOf(admin, ctx.viewerA.id)).toHaveLength(1)
    })

    const goIdle = async (): Promise<void> => {
      await until(async () =>
        (await presence.getStorePresence(ctx.storeA.id)).some(item => item.userId === ctx.agentA.id)
      )
      // Six minutes without activity
      await redis.set(
        CacheKeys.presence.lastActivity(ctx.storeA.id, ctx.agentA.id),
        Date.now() - (PresenceTiming.AWAY_AFTER_SECONDS + 60) * 1000
      )
    }
    const statusOfAgent = async (): Promise<PresenceStatus | undefined> =>
      (await presence.getStorePresence(ctx.storeA.id)).find(item => item.userId === ctx.agentA.id)
        ?.status

    it('turns a user who is idle for more than five minutes to away', async () => {
      await asA(ctx.agentA)
      await goIdle()

      expect(await statusOfAgent()).toBe(PresenceStatus.AWAY)
    })

    it('keeps a user away when a heartbeat says nothing happened', async () => {
      const agent = await asA(ctx.agentA)
      await goIdle()

      agent.socket.emit(RealtimeEvents.HEARTBEAT, {})
      await sleep(SETTLE_MS)

      expect(await statusOfAgent()).toBe(PresenceStatus.AWAY)
    })

    it('brings a user back from away with a heartbeat that says they are active', async () => {
      const agent = await asA(ctx.agentA)
      await goIdle()

      agent.socket.emit(RealtimeEvents.HEARTBEAT, { active: true })

      await until(async () => (await statusOfAgent()) === PresenceStatus.ONLINE)
    })

    it('brings a user back from away when they type', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      await agent.join(id)
      await goIdle()

      agent.socket.emit(RealtimeEvents.TYPING_START, { conversationId: id })

      await until(async () => (await statusOfAgent()) === PresenceStatus.ONLINE)
    })

    it('does not count a socket that stopped heartbeating, and says the user left with the last live one', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      await until(async () =>
        (await presence.getStorePresence(ctx.storeA.id)).some(item => item.userId === ctx.agentA.id)
      )
      // A tab on an instance that crashed: its heartbeat is ten minutes old
      await redis.zadd(
        CacheKeys.presence.sockets(ctx.storeA.id, ctx.agentA.id),
        Date.now() - (SocketLimits.COUNTS_FOR_CAP_SECONDS + 450) * 1000,
        'a-socket-of-a-dead-instance'
      )

      agent.socket.disconnect()
      await until(() => admin.of(RealtimeEvents.USER_OFFLINE).length === 1)

      expect(await presence.getStorePresence(ctx.storeA.id)).not.toContainEqual(
        expect.objectContaining({ userId: ctx.agentA.id })
      )
    })

    it('puts a user back in the store at the next heartbeat when the write at connect was lost', async () => {
      const agent = await asA(ctx.agentA)
      await until(async () =>
        (await presence.getStorePresence(ctx.storeA.id)).some(item => item.userId === ctx.agentA.id)
      )
      await redis.srem(CacheKeys.presence.store(ctx.storeA.id), ctx.agentA.id)

      agent.socket.emit(RealtimeEvents.HEARTBEAT, {})

      await until(async () =>
        (await presence.getStorePresence(ctx.storeA.id)).some(item => item.userId === ctx.agentA.id)
      )
    })

    it('keeps a user online when a page reload closes one socket as it opens the next', async () => {
      let current = await asA(ctx.agentA)
      for (let reload = 0; reload < 8; reload += 1) {
        const replacement = asA(ctx.agentA)
        const closedId = current.socket.id as string
        current.socket.disconnect()
        current = await replacement
        // The old socket is gone from the server for certain, so the user stands on the new one
        await until(
          async () =>
            (await redis.zscore(
              CacheKeys.presence.sockets(ctx.storeA.id, ctx.agentA.id),
              closedId
            )) === null
        )

        expect(await presence.getStorePresence(ctx.storeA.id)).toContainEqual(
          expect.objectContaining({ userId: ctx.agentA.id })
        )
      }
    })

    it('drops a user whose sockets expired without a disconnect', async () => {
      await asA(ctx.agentA)
      await until(async () =>
        (await presence.getStorePresence(ctx.storeA.id)).some(item => item.userId === ctx.agentA.id)
      )
      await redis.del(CacheKeys.presence.sockets(ctx.storeA.id, ctx.agentA.id))

      expect(await presence.getStorePresence(ctx.storeA.id)).not.toContainEqual(
        expect.objectContaining({ userId: ctx.agentA.id })
      )
      expect(await redis.sismember(CacheKeys.presence.store(ctx.storeA.id), ctx.agentA.id)).toBe(0)
    })
  })

  describe('a socket that lives on', () => {
    it('is disconnected at its next heartbeat once its user left the store', async () => {
      const leaver = await createActor(owner, app, {
        prefix,
        name: 'leaver',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const probe = await asA(leaver)
      await owner.membership.updateMany({
        where: { userId: leaver.id },
        data: { revokedAt: new Date() }
      })
      await app
        .get(TenantContextService, { strict: false })
        .invalidateUser(leaver.id, ctx.storeA.id)

      probe.socket.emit(RealtimeEvents.HEARTBEAT, {})
      await until(() => !probe.socket.connected)

      expect(probe.of(RealtimeEvents.AUTH_ERROR)).toEqual([
        { event: RealtimeEvents.AUTH_ERROR, payload: { code: ErrorCodes.TENANT_ACCESS_DENIED } }
      ])
    })

    it('is disconnected at its next heartbeat once its token expired', async () => {
      const shortLived = app
        .get(JwtService)
        .sign({ sub: ctx.agentA.id, sid: randomUUID(), email: ctx.agentA.email }, { expiresIn: 3 })
      const probe = await connect(shortLived, ctx.storeA.id)
      await sleep(3200)

      probe.socket.emit(RealtimeEvents.HEARTBEAT, {})
      await until(() => !probe.socket.connected)

      expect(probe.of(RealtimeEvents.AUTH_ERROR)).toEqual([
        { event: RealtimeEvents.AUTH_ERROR, payload: { code: ErrorCodes.AUTH_TOKEN_EXPIRED } }
      ])
    })

    it('stops hearing a conversation once it is assigned to someone else', async () => {
      const agent = await asA(ctx.agentA)
      const watcher = await asA(ctx.adminA)
      const { id } = await mk()
      await watcher.join(id)

      // The conversation goes to someone else: the agent hears it left, and a new reply no longer
      // reaches them
      await asAdmin()
        .patch(ApiRoutes.conversations.assign(id))
        .send({ userId: agent2.id })
        .expect(OK)
      await until(() => agent.of(RealtimeEvents.CONVERSATION_ASSIGNED).length === 1)
      await asAdmin()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: id,
          content: 'Later',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await until(() => watcher.of(RealtimeEvents.MESSAGE_QUEUED).length === 1)
      await sleep(SETTLE_MS)

      expect(agent.of(RealtimeEvents.MESSAGE_QUEUED)).toEqual([])
    })
  })

  describe('a socket that says nothing', () => {
    let watched: INestApplication

    // The gateway looks at its sockets every 200 ms here instead of every 30 s
    beforeAll(async () => {
      watched = await createTestApp([], builder =>
        builder.overrideProvider(REALTIME_TIMING).useValue({ recheckMs: 200, silentMs: 8000 })
      )
    })
    afterAll(async () => {
      await watched.close()
    })

    it('is disconnected when its user leaves the store, with no heartbeat from it', async () => {
      const leaver = await createActor(owner, watched, {
        prefix,
        name: 'silentLeaver',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const probe = await connect(leaver.token, ctx.storeA.id, watched)
      await owner.membership.updateMany({
        where: { userId: leaver.id },
        data: { revokedAt: new Date() }
      })
      await watched
        .get(TenantContextService, { strict: false })
        .invalidateUser(leaver.id, ctx.storeA.id)

      await until(() => !probe.socket.connected)

      expect(probe.of(RealtimeEvents.AUTH_ERROR)).toEqual([
        { event: RealtimeEvents.AUTH_ERROR, payload: { code: ErrorCodes.TENANT_ACCESS_DENIED } }
      ])
    })

    it('is disconnected when its token expires, with no heartbeat from it', async () => {
      const shortLived = watched
        .get(JwtService)
        .sign({ sub: ctx.agentA.id, sid: randomUUID(), email: ctx.agentA.email }, { expiresIn: 3 })
      const probe = await connect(shortLived, ctx.storeA.id, watched)

      await until(() => !probe.socket.connected)

      expect(probe.of(RealtimeEvents.AUTH_ERROR)).toEqual([
        { event: RealtimeEvents.AUTH_ERROR, payload: { code: ErrorCodes.AUTH_TOKEN_EXPIRED } }
      ])
    })

    it('leaves the room of a conversation that its user can no longer see', async () => {
      const admin = await connect(ctx.adminA.token, ctx.storeA.id, watched)
      const agent = await connect(ctx.agentA.token, ctx.storeA.id, watched)
      const { id } = await mk()
      const control = await mk()
      for (const room of [id, control.id]) {
        await admin.join(room)
        await agent.join(room)
      }
      // The socket does type in the room, before
      expect(await typingReaches(agent, admin, id, control.id)).toBe(true)

      // In the database and with no event: only the look the gateway takes by itself can notice
      await owner.conversation.update({ where: { id }, data: { assignedTo: agent2.id } })

      await until(async () => !(await typingReaches(agent, admin, id, control.id)))
    })
  })

  describe('across instances', () => {
    let second: INestApplication

    beforeAll(async () => {
      second = await createTestApp()
    })
    afterAll(async () => {
      await second.close()
    })

    it('does not send the access token of a socket to the other instances', async () => {
      const probe = await connect(ctx.agentA.token, ctx.storeA.id)
      const room = RoomNames.store(ctx.storeA.id)

      // What the other instance receives of a socket that the first holds
      const seenFromTheOther = async (): Promise<string> => {
        const sockets = await second.get(RealtimeService, { strict: false }).socketsIn(room)
        return JSON.stringify(
          sockets.filter(socket => socket.id === probe.socket.id).map(socket => socket.handshake)
        )
      }
      await until(async () => (await seenFromTheOther()) !== '[]')

      expect(await seenFromTheOther()).not.toContain(ctx.agentA.token)
    })

    it('reaches a socket held by another instance than the one that handled the request', async () => {
      const remote = await connect(ctx.adminA.token, ctx.storeA.id, second)
      const { id } = await mk()

      await asAgent()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.TEXT,
          conversationId: id,
          content: 'Across',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await until(() => remote.of(RealtimeEvents.MESSAGE_QUEUED).length === 1)

      expect(remote.of(RealtimeEvents.MESSAGE_QUEUED)[0]?.payload).toEqual(
        expect.objectContaining({ conversationId: id })
      )
    })

    it('drops what does not fit on the bridge, and keeps only the fields of the event', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      const heardOnBus: Record<string, unknown>[] = []
      // Either instance may be the one that takes the event
      const note = (event: string | string[], payload?: unknown): void => {
        heardOnBus.push({ event, ...(payload as Record<string, unknown>) })
      }
      for (const instance of [app, second]) instance.get(EventEmitter2).onAny(note)

      try {
        // An assignment with none of its fields, an event that is not one, a name every object has,
        // something that is not JSON, then a read with a text that does not belong to it
        await rawPublish(Events.CONVERSATION_ASSIGNED, { storeId: ctx.storeA.id })
        await rawPublish('not.an.event', { storeId: ctx.storeA.id })
        await rawPublish('constructor', {})
        await redis.publish(EVENTS_BRIDGE_CHANNEL, 'not json')
        await rawPublish(Events.CONVERSATION_READ, {
          storeId: ctx.storeA.id,
          conversationId: id,
          userId: ctx.agentA.id,
          visibility: { hidden: false, assignedTo: null },
          contentPreview: 'A private message'
        })

        await until(() => agent.of(RealtimeEvents.CONVERSATION_READ).length >= 1)
        await sleep(SETTLE_MS)
        expect(heardOnBus.map(item => item['event'])).toEqual([Events.CONVERSATION_READ])
        expect(JSON.stringify(heardOnBus)).not.toContain('A private message')
        expect(agent.of(RealtimeEvents.CONVERSATION_ASSIGNED)).toEqual([])
      } finally {
        for (const instance of [app, second]) instance.get(EventEmitter2).offAny(note)
      }
    })

    it('hears an event of the worker, which holds no sockets, through the bridge', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      // What the worker does: its DomainEvents hands the event to a bridge that publishes
      const worker = workerBridge()

      worker.publish(Events.CONVERSATION_READ, {
        storeId: ctx.storeA.id,
        conversationId: id,
        userId: ctx.agentA.id,
        visibility: { hidden: false, assignedTo: null }
      })
      worker.publish('not.an.event', { storeId: ctx.storeA.id })
      await redis.publish(EVENTS_BRIDGE_CHANNEL, 'not json')
      await until(() => agent.of(RealtimeEvents.CONVERSATION_READ).length >= 1)
      await sleep(SETTLE_MS)

      // Two instances heard it and one passed it on: the socket hears it once
      expect(agent.of(RealtimeEvents.CONVERSATION_READ)).toHaveLength(1)
      expect(agent.of(RealtimeEvents.CONVERSATION_READ)[0]?.payload).toEqual({
        conversationId: id,
        userId: ctx.agentA.id
      })
    })

    it('tells the inbox of a message and of a conversation that the worker received, with no text', async () => {
      const agent = await asA(ctx.agentA)
      const viewer = await asA(ctx.viewerA)
      const other = await connect(ctx.adminB.token, ctx.storeB.id)
      const { id } = await mk()
      const messageId = randomUUID()
      const customerId = randomUUID()
      const worker = workerBridge()

      worker.publish(Events.CONVERSATION_CREATED, {
        storeId: ctx.storeA.id,
        conversationId: id,
        customerId,
        channelType: ChannelIds.WHATSAPP,
        firstMessageId: messageId,
        firstMessageContent: 'A private first message',
        visibility: { hidden: false, assignedTo: null }
      })
      worker.publish(Events.MESSAGE_RECEIVED, {
        storeId: ctx.storeA.id,
        conversationId: id,
        messageId,
        customerId,
        channelType: ChannelIds.WHATSAPP,
        authorType: AuthorType.CUSTOMER,
        contentPreview: 'A private message',
        receivedAt: '2026-10-29T12:00:00.000Z',
        visibility: { hidden: false, assignedTo: null }
      })

      await until(
        () =>
          agent.of(RealtimeEvents.CONVERSATION_CREATED).length === 1 &&
          agent.of(RealtimeEvents.MESSAGE_RECEIVED).length === 1 &&
          viewer.of(RealtimeEvents.MESSAGE_RECEIVED).length === 1
      )
      await sleep(SETTLE_MS)

      expect(agent.of(RealtimeEvents.CONVERSATION_CREATED)[0]?.payload).toEqual({
        conversationId: id,
        customerId,
        channelType: ChannelIds.WHATSAPP
      })
      expect(agent.of(RealtimeEvents.MESSAGE_RECEIVED)[0]?.payload).toEqual({
        conversationId: id,
        messageId,
        authorType: AuthorType.CUSTOMER,
        createdAt: '2026-10-29T12:00:00.000Z'
      })
      expect(viewer.of(RealtimeEvents.MESSAGE_RECEIVED)[0]?.payload).toEqual(
        agent.of(RealtimeEvents.MESSAGE_RECEIVED)[0]?.payload
      )
      expect(JSON.stringify([agent.heard, viewer.heard, other.heard])).not.toContain('A private')
      expect(other.heard.filter(item => item.event !== RealtimeEvents.USER_ONLINE)).toEqual([])
    })

    it('tells a message of a conversation assigned to someone else only to who sees all of them', async () => {
      const admin = await asA(ctx.adminA)
      const agent = await asA(ctx.agentA)
      const { id } = await mk()
      const worker = workerBridge()

      worker.publish(Events.MESSAGE_RECEIVED, {
        storeId: ctx.storeA.id,
        conversationId: id,
        messageId: randomUUID(),
        customerId: randomUUID(),
        channelType: ChannelIds.WHATSAPP,
        authorType: AuthorType.CUSTOMER,
        contentPreview: null,
        receivedAt: '2026-10-29T12:00:00.000Z',
        visibility: { hidden: false, assignedTo: ctx.adminA.id }
      })

      await until(() => admin.of(RealtimeEvents.MESSAGE_RECEIVED).length === 1)
      await sleep(SETTLE_MS)

      expect(agent.of(RealtimeEvents.MESSAGE_RECEIVED)).toEqual([])
    })

    it('drops a message received whose fields do not fit', async () => {
      const agent = await asA(ctx.agentA)
      const { id } = await mk()

      await rawPublish(Events.MESSAGE_RECEIVED, { storeId: ctx.storeA.id, conversationId: id })
      await sleep(SETTLE_MS)

      expect(agent.of(RealtimeEvents.MESSAGE_RECEIVED)).toEqual([])
    })
  })

  describe('the presence route', () => {
    it('lists who of the team is connected to the store, and nobody of another store', async () => {
      await asA(ctx.agentA)
      await connect(ctx.adminB.token, ctx.storeB.id)

      let mine: Awaited<ReturnType<ReturnType<typeof asAdmin>['get']>> | undefined
      // The sockets are written to Redis as they connect: ask until the agent is there
      await until(async () => {
        mine = await asAdmin().get(ApiRoutes.presence.team).expect(OK)
        return (mine.body as { userId: string }[]).some(item => item.userId === ctx.agentA.id)
      })
      const theirs = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.presence.team).expect(OK)

      expect(mine?.body).toContainEqual({ userId: ctx.agentA.id, status: PresenceStatus.ONLINE })
      expect(JSON.stringify(mine?.body)).not.toContain(ctx.adminB.id)
      expect(JSON.stringify(theirs.body)).not.toContain(ctx.agentA.id)
    })

    it('is refused to who may not see conversations', async () => {
      const role = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.TEAM_VIEW]
      })
      const outsider = await createActor(owner, app, {
        prefix,
        name: 'noConversationsPresence',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: role.id
      })

      const response = await api(app, outsider, ctx.storeA).get(ApiRoutes.presence.team)

      expect(response.status).toBe(FORBIDDEN)
    })
  })
})
