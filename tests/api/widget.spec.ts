import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { io, type Socket } from 'socket.io-client'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  BulkActions,
  ChannelConnectionStatus,
  ChannelIds,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  WIDGET_TOKEN_AUTH_KEY,
  WidgetClientEvents,
  WidgetSocketEvents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type CustomerTypingPayload,
  Events,
  type MessageStatusPayload
} from '@platform/core/events'
import { QueueNames } from '@platform/core/queues'
import { RealtimeNamespaces } from '@platform/core/realtime'
import { inboundJobId, type ProcessChannelEventJob } from '@platform/plugins/runtime'

import { AgentTypingRelay } from '../../apps/api/src/modules/realtime/agent-typing-relay.service'
import { createCustomerIdentity, ensurePluginInstallation } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'
import { CapturedQueue, queueOf } from '../helpers/queue'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const WAIT_MS = 5000
const POLL_MS = 25
const SITE = 'https://shop.example.com'
const OTHER_SITE = 'https://evil.example.org'

interface ErrorBody {
  error: { code: string }
}
interface MessageBody {
  id: string
  from: string
  content: string
  createdAt: string
}
interface BootstrapBody {
  visitorToken: string
  expiresInSeconds: number
  store: { name: string; locale: string }
  away: boolean
  messages: MessageBody[]
  readUpToMessageId: string | null
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(POLL_MS)
  }
  throw new Error('timed out waiting for the condition')
}

