import { createHmac, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierConnectionStatus,
  CarrierId,
  type CarrierIdType,
  CarrierWebhookLimits,
  ShipmentStatus,
  ShippingPlugin
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { JobNames, QueueNames } from '@platform/core/queues'
import { StatusResolutionKinds } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { CarrierEventResolver } from '../../apps/worker/src/carriers/carrier-event-resolver.service'
import { buildFakeCarrier, FAKE_CARRIER_API_KEY } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const OK = 200
const CREATED = 201
const UNAUTHORIZED = 401
const PAYLOAD_TOO_LARGE = 413

interface ErrorBody {
  error: { code: string }
}
interface QueuedEvent {
  storeId: string
  connectionId: string
  receivedAt: string
  event: { providerEventId?: string; status: string | null; rawStatus: string; rawReason?: string }
}

const sign = (secret: string, raw: string): string =>
  createHmac('sha256', secret).update(raw).digest('hex')
const pushed = (
  id: string,
  status: string,
  over: { reason?: string; at?: string; guide?: string } = {}
) => ({
  id,
  status,
  guide: over.guide ?? 'G-1',
  at: over.at ?? '2026-11-11T10:00:00.000Z',
  ...(over.reason === undefined ? {} : { reason: over.reason })
})

// The public door of the carriers (TDD_17 §4.9, Step 4.8 PR C2a): the signature, checked with the secret of the connection in
// the address, authenticates it, and a request that is not a good signature on a live connection is the same answer whatever
// is wrong with it. What passes is queued for the worker, one job per event, under the store of that connection.
describe('The webhook of a carrier', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    app
      .get(CarrierRegistry, { strict: false })
      .register(buildFakeCarrier({ id: CarrierId.FORZA, webhook: true, fetchStatus: true }).plugin)
    for (const [actor, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const installed = await api(app, actor, store)
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: ShippingPlugin.ID })
      expect(installed.status).toBe(CREATED)
    }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    queued().length = 0
  })

  const queued = () => queueOf(app, QueueNames.WEBHOOKS).jobs
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const connect = async (as = asAdmin, carrierId: CarrierIdType = CarrierId.FORZA) => {
    const response = await as()
      .post(ApiRoutes.carriers.create)
      .send(
        carrierId === CarrierId.LOCAL
          ? {
              carrierId,
              credentials: {
                name: `${prefix}-l-${(counter += 1)}`,
                phone: '70001111',
                prefix: `W${counter}`
              }
            }
          : {
              carrierId,
              credentials: { apiKey: FAKE_CARRIER_API_KEY },
              displayName: `${prefix}-forza-${(counter += 1)}`
            }
      )
    expect(response.status).toBe(CREATED)
    const body = response.body as { id: string; webhookSecret: string | null }
    return { id: body.id, secret: body.webhookSecret ?? '' }
  }
  const post = (id: string, raw: string, signature?: string) => {
    const request = anonymousApi(app)
      .post(ApiRoutes.webhooks.carrier(id))
      .set('content-type', 'application/json')
    return (signature === undefined ? request : request.set('x-signature', signature)).send(raw)
  }
  const signed = (id: string, secret: string, body: unknown) => {
    const raw = JSON.stringify(body)
    return post(id, raw, sign(secret, raw))
  }
  const refused = (response: { status: number; body: unknown }) => {
    expect(response.status).toBe(UNAUTHORIZED)
    expect((response.body as ErrorBody).error.code).toBe(
      ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID
    )
    return (response.body as ErrorBody).error
  }

  describe('a good request', () => {
    it('answers at once and queues one job per event, for the store of the connection', async () => {
      const { id, secret } = await connect()

      const response = await signed(id, secret, {
        events: [pushed('e-1', 'delivered'), pushed('e-2', 'Out', { reason: '115' })]
      })

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ received: true })
      expect(queued()).toHaveLength(2)
      const jobs = queued().map(job => job.data as QueuedEvent)
      expect(queued().every(job => job.name === JobNames.PROCESS_CARRIER_EVENT)).toBe(true)
      expect(jobs[0]).toMatchObject({
        storeId: ctx.storeA.id,
        connectionId: id,
        event: {
          providerEventId: 'e-1',
          status: ShipmentStatus.DELIVERED,
          rawStatus: 'delivered'
        }
      })
      expect(jobs[1]?.event).toMatchObject({ rawStatus: 'Out', rawReason: '115' })
      expect(new Date(jobs[0]?.receivedAt ?? '').toISOString()).toBe(jobs[0]?.receivedAt)
    })

    it('takes the store from the connection, never from the request', async () => {
      const { id, secret } = await connect()
      const raw = JSON.stringify({ storeId: ctx.storeB.id, events: [pushed('e-1', 'delivered')] })

      const response = await anonymousApi(app)
        .post(ApiRoutes.webhooks.carrier(id))
        .query({ storeId: ctx.storeB.id })
        .set('content-type', 'application/json')
        .set('x-store-id', ctx.storeB.id)
        .set('x-signature', sign(secret, raw))
        .send(raw)

      expect(response.status).toBe(OK)
      expect((queued()[0]?.data as QueuedEvent).storeId).toBe(ctx.storeA.id)
    })

    it('queues nothing, and answers well, for a body the plugin cannot read', async () => {
      const { id, secret } = await connect()

      const response = await signed(id, secret, { hello: 'world' })

      // The signature is good, so it is the carrier's own request: failing it would have it sent again for ever
      expect(response.status).toBe(OK)
      expect(queued()).toHaveLength(0)
    })

    it('leaves out an event that does not fit the schema and keeps the rest', async () => {
      const { id, secret } = await connect()

      const response = await signed(id, secret, {
        events: [pushed('e-1', 'x'.repeat(500)), pushed('e-2', 'delivered')]
      })

      expect(response.status).toBe(OK)
      expect(queued().map(job => (job.data as QueuedEvent).event.providerEventId)).toEqual(['e-2'])
    })

    it('queues every event of a body, however many', async () => {
      const { id, secret } = await connect()
      const events = Array.from({ length: 250 }, (_v, i) => pushed(`e-${i}`, 'transit'))

      const response = await signed(id, secret, { events })

      expect(response.status).toBe(OK)
      expect(queued()).toHaveLength(250)
    })

    it('keeps the status of an event whose optional reason is blank', async () => {
      const { id, secret } = await connect()
      const raw = JSON.stringify({
        events: [{ ...pushed('e-1', 'delivered', { reason: '' }), guide: 'G-9' }]
      })

      const response = await post(id, raw, sign(secret, raw))

      expect(response.status).toBe(OK)
      const [job] = queued().map(item => item.data as QueuedEvent)
      expect(job?.event.status).toBe(ShipmentStatus.DELIVERED)
      expect(job?.event.rawReason).toBeUndefined()
    })

    it('sets no job id, so a retry of the carrier can queue an event whose first job failed', async () => {
      const { id, secret } = await connect()
      const body = { events: [pushed('e-1', 'delivered')] }

      await signed(id, secret, body)
      await signed(id, secret, body)

      expect(queued()).toHaveLength(2)
      expect(queued().every(job => job.opts?.jobId === undefined)).toBe(true)
    })

    it('leaves out an event whose status has a control character, and counts it', async () => {
      const { id, secret } = await connect()
      const raw = JSON.stringify({
        events: [pushed('e-1', 'bad\u0000code'), pushed('e-2', 'delivered')]
      })

      const response = await post(id, raw, sign(secret, raw))

      expect(response.status).toBe(OK)
      expect(queued().map(job => (job.data as QueuedEvent).event.providerEventId)).toEqual(['e-2'])
    })

    it('leaves out an event whose composite code cannot be stored', async () => {
      const { id, secret } = await connect()
      const raw = JSON.stringify({
        events: [
          pushed('e-1', 'delivered'),
          pushed('e-2', 'a'.repeat(60), { reason: 'b'.repeat(60) }),
          pushed('e-3', '\u0301'),
          pushed('e-4', 'delivered')
        ]
      })

      await post(id, raw, sign(secret, raw))

      expect(queued().map(job => (job.data as QueuedEvent).event.providerEventId)).toEqual([
        'e-1',
        'e-4'
      ])
    })
  })

  describe('a request that is refused', () => {
    it('refuses a bad signature, a missing one, and a body that was changed after it was signed', async () => {
      const { id, secret } = await connect()
      const body = { events: [pushed('e-1', 'delivered')] }
      const raw = JSON.stringify(body)

      refused(await post(id, raw, sign('not the secret', raw)))
      refused(await post(id, raw))
      refused(await post(id, raw, ''))
      refused(await post(id, raw, 'a'.repeat(64)))
      refused(
        await post(id, JSON.stringify({ events: [pushed('e-1', 'returned')] }), sign(secret, raw))
      )
      // One byte of difference is another body
      refused(await post(id, `${raw} `, sign(secret, raw)))

      expect(queued()).toHaveLength(0)
    })

    it('gives the same answer whatever is wrong: no such connection, a malformed address, a carrier with no webhook, a connection let go, a bad signature', async () => {
      const live = await connect()
      const letGo = await connect()
      const local = await connect(asAdmin, CarrierId.LOCAL)
      expect((await asAdmin().post(ApiRoutes.carriers.disconnect(letGo.id))).status).toBe(OK)
      const raw = JSON.stringify({ events: [pushed('e-1', 'delivered')] })

      const answers = [
        refused(await post(live.id, raw, sign('wrong', raw))),
        refused(await post(randomUUID(), raw, sign(live.secret, raw))),
        refused(await post('not-an-id', raw, sign(live.secret, raw))),
        // The secret it had, with the connection let go since
        refused(await post(letGo.id, raw, sign(letGo.secret, raw))),
        refused(await post(local.id, raw, sign(live.secret, raw)))
      ]

      for (const answer of answers) expect(answer).toEqual(answers[0])
      expect(queued()).toHaveLength(0)
    })

    it('takes nothing for a connection marked as let go, even if a secret were left on its row', async () => {
      const { id, secret } = await connect()
      await owner.carrierConnection.update({
        where: { id },
        data: { status: CarrierConnectionStatus.DISABLED }
      })

      refused(await signed(id, secret, { events: [pushed('e-1', 'delivered')] }))

      expect(queued()).toHaveLength(0)
    })

    it('still takes what the carrier of a connection with a failing health check pushes', async () => {
      const { id, secret } = await connect()
      await owner.carrierConnection.update({
        where: { id },
        data: { status: CarrierConnectionStatus.ERROR }
      })

      expect((await signed(id, secret, { events: [pushed('e-1', 'delivered')] })).status).toBe(OK)
      expect(queued()).toHaveLength(1)
    })

    it('does not take the secret of one store for the connection of another', async () => {
      const mine = await connect(asAdmin)
      const theirs = await connect(asAdminB)
      const raw = JSON.stringify({ events: [pushed('e-1', 'delivered')] })

      // Store A's secret, aimed at store B's connection (and the other way round)
      refused(await post(theirs.id, raw, sign(mine.secret, raw)))
      refused(await post(mine.id, raw, sign(theirs.secret, raw)))
      expect(queued()).toHaveLength(0)

      // Each one's own secret works, and the job names that connection's own store
      expect(
        (await signed(theirs.id, theirs.secret, { events: [pushed('e-1', 'delivered')] })).status
      ).toBe(OK)
      expect((queued()[0]?.data as QueuedEvent).storeId).toBe(ctx.storeB.id)
    })

    it('refuses a request the api kept no bytes of, instead of verifying an empty body', async () => {
      const { id, secret } = await connect()
      // The signature of the empty string is what a carrier's empty ping would carry
      const response = await anonymousApi(app)
        .post(ApiRoutes.webhooks.carrier(id))
        .set('content-type', 'text/plain')
        .set('x-signature', sign(secret, ''))
        .send(JSON.stringify({ events: [pushed('e-1', 'delivered')] }))

      refused(response)
      expect(queued()).toHaveLength(0)
    })

    it('takes a body just under the limit', async () => {
      const { id, secret } = await connect()
      const raw = JSON.stringify({ events: [pushed('e-1', 'delivered')], padding: '' })
      const room = CarrierWebhookLimits.MAX_BODY_BYTES - Buffer.byteLength(raw) - 16
      const body = JSON.stringify({
        events: [pushed('e-1', 'delivered')],
        padding: 'x'.repeat(room)
      })
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(CarrierWebhookLimits.MAX_BODY_BYTES)

      expect((await post(id, body, sign(secret, body))).status).toBe(OK)
      expect(queued()).toHaveLength(1)
    })

    it('refuses a body over the limit, whoever signed it and whatever the connection', async () => {
      const { id, secret } = await connect()
      const raw = JSON.stringify({
        events: [pushed('e-1', 'delivered')],
        padding: 'x'.repeat(CarrierWebhookLimits.MAX_BODY_BYTES)
      })

      const signedBig = await post(id, raw, sign(secret, raw))
      // The same refusal for an address that is nothing
      const unknownBig = await post(randomUUID(), raw, sign(secret, raw))

      expect(signedBig.status).toBe(PAYLOAD_TOO_LARGE)
      expect((signedBig.body as ErrorBody).error.code).toBe(ErrorCodes.PAYLOAD_TOO_LARGE)
      expect(unknownBig.status).toBe(PAYLOAD_TOO_LARGE)
      expect(queued()).toHaveLength(0)
    })

    it('does not break the raw body of the other public webhooks', async () => {
      // The signature of a channel is also checked over the exact bytes: asking for the carrier route and then a channel
      // one must leave both as they were (the channel suite covers the good path)
      const channel = await anonymousApi(app).post(ApiRoutes.webhooks.channel('telegram')).send({})
      expect(channel.status).toBe(404)
    })
  })

  describe('the secret that is made anew', () => {
    it('takes the place of the old one at once', async () => {
      const { id, secret } = await connect()
      const body = { events: [pushed('e-1', 'delivered')] }
      expect((await signed(id, secret, body)).status).toBe(OK)

      const rotated = await asAdmin().post(ApiRoutes.carriers.webhookSecret(id))
      const fresh = (rotated.body as { webhookSecret: string }).webhookSecret

      expect(fresh).not.toBe(secret)
      refused(await signed(id, secret, body))
      expect((await signed(id, fresh, body)).status).toBe(OK)
    })
  })

  describe('what the worker makes of an event', () => {
    let resolver: CarrierEventResolver
    const noise = { setContext: () => undefined, info: () => undefined, warn: () => undefined }

    beforeAll(() => {
      resolver = new CarrierEventResolver(
        app.get(PrismaService, { strict: false }),
        noise as unknown as PinoLogger
      )
    })

    const job = (
      connectionId: string,
      rawStatus: string,
      over: { rawReason?: string; status?: ShipmentStatus | null; storeId?: string } = {}
    ) => ({
      storeId: over.storeId ?? ctx.storeA.id,
      connectionId,
      receivedAt: new Date().toISOString(),
      event: {
        rawStatus,
        status: over.status ?? null,
        occurredAt: '2026-11-11T10:00:00.000Z',
        ...(over.rawReason === undefined ? {} : { rawReason: over.rawReason })
      }
    })
    const put = (id: string, code: string, status: ShipmentStatus | null) =>
      asAdmin()
        .put(ApiRoutes.carriers.statusMappingByCode(id, encodeURIComponent(code)))
        .send({ status })

    it('lets the mapping of the connection win over what the plugin says', async () => {
      const { id } = await connect()
      await put(id, 'transit', ShipmentStatus.DELIVERED)

      const resolved = await resolver.resolve(
        job(id, 'Transit', { status: ShipmentStatus.IN_TRANSIT })
      )

      expect(resolved?.resolution).toMatchObject({
        kind: StatusResolutionKinds.MAPPED,
        status: ShipmentStatus.DELIVERED,
        source: 'connection'
      })
    })

    it('gives the status of the plugin when the connection has no row, and counts nothing as unknown', async () => {
      const { id } = await connect()

      const resolved = await resolver.resolve(
        job(id, 'whatever', { status: ShipmentStatus.PICKED_UP })
      )

      expect(resolved?.resolution).toMatchObject({
        status: ShipmentStatus.PICKED_UP,
        source: 'plugin'
      })
    })

    it('leaves an ignored code with no effect and no record, though the plugin has a status for it', async () => {
      const { id } = await connect()
      await put(id, 'transit', null)

      const resolved = await resolver.resolve(
        job(id, 'TRANSIT', { status: ShipmentStatus.IN_TRANSIT })
      )

      expect(resolved?.resolution.kind).toBe(StatusResolutionKinds.IGNORED)
      expect(await owner.carrierUnmappedStatus.count({ where: { connectionId: id } })).toBe(0)
    })

    it('records the composite code of a reason, and maps one reason without the others', async () => {
      const { id } = await connect()
      await put(id, 'failed:115', ShipmentStatus.RETURNED)

      const mapped = await resolver.resolve(job(id, 'failed', { rawReason: '115', status: null }))
      const other = await resolver.resolve(job(id, 'failed', { rawReason: '120', status: null }))
      // The plain status has its own row from the catalog
      const plain = await resolver.resolve(job(id, 'failed', { status: null }))

      expect(mapped?.resolution).toMatchObject({
        status: ShipmentStatus.RETURNED,
        code: 'failed:115'
      })
      expect(other?.resolution).toMatchObject({
        status: ShipmentStatus.FAILED_ATTEMPT,
        code: 'failed'
      })
      expect(plain?.resolution).toMatchObject({ status: ShipmentStatus.FAILED_ATTEMPT })
      expect(await owner.carrierUnmappedStatus.count({ where: { connectionId: id } })).toBe(0)
    })

    it('is for nobody when the connection was let go, or is another store’s', async () => {
      const gone = await connect()
      await asAdmin().post(ApiRoutes.carriers.disconnect(gone.id))
      const live = await connect()

      expect(await resolver.resolve(job(gone.id, 'zzz'))).toBeNull()
      expect(await resolver.resolve(job(live.id, 'zzz', { storeId: ctx.storeB.id }))).toBeNull()
      expect(await resolver.resolve(job(randomUUID(), 'zzz'))).toBeNull()
      expect(
        await owner.carrierUnmappedStatus.count({
          where: { connectionId: { in: [gone.id, live.id] } }
        })
      ).toBe(0)
    })
  })
})
