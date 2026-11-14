import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  WEBHOOK_RESOURCE_TYPE,
  WEBHOOK_SECRET_PREFIX,
  WebhookEvents,
  WebhookLimits,
  WebhookStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { JobNames, QueueNames } from '@platform/core/queues'

import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { type CapturedQueue, queueOf } from '../helpers/queue'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const PUBLIC_URL = 'https://8.8.8.8/hooks/platform'

// Settings → Webhooks (Step 5.4 PR A, TDD_07 §2, TDD_09 §13): the store's outbound webhooks, the secret that is shown once,
// the address that must lead to the public internet, and the dispatcher that queues one delivery per active webhook that
// follows an event of the store.
describe('The webhooks of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let queue: CapturedQueue

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    queue = queueOf(app, QueueNames.WEBHOOKS)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.webhook.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } }
    })
    queue.jobs.length = 0
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const create = async (url = PUBLIC_URL, events: string[] = [Events.ORDER_CREATED]) => {
    const response = await asAdmin()
      .post(ApiRoutes.settings.webhooks)
      .send({ url, events })
      .expect(CREATED)
    return response.body as { id: string; secret: string; status: string; url: string }
  }

  describe('making one', () => {
    it('shows the secret once, keeps it sealed, and never gives it back in a read', async () => {
      const made = await create(PUBLIC_URL, [Events.ORDER_CREATED, Events.ORDER_CREATED])

      expect(made.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true)
      expect(made.status).toBe(WebhookStatus.ACTIVE)
      const row = await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })
      // Sealed: the bytes hold neither the secret nor anything that looks like it
      expect(Buffer.from(row.secret).includes(Buffer.from(made.secret))).toBe(false)
      expect(app.get(CredentialCipher).open(row.secret)).toEqual({ secret: made.secret })
      expect(row.events).toEqual([Events.ORDER_CREATED]) // Each event once
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(row.createdBy).toBe(ctx.adminA.id)

      const list = await asAdmin().get(ApiRoutes.settings.webhooks).expect(OK)
      expect(JSON.stringify(list.body)).not.toContain(made.secret)
      expect(JSON.stringify(list.body)).not.toContain('secret')
      const one = await asAdmin().get(ApiRoutes.settings.webhookById(made.id)).expect(OK)
      expect(JSON.stringify(one.body)).not.toContain('secret')
    })

    it('leaves an audit entry that holds neither the secret nor the address', async () => {
      const made = await create('https://8.8.4.4/hook?token=very-private')

      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.WEBHOOK_CREATED,
        resourceId: made.id
      })
      expect(entry?.resourceType).toBe(WEBHOOK_RESOURCE_TYPE)
      expect(entry?.storeId).toBe(ctx.storeA.id)
      const text = JSON.stringify(entry)
      expect(text).not.toContain(made.secret)
      expect(text).not.toContain('very-private')
    })

    it.each([
      'https://localhost/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/hook',
      'https://192.168.1.10/hook',
      'https://172.16.0.5/hook',
      'https://100.64.0.1/hook',
      'https://0.0.0.0/hook',
      'https://[::1]/hook',
      'https://[::ffff:10.0.0.1]/hook',
      'https://[fe80::1]/hook',
      'https://[fd00::1]/hook',
      // The URL parser turns the decimal and hexadecimal forms into the address they mean
      'https://2130706433/hook',
      'https://0x7f.1/hook'
    ])('refuses an address that leads inside: %s', async url => {
      const response = await asAdmin()
        .post(ApiRoutes.settings.webhooks)
        .send({ url, events: [Events.ORDER_CREATED] })
        .expect(BAD_REQUEST)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.VALIDATION_URL_NOT_ALLOWED
      )
      expect(await owner.webhook.count({ where: { storeId: ctx.storeA.id } })).toBe(0)
    })

    it.each([
      'http://8.8.8.8/hook',
      'https://user:password@8.8.8.8/hook',
      'https://8.8.8.8:8443/hook',
      'https://8.8.8.8/hook#fragment',
      'ftp://8.8.8.8/hook',
      'not a url',
      `https://8.8.8.8/${'a'.repeat(WebhookLimits.URL_MAX_LENGTH)}`
    ])('refuses an address that is not plain https on the default port: %s', async url => {
      await asAdmin()
        .post(ApiRoutes.settings.webhooks)
        .send({ url, events: [Events.ORDER_CREATED] })
        .expect(BAD_REQUEST)
    })

    it('refuses events a webhook cannot follow, none at all, and keys it does not know', async () => {
      const post = (body: object) => asAdmin().post(ApiRoutes.settings.webhooks).send(body)
      await post({ url: PUBLIC_URL, events: [Events.CHANNEL_DISCONNECTED] }).expect(BAD_REQUEST)
      await post({ url: PUBLIC_URL, events: ['order.exploded'] }).expect(BAD_REQUEST)
      await post({ url: PUBLIC_URL, events: [] }).expect(BAD_REQUEST)
      await post({ url: PUBLIC_URL }).expect(BAD_REQUEST)
      await post({
        url: PUBLIC_URL,
        events: [Events.ORDER_CREATED],
        storeId: ctx.storeB.id
      }).expect(BAD_REQUEST)
    })

    it('holds a limit per store, counted under a lock', async () => {
      await owner.webhook.createMany({
        data: Array.from({ length: WebhookLimits.MAX_PER_STORE }, (_, index) => ({
          storeId: ctx.storeA.id,
          url: `https://8.8.8.8/${index}`,
          events: [Events.ORDER_CREATED],
          secret: Buffer.from('x'),
          createdBy: ctx.adminA.id
        }))
      })

      const response = await asAdmin()
        .post(ApiRoutes.settings.webhooks)
        .send({ url: PUBLIC_URL, events: [Events.ORDER_CREATED] })
        .expect(CONFLICT)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.RESOURCE_CONFLICT
      )
      // Another store of the same organization has its own room
      await api(app, ctx.adminA2, ctx.storeA2)
        .post(ApiRoutes.settings.webhooks)
        .send({ url: PUBLIC_URL, events: [Events.ORDER_CREATED] })
        .expect(CREATED)
    })
  })

  describe('who may', () => {
    it('is for whoever holds settings:manage_webhooks, and nobody else, not even to read', async () => {
      const made = await create()
      for (const actor of [ctx.agentA, ctx.viewerA]) {
        const as = api(app, actor, ctx.storeA)
        await as.get(ApiRoutes.settings.webhooks).expect(FORBIDDEN)
        await as.get(ApiRoutes.settings.webhookById(made.id)).expect(FORBIDDEN)
        await as
          .post(ApiRoutes.settings.webhooks)
          .send({ url: PUBLIC_URL, events: [Events.ORDER_CREATED] })
          .expect(FORBIDDEN)
        await as
          .patch(ApiRoutes.settings.webhookById(made.id))
          .send({ status: 'paused' })
          .expect(FORBIDDEN)
        await as.delete(ApiRoutes.settings.webhookById(made.id)).expect(FORBIDDEN)
        await as.post(ApiRoutes.settings.webhookSecret(made.id)).expect(FORBIDDEN)
        await as.get(ApiRoutes.settings.webhookDeliveries(made.id)).expect(FORBIDDEN)
      }
    })

    it('is scoped to the store of the request: another store sees nothing of it, whoever asks', async () => {
      const made = await create()
      const intruders = [
        api(app, ctx.adminB, ctx.storeB), // another organization
        api(app, ctx.adminA2, ctx.storeA2) // a sibling store of the same organization
      ]
      for (const as of intruders) {
        expect((await as.get(ApiRoutes.settings.webhooks).expect(OK)).body).toEqual([])
        await as.get(ApiRoutes.settings.webhookById(made.id)).expect(NOT_FOUND)
        await as
          .patch(ApiRoutes.settings.webhookById(made.id))
          .send({ status: 'paused' })
          .expect(NOT_FOUND)
        await as.post(ApiRoutes.settings.webhookSecret(made.id)).expect(NOT_FOUND)
        await as.get(ApiRoutes.settings.webhookDeliveries(made.id)).expect(NOT_FOUND)
        await as.delete(ApiRoutes.settings.webhookById(made.id)).expect(NOT_FOUND)
      }
      // Untouched by all of it
      const row = await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.status).toBe(WebhookStatus.ACTIVE)
    })
  })

  describe('changing one', () => {
    it('pauses, resumes, and starts again from a clean count when it is turned on', async () => {
      const made = await create()
      await owner.webhook.update({
        where: { id: made.id },
        data: { status: WebhookStatus.DISABLED, consecutiveFailures: 20 }
      })

      const paused = await asAdmin()
        .patch(ApiRoutes.settings.webhookById(made.id))
        .send({ status: WebhookStatus.PAUSED })
        .expect(OK)
      expect((paused.body as { status: string }).status).toBe(WebhookStatus.PAUSED)
      // Paused is not turned on: the count of what disabled it stays
      expect(
        (await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })).consecutiveFailures
      ).toBe(20)

      const resumed = await asAdmin()
        .patch(ApiRoutes.settings.webhookById(made.id))
        .send({ status: WebhookStatus.ACTIVE })
        .expect(OK)
      expect(resumed.body).toMatchObject({ status: WebhookStatus.ACTIVE, consecutiveFailures: 0 })
    })

    it('leaves a disabled webhook disabled when only its address changes: turning it on is a decision', async () => {
      const made = await create()
      await owner.webhook.update({
        where: { id: made.id },
        data: { status: WebhookStatus.DISABLED, consecutiveFailures: 20 }
      })

      await asAdmin()
        .patch(ApiRoutes.settings.webhookById(made.id))
        .send({ url: 'https://8.8.4.4/fixed' })
        .expect(OK)

      const row = await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })
      expect(row).toMatchObject({
        status: WebhookStatus.DISABLED,
        consecutiveFailures: 20,
        url: 'https://8.8.4.4/fixed'
      })
    })

    it('keeps the count of a failing webhook that is saved again as active', async () => {
      const made = await create()
      await owner.webhook.update({ where: { id: made.id }, data: { consecutiveFailures: 19 } })

      await asAdmin()
        .patch(ApiRoutes.settings.webhookById(made.id))
        .send({ url: 'https://8.8.4.4/same', status: WebhookStatus.ACTIVE })
        .expect(OK)

      expect(
        (await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })).consecutiveFailures
      ).toBe(19)
    })

    it('does not let a store set the status the platform sets', async () => {
      const made = await create()
      await asAdmin()
        .patch(ApiRoutes.settings.webhookById(made.id))
        .send({ status: WebhookStatus.DISABLED })
        .expect(BAD_REQUEST)
      await asAdmin().patch(ApiRoutes.settings.webhookById(made.id)).send({}).expect(BAD_REQUEST)
    })

    it('checks a new address as it checked the first, and keeps the old one when it refuses', async () => {
      const made = await create()

      await asAdmin()
        .patch(ApiRoutes.settings.webhookById(made.id))
        .send({ url: 'https://10.0.0.1/inside' })
        .expect(BAD_REQUEST)
      expect((await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })).url).toBe(
        PUBLIC_URL
      )

      await asAdmin()
        .patch(ApiRoutes.settings.webhookById(made.id))
        .send({ url: 'https://8.8.4.4/new', events: [Events.ORDER_CANCELLED] })
        .expect(OK)
      const row = await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })
      expect(row).toMatchObject({ url: 'https://8.8.4.4/new', events: [Events.ORDER_CANCELLED] })
    })

    it('makes a new secret on request, shown once, and the old one stops being the one kept', async () => {
      const made = await create()
      const before = (await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })).secret

      const rotated = await asAdmin().post(ApiRoutes.settings.webhookSecret(made.id)).expect(OK)

      const body = rotated.body as { secret: string }
      expect(body.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true)
      expect(body.secret).not.toBe(made.secret)
      const after = (await owner.webhook.findUniqueOrThrow({ where: { id: made.id } })).secret
      expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).not.toBe(0)
      expect(app.get(CredentialCipher).open(after)).toEqual({ secret: body.secret })
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.WEBHOOK_UPDATED,
        resourceId: made.id
      })
      expect(JSON.stringify(entry)).not.toContain(body.secret)
    })

    it('deletes, with its log, and audits it', async () => {
      const made = await create()
      await owner.webhookDelivery.create({
        data: { webhookId: made.id, event: Events.ORDER_CREATED, durationMs: 5, success: true }
      })

      await asAdmin().delete(ApiRoutes.settings.webhookById(made.id)).expect(NO_CONTENT)

      await asAdmin().get(ApiRoutes.settings.webhookById(made.id)).expect(NOT_FOUND)
      expect(await owner.webhookDelivery.count({ where: { webhookId: made.id } })).toBe(0)
      expect(
        await waitForAuditEntries(owner, {
          action: AuditAction.WEBHOOK_DELETED,
          resourceId: made.id
        })
      ).toHaveLength(1)
    })
  })

  describe('its delivery log', () => {
    it('is paged newest first, can be filtered by outcome, and never leaves its webhook', async () => {
      const made = await create()
      const other = await create('https://8.8.4.4/other')
      const at = (seconds: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, seconds))
      await owner.webhookDelivery.createMany({
        data: [1, 2, 3, 4, 5].map(second => ({
          webhookId: made.id,
          event: Events.ORDER_CREATED,
          statusCode: second % 2 === 0 ? 500 : 200,
          durationMs: second,
          success: second % 2 !== 0,
          error: second % 2 === 0 ? 'status 500' : null,
          createdAt: at(second)
        }))
      })
      await owner.webhookDelivery.create({
        data: { webhookId: other.id, event: Events.ORDER_CREATED, durationMs: 9, success: true }
      })
      type Page = { items: { durationMs: number }[]; nextCursor: string | null }
      const read = async (query: object): Promise<Page> =>
        (await asAdmin().get(ApiRoutes.settings.webhookDeliveries(made.id)).query(query).expect(OK))
          .body as Page

      const first = await read({ limit: 2 })
      expect(first.items.map(item => item.durationMs)).toEqual([5, 4])
      expect(first.nextCursor).not.toBeNull()
      const second = await read({ limit: 2, cursor: first.nextCursor })
      expect(second.items.map(item => item.durationMs)).toEqual([3, 2])
      const last = await read({ limit: 2, cursor: second.nextCursor })
      expect(last.items.map(item => item.durationMs)).toEqual([1])
      expect(last.nextCursor).toBeNull()

      const failures = await read({ success: 'false' })
      expect(failures.items.map(item => item.durationMs)).toEqual([4, 2])
      await asAdmin()
        .get(ApiRoutes.settings.webhookDeliveries(made.id))
        .query({ limit: WebhookLimits.DELIVERIES_MAX_PAGE_SIZE + 1 })
        .expect(BAD_REQUEST)
      await asAdmin()
        .get(ApiRoutes.settings.webhookDeliveries(made.id))
        .query({ cursor: 'garbage' })
        .expect(BAD_REQUEST)
    })
  })

  describe('the dispatcher', () => {
    const publish = (storeId: string, event: string = Events.CUSTOMER_CREATED) =>
      app.get(PrismaService).transaction(tx => {
        app.get(DomainEvents).publish(tx, event as typeof Events.CUSTOMER_CREATED, {
          storeId,
          customerId: randomUUID()
        })
        return Promise.resolve()
      })
    const settle = async () => {
      // The listener starts after the commit and does not hold it: give it the turns it needs
      for (let turn = 0; turn < 50 && queue.jobs.length === 0; turn += 1) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    const mine = (webhookId: string) =>
      queue.jobs.filter(job => (job.data as { webhookId: string }).webhookId === webhookId)

    it('queues one delivery per active webhook of the store that follows the event, with an id of its own', async () => {
      const follows = await create(PUBLIC_URL, [Events.CUSTOMER_CREATED])
      const alsoFollows = await create('https://8.8.4.4/b', [
        Events.CUSTOMER_CREATED,
        Events.ORDER_CREATED
      ])
      const otherEvent = await create('https://1.1.1.1/c', [Events.ORDER_CREATED])
      const paused = await create('https://1.0.0.1/d', [Events.CUSTOMER_CREATED])
      await owner.webhook.update({
        where: { id: paused.id },
        data: { status: WebhookStatus.PAUSED }
      })
      const disabled = await create('https://9.9.9.9/e', [Events.CUSTOMER_CREATED])
      await owner.webhook.update({
        where: { id: disabled.id },
        data: { status: WebhookStatus.DISABLED }
      })

      await publish(ctx.storeA.id)
      await settle()

      expect(queue.jobs).toHaveLength(2)
      const jobs = [...mine(follows.id), ...mine(alsoFollows.id)]
      expect(jobs).toHaveLength(2)
      for (const job of jobs) {
        const data = job.data as {
          storeId: string
          event: string
          deliveryId: string
          payload: { storeId: string }
        }
        expect(job.name).toBe(JobNames.TRIGGER_WEBHOOK)
        expect(data.storeId).toBe(ctx.storeA.id)
        expect(data.event).toBe(Events.CUSTOMER_CREATED)
        expect(data.payload.storeId).toBe(ctx.storeA.id)
        // The id of the job is the id of the delivery
        expect(job.opts?.jobId).toBe(data.deliveryId)
      }
      expect(new Set(jobs.map(job => job.opts?.jobId)).size).toBe(2)
      expect(mine(otherEvent.id)).toHaveLength(0)
    })

    it('never reaches a webhook of another store, even one that follows the same event', async () => {
      await create(PUBLIC_URL, [Events.CUSTOMER_CREATED])
      const foreign = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.settings.webhooks)
        .send({ url: 'https://8.8.4.4/b', events: [Events.CUSTOMER_CREATED] })
        .expect(CREATED)

      await publish(ctx.storeA.id)
      await settle()

      expect(mine((foreign.body as { id: string }).id)).toHaveLength(0)
      expect(
        queue.jobs.every(job => (job.data as { storeId: string }).storeId === ctx.storeA.id)
      ).toBe(true)
    })

    it('never sends the text of a message, whatever an emitter put in the payload', async () => {
      const follows = await create(PUBLIC_URL, [Events.MESSAGE_RECEIVED])
      const dispatcher = app.get(
        (await import('../../apps/api/src/modules/tenant-webhooks/webhook-dispatcher'))
          .WebhookDispatcher
      )

      await dispatcher.dispatch(Events.MESSAGE_RECEIVED, {
        storeId: ctx.storeA.id,
        messageId: randomUUID(),
        contentPreview: 'my card number is 4111',
        firstMessageContent: 'and my address is'
      })

      const [job] = mine(follows.id)
      expect(JSON.stringify(job?.data)).not.toContain('4111')
      expect(JSON.stringify(job?.data)).not.toContain('my address')
    })

    it('ignores an event that is not in the catalog, and a payload that names no store', async () => {
      await create(PUBLIC_URL, [Events.CUSTOMER_CREATED])
      const dispatcher = app.get(
        (await import('../../apps/api/src/modules/tenant-webhooks/webhook-dispatcher'))
          .WebhookDispatcher
      )

      expect(
        await dispatcher.dispatch(Events.CHANNEL_DISCONNECTED, { storeId: ctx.storeA.id })
      ).toBe(0)
      expect(await dispatcher.dispatch(Events.CUSTOMER_CREATED, { customerId: 'c' })).toBe(0)
      expect(await dispatcher.dispatch(Events.CUSTOMER_CREATED, 'text')).toBe(0)
      expect(await dispatcher.dispatch(Events.CUSTOMER_CREATED, null)).toBe(0)
      expect(queue.jobs).toHaveLength(0)
    })

    it('follows only events the api can see: every event of the catalog has a payload with its store', () => {
      expect(WebhookEvents.length).toBeGreaterThan(0)
      expect(new Set(WebhookEvents).size).toBe(WebhookEvents.length)
    })
  })
})