describe('The web widget', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const open: Socket[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.INBOUND)).useValue(new CapturedQueue())
    )
    ctx = await seedTestContext(owner, app, prefix)
    await ensurePluginInstallation(owner, {
      storeId: ctx.storeA.id,
      pluginId: ChannelIds.WEB_WIDGET
    })
    await ensurePluginInstallation(owner, {
      storeId: ctx.storeB.id,
      pluginId: ChannelIds.WEB_WIDGET
    })
  })
  afterAll(async () => {
    for (const socket of open) socket.close()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const queued = () => queueOf(app, QueueNames.INBOUND).jobs

  // A connection made as the owner of the store does it, through the api
  async function connectWidget(
    actor: typeof ctx.adminA,
    store: typeof ctx.storeA,
    siteOrigins: string[] = [SITE]
  ): Promise<string> {
    const response = await api(app, actor, store)
      .post(ApiRoutes.channels.connect(ChannelIds.WEB_WIDGET))
      .send({ credentials: { siteOrigins } })
      .expect(CREATED)
    const row = await owner.channelConnection.findUniqueOrThrow({
      where: { id: (response.body as { id: string }).id },
      select: { connectionId: true }
    })
    return row.connectionId
  }

  const bootstrap = (siteKey: string, visitorId: string, origin: string | null = SITE) => {
    const request = anonymousApi(app).post(ApiRoutes.widget.bootstrap).send({ siteKey, visitorId })
    return origin === null ? request : request.set('origin', origin)
  }
  const send = (body: unknown, origin: string | null = SITE) => {
    const request = anonymousApi(app)
      .post(ApiRoutes.widget.messages)
      .send(body as object)
    return origin === null ? request : request.set('origin', origin)
  }
  const enter = async (siteKey: string, visitorId: string = randomUUID()) => {
    const response = await bootstrap(siteKey, visitorId).expect(OK)
    return { visitorId, ...(response.body as BootstrapBody) }
  }

  describe('connecting', () => {
    it('makes a site key for the sites that are listed, and keeps them', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA, [SITE, `${SITE}/`])

      expect(siteKey).toMatch(/^pk_widget_[A-Za-z0-9_-]{24}$/)
      const row = await owner.channelConnection.findFirstOrThrow({
        where: { pluginId: ChannelIds.WEB_WIDGET, connectionId: siteKey }
      })
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(row.metadata).toEqual({ allowedOrigins: [SITE] })
    })

    it('refuses a list that is not made of origins', async () => {
      const response = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.channels.connect(ChannelIds.WEB_WIDGET))
        .send({ credentials: { siteOrigins: ['https://shop.example.com/page'] } })

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('the bootstrap', () => {
    let siteKey: string
    beforeAll(async () => {
      siteKey = await connectWidget(ctx.adminA, ctx.storeA)
    })

    it('gives a visitor a token, the name of the store and no history to a stranger', async () => {
      const response = await bootstrap(siteKey, randomUUID())

      expect(response.status).toBe(OK)
      const body = response.body as BootstrapBody
      expect(body.visitorToken).toEqual(expect.any(String))
      expect(body.expiresInSeconds).toBe(3600)
      expect(body.store.name).toBe(`${prefix}-store-a`)
      expect(body.store.locale).toBe('es')
      expect(body.away).toBe(false)
      expect(body.messages).toEqual([])
      expect(response.headers['access-control-allow-origin']).toBe(SITE)
    })

    it('answers the preflight of a browser for the origin that asks, and grants nothing else', async () => {
      const response = await anonymousApi(app)
        .options(ApiRoutes.widget.bootstrap)
        .set('origin', OTHER_SITE)
        .set('access-control-request-method', 'POST')

      expect(response.status).toBe(NO_CONTENT)
      expect(response.headers['access-control-allow-methods']).toBe('POST')
      const post = await bootstrap(siteKey, randomUUID(), OTHER_SITE)
      expect(post.status).toBe(FORBIDDEN)
      expect(post.headers['access-control-allow-origin']).toBeUndefined()
    })

    it.each([
      ['a site that is not listed', OTHER_SITE],
      ['a request that names no site', null]
    ])('refuses %s', async (_name, origin) => {
      const response = await bootstrap(siteKey, randomUUID(), origin)

      expect(response.status).toBe(FORBIDDEN)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED)
    })

    it('says "not found" alike for a key that never existed, one of another shape and a bad visitor', async () => {
      const unknown = await bootstrap('pk_widget_AAAAAAAAAAAAAAAAAAAAAAAA', randomUUID())
      const malformed = await bootstrap('nope', randomUUID())
      const badVisitor = await bootstrap(siteKey, 'not-a-uuid')

      expect(unknown.status).toBe(NOT_FOUND)
      expect(malformed.status).toBe(NOT_FOUND)
      expect(badVisitor.status).toBe(BAD_REQUEST)
    })

    it('stops answering once the connection is disconnected', async () => {
      const key = await connectWidget(ctx.adminA, ctx.storeA)
      await owner.channelConnection.updateMany({
        where: { connectionId: key },
        data: { status: ChannelConnectionStatus.DISCONNECTED }
      })

      expect((await bootstrap(key, randomUUID())).status).toBe(NOT_FOUND)
    })

    it('says the store is away outside its business hours, and not inside them', async () => {
      const everyDay = (ranges: object[]) => ({
        mon: ranges,
        tue: ranges,
        wed: ranges,
        thu: ranges,
        fri: ranges,
        sat: ranges,
        sun: ranges
      })
      await owner.businessHours.upsert({
        where: { storeId: ctx.storeA.id },
        create: { storeId: ctx.storeA.id, timezone: 'UTC', schedule: everyDay([]) },
        update: { timezone: 'UTC', schedule: everyDay([]) }
      })
      expect((await enter(siteKey)).away).toBe(true)

      await owner.businessHours.update({
        where: { storeId: ctx.storeA.id },
        data: { schedule: everyDay([{ from: '00:00', to: '24:00' }]) }
      })
      expect((await enter(siteKey)).away).toBe(false)
    })
  })

  describe('a message of the visitor', () => {
    let siteKey: string
    beforeAll(async () => {
      siteKey = await connectWidget(ctx.adminA, ctx.storeA)
    })

    it('goes to the inbound queue as the event of its visitor, once however often it is sent', async () => {
      const visitor = await enter(siteKey)
      queued().length = 0
      const body = {
        visitorToken: visitor.visitorToken,
        clientMessageId: randomUUID(),
        content: 'Hola, ¿envían a Santa Ana?'
      }

      const first = await send(body)
      const again = await send(body)

      expect(first.status).toBe(OK)
      expect(first.body).toEqual({ received: true })
      expect(again.status).toBe(OK)
      expect(queued()).toHaveLength(2)
      const [job, repeat] = queued()
      const data = job?.data as ProcessChannelEventJob
      expect(data.pluginId).toBe(ChannelIds.WEB_WIDGET)
      expect(data.event).toMatchObject({
        connectionId: siteKey,
        channelIdentity: visitor.visitorId,
        message: { type: MessageType.TEXT, content: 'Hola, ¿envían a Santa Ana?' }
      })
      expect(job?.opts?.jobId).toBe(inboundJobId(ChannelIds.WEB_WIDGET, data.event))
      expect(repeat?.opts?.jobId).toBe(job?.opts?.jobId)
    })

    it('lets the browser read the refusal of a token, so that the widget knows to start again', async () => {
      const response = await send({
        visitorToken: 'x.y',
        clientMessageId: 'e1',
        content: 'hola'
      })

      expect(response.status).toBe(UNAUTHORIZED)
      expect(response.headers['access-control-allow-origin']).toBe(SITE)
    })

    it('refuses a text of control characters or of nothing visible', async () => {
      const visitor = await enter(siteKey)
      for (const content of ['hola\u0000', 'a\u0007b', '\u200b\u200b', '\u200b \u2060']) {
        const response = await send({
          visitorToken: visitor.visitorToken,
          clientMessageId: 'c1',
          content
        })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('refuses a token that is not ours, and queues nothing', async () => {
      queued().length = 0
      const visitor = await enter(siteKey)
      const forged = `${visitor.visitorToken.split('.')[0]}.${'A'.repeat(43)}`

      for (const visitorToken of [forged, 'x.y', 'garbage']) {
        const response = await send({ visitorToken, clientMessageId: 'a1', content: 'hola' })
        expect(response.status).toBe(UNAUTHORIZED)
        expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.WIDGET_TOKEN_INVALID)
      }
      expect(queued()).toEqual([])
    })

    it('is not reachable through the generic webhook of the channels, which skips the origin and the limits', async () => {
      queued().length = 0
      const visitor = await enter(siteKey)
      const body = {
        visitorToken: visitor.visitorToken,
        clientMessageId: 'g1',
        content: 'hola'
      }

      const response = await anonymousApi(app)
        .post(ApiRoutes.webhooks.channel(ChannelIds.WEB_WIDGET))
        .set('x-widget-token', visitor.visitorToken)
        .send(body)

      expect(response.status).toBe(NOT_FOUND)
      expect(queued()).toEqual([])
    })

    it('refuses a token whose signature was re-encoded into another string', async () => {
      queued().length = 0
      const visitor = await enter(siteKey)

      const response = await send({
        visitorToken: `${visitor.visitorToken}=`,
        clientMessageId: 'g2',
        content: 'hola'
      })

      expect(response.status).toBe(UNAUTHORIZED)
      expect(queued()).toEqual([])
    })

    it('refuses a message from a site that is not listed, even with a good token', async () => {
      queued().length = 0
      const visitor = await enter(siteKey)

      const response = await send(
        { visitorToken: visitor.visitorToken, clientMessageId: 'a2', content: 'hola' },
        OTHER_SITE
      )

      expect(response.status).toBe(FORBIDDEN)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED)
      expect(queued()).toEqual([])
    })

    it('cannot be used with the token of a key of another store, from the site of this one', async () => {
      const foreignKey = await connectWidget(ctx.adminB, ctx.storeB, [OTHER_SITE])
      const foreign = await bootstrap(foreignKey, randomUUID(), OTHER_SITE).expect(OK)
      queued().length = 0

      // The token says store B's key: the origin of store A's site is not on that key's list
      const response = await send({
        visitorToken: (foreign.body as BootstrapBody).visitorToken,
        clientMessageId: 'a3',
        content: 'hola'
      })

      expect(response.status).toBe(FORBIDDEN)
      expect(queued()).toEqual([])
    })

    it('refuses a text that is empty, too long or without an id the browser made', async () => {
      const visitor = await enter(siteKey)
      const base = { visitorToken: visitor.visitorToken, clientMessageId: 'ok-1', content: 'hola' }

      for (const bad of [
        { ...base, content: '   ' },
        { ...base, content: 'x'.repeat(2001) },
        { ...base, clientMessageId: 'has space' },
        { visitorToken: visitor.visitorToken, content: 'hola' }
      ]) {
        expect((await send(bad)).status).toBe(BAD_REQUEST)
      }
    })

    it('stops being taken once the connection is gone', async () => {
      const key = await connectWidget(ctx.adminA, ctx.storeA)
      const visitor = await enter(key)
      await owner.channelConnection.updateMany({
        where: { connectionId: key },
        data: { status: ChannelConnectionStatus.DISCONNECTED }
      })
      queued().length = 0

      const response = await send({
        visitorToken: visitor.visitorToken,
        clientMessageId: 'a4',
        content: 'hola'
      })

      expect(response.status).toBe(NOT_FOUND)
      expect(queued()).toEqual([])
    })
  })

  describe('the history of a visitor', () => {
    it('is what they and the store said, in order, and nothing else', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const connection = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: siteKey },
        select: { id: true }
      })
      const visitorId = randomUUID()
      const stranger = randomUUID()
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitorId
      })
      const strangerIdentity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: stranger
      })
      const conversationOf = (customerId: string, customerIdentityId: string) =>
        owner.conversation.create({
          data: {
            storeId: ctx.storeA.id,
            customerId,
            customerIdentityId,
            channelConnectionId: connection.id,
            channelType: ChannelIds.WEB_WIDGET
          },
          select: { id: true }
        })
      const mine = await conversationOf(identity.customerId, identity.id)
      const theirs = await conversationOf(strangerIdentity.customerId, strangerIdentity.id)
      const at = (seconds: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, seconds))
      const write = (
        conversationId: string,
        seconds: number,
        over: Partial<{
          content: string | null
          authorType: AuthorType
          type: MessageType
          deliveryStatus: DeliveryStatus
          deletedAt: Date
        }> = {}
      ) =>
        owner.message.create({
          data: {
            storeId: ctx.storeA.id,
            conversationId,
            type: over.type ?? MessageType.TEXT,
            content: over.content === undefined ? `m${seconds}` : over.content,
            authorType: over.authorType ?? AuthorType.CUSTOMER,
            createdAt: at(seconds),
            ...(over.deliveryStatus === undefined ? {} : { deliveryStatus: over.deliveryStatus }),
            ...(over.deletedAt === undefined ? {} : { deletedAt: over.deletedAt })
          }
        })
      await write(mine.id, 1)
      await write(mine.id, 2, { authorType: AuthorType.AGENT, deliveryStatus: DeliveryStatus.SENT })
      await write(mine.id, 3, {
        authorType: AuthorType.AGENT,
        deliveryStatus: DeliveryStatus.QUEUED
      })
      await write(mine.id, 4, {
        authorType: AuthorType.AGENT,
        deliveryStatus: DeliveryStatus.FAILED
      })
      await write(mine.id, 5, { type: MessageType.INTERNAL_NOTE, authorType: AuthorType.AGENT })
      await write(mine.id, 6, { type: MessageType.SYSTEM, authorType: AuthorType.SYSTEM })
      await write(mine.id, 7, { deletedAt: at(8) })
      await write(mine.id, 9, { content: null })
      await write(mine.id, 10)
      await write(theirs.id, 11)

      const history = await enter(siteKey, visitorId)
      const nobody = await enter(siteKey)

      expect(history.messages.map(message => [message.from, message.content])).toEqual([
        ['visitor', 'm1'],
        ['team', 'm2'],
        ['visitor', 'm10']
      ])
      expect(nobody.messages).toEqual([])
    })
  })

  describe('the socket of a visitor', () => {
    async function connectSocket(
      auth: Record<string, unknown>,
      origin: string | null = SITE
    ): Promise<Socket> {
      const socket = io(`${await app.getUrl()}${RealtimeNamespaces.WIDGET}`, {
        auth,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        ...(origin === null ? {} : { extraHeaders: { origin } })
      })
      open.push(socket)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
      })
      return socket
    }
    const refusedWith = async (
      auth: Record<string, unknown>,
      origin: string | null = SITE
    ): Promise<unknown> => {
      const error = await connectSocket(auth, origin).then(
        () => null,
        (caught: Error & { data?: { code?: unknown } }) => caught
      )
      return error?.data?.code
    }

    // The conversation the store holds with a visitor
    async function conversationFor(
      siteKey: string,
      visitorId: string,
      status: ConversationStatus = ConversationStatus.OPEN
    ): Promise<string> {
      const connection = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: siteKey },
        select: { id: true }
      })
      const identity = await owner.customerIdentity.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, channelIdentity: visitorId },
        select: { id: true, customerId: true }
      })
      const conversation = await owner.conversation.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: identity.customerId,
          customerIdentityId: identity.id,
          channelConnectionId: connection.id,
          channelType: ChannelIds.WEB_WIDGET,
          status
        },
        select: { id: true }
      })
      return conversation.id
    }

    // A reply of the team that the channel took, as the worker announces it
    async function reply(siteKey: string, visitorId: string, content: string) {
      const conversationId = await conversationFor(siteKey, visitorId)
      const message = await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId,
          type: MessageType.TEXT,
          content,
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.SENT
        },
        select: { id: true }
      })
      const payload: MessageStatusPayload = {
        storeId: ctx.storeA.id,
        conversationId,
        messageId: message.id,
        visibility: { hidden: false, assignedTo: null }
      }
      await app.get(EventEmitter2, { strict: false }).emitAsync(Events.MESSAGE_SENT, payload)
      return message.id
    }

    it('hears the replies of the store addressed to its visitor, and no one else’s', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const mine = await enter(siteKey)
      const other = await enter(siteKey)
      for (const visitor of [mine, other]) {
        await createCustomerIdentity(owner, {
          storeId: ctx.storeA.id,
          channelType: ChannelIds.WEB_WIDGET,
          handle: visitor.visitorId
        })
      }
      const heard: MessageBody[] = []
      const overheard: MessageBody[] = []
      const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: mine.visitorToken })
      const bystander = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: other.visitorToken })
      socket.on(WidgetSocketEvents.MESSAGE, (message: MessageBody) => heard.push(message))
      bystander.on(WidgetSocketEvents.MESSAGE, (message: MessageBody) => overheard.push(message))

      const id = await reply(siteKey, mine.visitorId, 'Sí, enviamos a Santa Ana')

      await until(() => heard.length === 1)
      await sleep(100)
      expect(heard[0]).toMatchObject({ id, from: 'team', content: 'Sí, enviamos a Santa Ana' })
      expect(Object.keys(heard[0] ?? {}).sort()).toEqual(['content', 'createdAt', 'from', 'id'])
      expect(overheard).toEqual([])
    })

    // What the agents are told that a customer types, collected until the test is over, whatever its result
    const hearers: (() => void)[] = []
    afterEach(() => {
      hearers.splice(0).forEach(stop => stop())
    })
    const hearCustomerTyping = (): CustomerTypingPayload[] => {
      const told: CustomerTypingPayload[] = []
      const emitter = app.get(EventEmitter2, { strict: false })
      const listener = (payload: CustomerTypingPayload): void => {
        told.push(payload)
      }
      emitter.on(Events.CUSTOMER_TYPING, listener)
      hearers.push(() => emitter.off(Events.CUSTOMER_TYPING, listener))
      return told
    }

    // A visitor whose typing is known to be heard: the barrier of the tests that expect silence, since a
    // signal handled after the ones sent before it proves those were handled too
    const typingWitness = async (siteKey: string) => {
      const visitor = await enter(siteKey)
      await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitor.visitorId
      })
      const conversationId = await conversationFor(siteKey, visitor.visitorId)
      const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })
      return { conversationId, signal: () => socket.emit(WidgetClientEvents.TYPING) }
    }

    it('tells the agents when its visitor types, and not more often than the gap allows', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const visitor = await enter(siteKey)
      await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitor.visitorId
      })
      await reply(siteKey, visitor.visitorId, 'Hola')
      const told = hearCustomerTyping()
      const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })

      socket.emit(WidgetClientEvents.TYPING)
      socket.emit(WidgetClientEvents.TYPING)
      socket.emit(WidgetClientEvents.TYPING)
      await until(() => told.length === 1)
      await sleep(150)

      expect(told).toHaveLength(1)
      expect(told[0]?.storeId).toBe(ctx.storeA.id)
    })

    it('counts the tabs of one visitor as one, for the gap between two signals', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const visitor = await enter(siteKey)
      await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitor.visitorId
      })
      await conversationFor(siteKey, visitor.visitorId)
      const told = hearCustomerTyping()
      const first = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })
      const second = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })

      first.emit(WidgetClientEvents.TYPING)
      second.emit(WidgetClientEvents.TYPING)
      await until(() => told.length === 1)
      await sleep(200)

      expect(told).toHaveLength(1)
    })

    it('keeps the signals of one visitor id apart on two sites', async () => {
      const first = await connectWidget(ctx.adminA, ctx.storeA)
      const second = await connectWidget(ctx.adminA, ctx.storeA)
      const visitorId = randomUUID()
      const onFirst = await enter(first, visitorId)
      const onSecond = await enter(second, visitorId)
      await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitorId
      })
      await conversationFor(first, visitorId)
      await conversationFor(second, visitorId)
      const told = hearCustomerTyping()
      const socketOnFirst = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: onFirst.visitorToken })
      const socketOnSecond = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: onSecond.visitorToken })

      socketOnFirst.emit(WidgetClientEvents.TYPING)
      socketOnSecond.emit(WidgetClientEvents.TYPING)

      await until(() => told.length === 2)
      expect(new Set(told.map(item => item.conversationId)).size).toBe(2)
    })

    it('says nothing about a conversation that is out of the inbox', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const visitor = await enter(siteKey)
      await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitor.visitorId
      })
      await conversationFor(siteKey, visitor.visitorId, ConversationStatus.ARCHIVED)
      const told = hearCustomerTyping()
      const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })

      const witness = await typingWitness(siteKey)

      socket.emit(WidgetClientEvents.TYPING)
      witness.signal()
      await until(() => told.length >= 1)
      await sleep(50)

      expect(told.map(item => item.conversationId)).toEqual([witness.conversationId])
    })

    it('says nothing when a visitor with no conversation types', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const visitor = await enter(siteKey)
      const told = hearCustomerTyping()
      const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })

      const witness = await typingWitness(siteKey)

      socket.emit(WidgetClientEvents.TYPING)
      witness.signal()
      await until(() => told.length >= 1)
      await sleep(50)

      expect(told.map(item => item.conversationId)).toEqual([witness.conversationId])
    })

    it('shows its visitor that an agent is typing, and no other visitor', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const mine = await enter(siteKey)
      const other = await enter(siteKey)
      for (const visitor of [mine, other]) {
        await createCustomerIdentity(owner, {
          storeId: ctx.storeA.id,
          channelType: ChannelIds.WEB_WIDGET,
          handle: visitor.visitorId
        })
      }
      const conversationId = await conversationFor(siteKey, mine.visitorId)
      // The other visitor has a conversation of their own on the same site: it must not be the way in
      await conversationFor(siteKey, other.visitorId)
      const heard: { active: boolean }[] = []
      const overheard: { active: boolean }[] = []
      const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: mine.visitorToken })
      const bystander = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: other.visitorToken })
      socket.on(WidgetSocketEvents.AGENT_TYPING, (body: { active: boolean }) => heard.push(body))
      bystander.on(WidgetSocketEvents.AGENT_TYPING, (body: { active: boolean }) =>
        overheard.push(body)
      )
      const relay = app.get(AgentTypingRelay, { strict: false })

      await relay.relay(ctx.storeA.id, conversationId, true)
      await relay.relay(ctx.storeA.id, conversationId, false)

      await until(() => heard.length === 2)
      await sleep(100)
      expect(heard).toEqual([{ active: true }, { active: false }])
      expect(overheard).toEqual([])
    })

    describe('read receipts', () => {
      // A visitor with a socket, a conversation and two messages of theirs, the second the latest
      async function visitorWithMessages(siteKey: string) {
        const visitor = await enter(siteKey)
        await createCustomerIdentity(owner, {
          storeId: ctx.storeA.id,
          channelType: ChannelIds.WEB_WIDGET,
          handle: visitor.visitorId
        })
        const conversationId = await conversationFor(siteKey, visitor.visitorId)
        const ids: string[] = []
        for (const [index, content] of ['one', 'two'].entries()) {
          const message = await owner.message.create({
            data: {
              storeId: ctx.storeA.id,
              conversationId,
              type: MessageType.TEXT,
              content,
              authorType: AuthorType.CUSTOMER,
              channelMessageId: `${visitor.visitorId}:${content}`,
              createdAt: new Date(Date.now() - (2 - index) * 1000)
            },
            select: { id: true }
          })
          ids.push(message.id)
        }
        const heard: { messageId: string }[] = []
        const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })
        socket.on(WidgetSocketEvents.READ, (body: { messageId: string }) => heard.push(body))
        return { conversationId, ids, heard }
      }
      const readBy = (conversationId: string) =>
        api(app, ctx.adminA, ctx.storeA).post(ApiRoutes.conversations.read(conversationId))

      beforeEach(async () => {
        await owner.storeSettings.deleteMany({ where: { storeId: ctx.storeA.id } })
      })

      it('tells its visitor, with the latest message of theirs, when an agent reads, and no other visitor', async () => {
        const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
        const mine = await visitorWithMessages(siteKey)
        const other = await visitorWithMessages(siteKey)

        await readBy(mine.conversationId).expect(OK)

        await until(() => mine.heard.length === 1)
        await sleep(100)
        expect(mine.heard).toEqual([{ messageId: mine.ids[1] }])
        expect(other.heard).toEqual([])
      })

      it('gives a visitor who comes back the last message of theirs that was read', async () => {
        const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
        const mine = await visitorWithMessages(siteKey)
        const visitorId = (
          await owner.conversation.findUniqueOrThrow({
            where: { id: mine.conversationId },
            select: { customerIdentity: { select: { channelIdentity: true } } }
          })
        ).customerIdentity.channelIdentity
        const before = (await bootstrap(siteKey, visitorId).expect(OK)).body as BootstrapBody
        expect(before.readUpToMessageId).toBeNull()

        await readBy(mine.conversationId).expect(OK)

        const after = (await bootstrap(siteKey, visitorId).expect(OK)).body as BootstrapBody
        expect(after.readUpToMessageId).toBe(mine.ids[1])
        // A message that came after the read is not covered by it
        await owner.conversation.update({
          where: { id: mine.conversationId },
          data: { lastReadAt: new Date(Date.now() - 1500) }
        })
        const earlier = (await bootstrap(siteKey, visitorId).expect(OK)).body as BootstrapBody
        expect(earlier.readUpToMessageId).toBe(mine.ids[0])
      })

      it('keeps the read back from a returning visitor when the store sends no receipts', async () => {
        const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
        const mine = await visitorWithMessages(siteKey)
        const identity = await owner.conversation.findUniqueOrThrow({
          where: { id: mine.conversationId },
          select: { customerIdentity: { select: { channelIdentity: true } } }
        })
        await owner.storeSettings.create({
          data: { storeId: ctx.storeA.id, preferences: { sendReadReceipts: false } }
        })
        await readBy(mine.conversationId).expect(OK)

        const body = (
          await bootstrap(siteKey, identity.customerIdentity.channelIdentity).expect(OK)
        ).body as BootstrapBody

        expect(body.readUpToMessageId).toBeNull()
      })

      it('tells it also when the read comes from the bulk action', async () => {
        const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
        const mine = await visitorWithMessages(siteKey)

        await api(app, ctx.adminA, ctx.storeA)
          .post(ApiRoutes.conversations.bulk)
          .send({ action: BulkActions.MARK_READ, conversationIds: [mine.conversationId] })
          .expect(OK)

        await until(() => mine.heard.length === 1)
        expect(mine.heard).toEqual([{ messageId: mine.ids[1] }])
      })

      it('says nothing when the store turned read receipts off', async () => {
        const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
        const mine = await visitorWithMessages(siteKey)
        await owner.storeSettings.create({
          data: { storeId: ctx.storeA.id, preferences: { sendReadReceipts: false } }
        })

        await readBy(mine.conversationId).expect(OK)
        await sleep(200)

        expect(mine.heard).toEqual([])
      })

      it('says nothing when the visitor has written nothing a reader could see', async () => {
        const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
        const visitor = await enter(siteKey)
        await createCustomerIdentity(owner, {
          storeId: ctx.storeA.id,
          channelType: ChannelIds.WEB_WIDGET,
          handle: visitor.visitorId
        })
        const conversationId = await conversationFor(siteKey, visitor.visitorId)
        const heard: unknown[] = []
        const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })
        socket.on(WidgetSocketEvents.READ, (body: unknown) => heard.push(body))

        await readBy(conversationId).expect(OK)
        await sleep(200)

        expect(heard).toEqual([])
      })
    })

    it('does not hear a reply that is not on a conversation of the widget', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const visitor = await enter(siteKey)
      const heard: MessageBody[] = []
      const socket = await connectSocket({ [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken })
      socket.on(WidgetSocketEvents.MESSAGE, (message: MessageBody) => heard.push(message))
      const identity = await createCustomerIdentity(owner, { storeId: ctx.storeA.id })
      const conversation = await owner.conversation.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: identity.customerId,
          customerIdentityId: identity.id,
          channelConnectionId: (
            await owner.channelConnection.findFirstOrThrow({
              where: { connectionId: siteKey },
              select: { id: true }
            })
          ).id,
          channelType: ChannelIds.WEB_WIDGET
        },
        select: { id: true }
      })
      const note = await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          type: MessageType.INTERNAL_NOTE,
          content: 'the customer is rude',
          authorType: AuthorType.AGENT
        },
        select: { id: true }
      })

      await app.get(EventEmitter2, { strict: false }).emitAsync(Events.MESSAGE_SENT, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        messageId: note.id,
        visibility: { hidden: false, assignedTo: null }
      } satisfies MessageStatusPayload)

      await sleep(200)
      expect(heard).toEqual([])
    })

    it('is refused without a good token, from a site that is not listed, and past a few tabs', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const visitor = await enter(siteKey)
      const auth = { [WIDGET_TOKEN_AUTH_KEY]: visitor.visitorToken }

      expect(await refusedWith({})).toBe(ErrorCodes.WIDGET_TOKEN_INVALID)
      expect(await refusedWith({ [WIDGET_TOKEN_AUTH_KEY]: 'x.y' })).toBe(
        ErrorCodes.WIDGET_TOKEN_INVALID
      )
      expect(await refusedWith(auth, OTHER_SITE)).toBe(ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED)
      expect(await refusedWith(auth, null)).toBe(ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED)

      for (let tab = 0; tab < 5; tab += 1) await connectSocket(auth)
      await sleep(100) // The last one is in its room before the next is counted
      expect(await refusedWith(auth)).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
    })
  })

  describe('the sites and the snippet of a widget', () => {
    interface EmbedBody {
      siteKey: string
      allowedOrigins: string[]
      snippet: string
    }
    const NEW_SITE = 'https://www.example.com'

    // The id of the connection, which the owner's screens use, beside the site key
    async function connectionOf(siteKey: string): Promise<string> {
      const row = await owner.channelConnection.findFirstOrThrow({
        where: { pluginId: ChannelIds.WEB_WIDGET, connectionId: siteKey },
        select: { id: true }
      })
      return row.id
    }

    it('gives the snippet with the key, and the sites that may load it', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const id = await connectionOf(siteKey)

      const response = await api(app, ctx.adminA, ctx.storeA)
        .get(ApiRoutes.channels.widgetEmbed(id))
        .expect(OK)

      const body = response.body as EmbedBody
      expect(body.siteKey).toBe(siteKey)
      expect(body.allowedOrigins).toEqual([SITE])
      expect(body.snippet).toContain(`data-site-key="${siteKey}"`)
      expect(body.snippet).toContain('data-api-url="http://localhost:8080/api/v1"')
      expect(body.snippet).toMatch(/^<script src="https?:\/\/[^"]+\.js" /)
    })

    it('changes the sites without changing the key, so a published snippet keeps working', async () => {
      const siteKey = await connectWidget(ctx.adminA, ctx.storeA)
      const id = await connectionOf(siteKey)

      const response = await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: [SITE, `${NEW_SITE}/`] })
        .expect(OK)

      expect((response.body as EmbedBody).siteKey).toBe(siteKey)
      expect((response.body as EmbedBody).allowedOrigins).toEqual([SITE, NEW_SITE])
      await bootstrap(siteKey, randomUUID(), NEW_SITE).expect(OK)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id } })
      expect(row.displayName).toBe('shop.example.com, www.example.com')
      // A site that was taken out is refused from then on
      await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: [NEW_SITE] })
        .expect(OK)
      expect((await bootstrap(siteKey, randomUUID(), SITE)).status).toBe(FORBIDDEN)
    })

    it('names the entry that is not an origin by its position', async () => {
      const id = await connectionOf(await connectWidget(ctx.adminA, ctx.storeA))

      const response = await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: [SITE, 'https://shop.example.com/page'] })

      expect(response.status).toBe(BAD_REQUEST)
      expect(JSON.stringify(response.body)).toContain('siteOrigins.1')
    })

    it('does not let a user without the right to edit settings change the sites', async () => {
      const id = await connectionOf(await connectWidget(ctx.adminA, ctx.storeA))

      const response = await api(app, ctx.viewerA, ctx.storeA)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: [SITE] })

      expect(response.status).toBe(FORBIDDEN)
    })

    it('does not show or change the widget of another store', async () => {
      const id = await connectionOf(await connectWidget(ctx.adminA, ctx.storeA))

      await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.channels.widgetEmbed(id))
        .expect(NOT_FOUND)
      await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: [OTHER_SITE] })
        .expect(NOT_FOUND)
    })

    it('records in the audit log which sites there were and which there are', async () => {
      const id = await connectionOf(await connectWidget(ctx.adminA, ctx.storeA))
      await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: [NEW_SITE] })
        .expect(OK)

      const where = { resourceId: id, action: 'channel.widget_origins_changed' }
      // The entry is written after the answer, so it is waited for
      const deadline = Date.now() + WAIT_MS
      while ((await owner.auditLog.count({ where })) === 0 && Date.now() < deadline) {
        await sleep(POLL_MS)
      }
      const entry = await owner.auditLog.findFirstOrThrow({ where })

      expect(entry.metadata).toEqual({ before: [SITE], after: [NEW_SITE] })
    })

    it('keeps the name of the connection within its limit with many long sites', async () => {
      const id = await connectionOf(await connectWidget(ctx.adminA, ctx.storeA))
      const long = Array.from({ length: 20 }, (_, i) => `https://${'a'.repeat(60)}${i}.example.com`)

      await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: long })
        .expect(OK)

      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id } })
      expect(row.displayName.length).toBeLessThanOrEqual(200)
    })

    it('answers a conflict for a widget that was disconnected', async () => {
      const id = await connectionOf(await connectWidget(ctx.adminA, ctx.storeA))
      await api(app, ctx.adminA, ctx.storeA).post(ApiRoutes.channels.disconnect(id)).expect(OK)

      const response = await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.channels.widgetOrigins(id))
        .send({ siteOrigins: [SITE] })

      expect(response.status).toBe(409)
    })
  })
})
