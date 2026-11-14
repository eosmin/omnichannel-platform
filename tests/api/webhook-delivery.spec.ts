import { createHmac, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { CredentialCipher, generateToken } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AppPaths,
  StoreSettingsSections,
  WEBHOOK_RESOURCE_TYPE,
  WebhookHeaders,
  WebhookLimits,
  WebhookStatus
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'
import type { TriggerWebhookJob } from '@platform/core/queues'
import { UnsafeUrlError } from '@platform/core/url-safety'

import { WebhookPostFailed } from '../../apps/worker/src/webhooks/pinned-https-post'
import {
  TenantWebhookDeliverer,
  WebhookOutcome
} from '../../apps/worker/src/webhooks/tenant-webhook-deliverer.service'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const ATTEMPTS = 60
const POLL_MS = 100

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let attempt = 0; attempt < ATTEMPTS && !done(value); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    value = await read()
  }
  return value
}

// The worker half of TDD_07 §2 (Step 5.4 PR A): the delivery of an event to a webhook of a store. The network is replaced by a
// function that answers what the test says (the post to the real internet is covered by the unit specs of pinned-https-post);
// everything else, the database, the cipher, the bus and the api that tells the admins, is the real one.
describe('The delivery of a webhook', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let deliverer: TenantWebhookDeliverer
  let cipher: CredentialCipher
  const counted: Record<string, number> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    cipher = app.get(CredentialCipher)
    const counter = {
      inc: (labels: { success: string }) => {
        counted[labels.success] = (counted[labels.success] ?? 0) + 1
      }
    } as unknown as Counter<string>
    const logger = {
      setContext: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    } as unknown as PinoLogger
    deliverer = new TenantWebhookDeliverer(
      app.get(PrismaService),
      cipher,
      app.get(DomainEvents),
      counter,
      logger
    )
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
    await owner.notification.deleteMany({ where: { storeId: ctx.storeA.id } })
    for (const key of Object.keys(counted)) delete counted[key]
  })

  const secretOf = () => `whsec_${generateToken(WebhookLimits.SECRET_BYTES)}`
  async function webhook(
    over: { storeId?: string; secret?: string; failures?: number; status?: string } = {}
  ) {
    const secret = over.secret ?? secretOf()
    const row = await owner.webhook.create({
      data: {
        storeId: over.storeId ?? ctx.storeA.id,
        url: 'https://hooks.example.com/in',
        events: [Events.ORDER_CREATED],
        secret: cipher.seal({ secret }),
        createdBy: ctx.adminA.id,
        consecutiveFailures: over.failures ?? 0,
        status: over.status ?? WebhookStatus.ACTIVE
      }
    })
    return { ...row, plain: secret }
  }
  const jobFor = (
    row: { id: string; storeId: string },
    over: Partial<TriggerWebhookJob> = {}
  ): TriggerWebhookJob => ({
    webhookId: row.id,
    storeId: row.storeId,
    deliveryId: randomUUID(),
    event: Events.ORDER_CREATED,
    payload: { storeId: row.storeId, orderId: 'o-1' },
    ...over
  })
  const answers = (status: number) => jest.fn(() => Promise.resolve(status))
  const fails = (error: Error) => jest.fn(() => Promise.reject(error))
  const logOf = (webhookId: string) =>
    owner.webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: 'asc' } })

  it('signs the exact body with the secret of the webhook, names the event and the delivery, and logs it', async () => {
    const row = await webhook()
    const job = jobFor(row, { correlationId: 'corr-1' })
    const post = answers(200)

    const outcome = await deliverer.deliver(job, 1, { post, now: () => 1_700_000_000_000 })

    expect(outcome).toBe(WebhookOutcome.DELIVERED)
    expect(post).toHaveBeenCalledTimes(1)
    const [url, options] = post.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string>; timeoutMs: number }
    ]
    expect(url).toBe('https://hooks.example.com/in')
    expect(options.timeoutMs).toBe(WebhookLimits.DELIVERY_TIMEOUT_MS)
    expect(JSON.parse(options.body)).toEqual({
      event: Events.ORDER_CREATED,
      data: job.payload,
      timestamp: 1_700_000_000_000,
      deliveryId: job.deliveryId
    })
    const expected = createHmac('sha256', row.plain).update(options.body).digest('hex')
    expect(options.headers[WebhookHeaders.SIGNATURE]).toBe(`sha256=${expected}`)
    expect(options.headers[WebhookHeaders.EVENT]).toBe(Events.ORDER_CREATED)
    expect(options.headers[WebhookHeaders.DELIVERY]).toBe(job.deliveryId)
    expect(options.headers['x-correlation-id']).toBe('corr-1')
    const [entry] = await logOf(row.id)
    expect(entry).toMatchObject({
      event: Events.ORDER_CREATED,
      statusCode: 200,
      success: true,
      attempt: 1,
      error: null
    })
    expect(counted['true']).toBe(1)
  })

  it('clears the count of failures with a delivery that goes through, and writes nothing to a healthy webhook', async () => {
    const row = await webhook({ failures: 7 })

    await deliverer.deliver(jobFor(row), 1, { post: answers(204) })

    expect(
      (await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })).consecutiveFailures
    ).toBe(0)
    const healthy = await webhook()
    const before = (await owner.webhook.findUniqueOrThrow({ where: { id: healthy.id } })).updatedAt
    await deliverer.deliver(jobFor(healthy), 1, { post: answers(200) })
    expect(
      (await owner.webhook.findUniqueOrThrow({ where: { id: healthy.id } })).updatedAt
    ).toEqual(before)
  })

  it('reads the webhook under the store of the job: a job that names another store delivers nothing', async () => {
    const row = await webhook()
    const post = answers(200)

    const outcome = await deliverer.deliver(jobFor(row, { storeId: ctx.storeB.id }), 1, { post })

    expect(outcome).toBe(WebhookOutcome.SKIPPED)
    expect(post).not.toHaveBeenCalled()
    expect(await logOf(row.id)).toHaveLength(0)
  })

  it.each([WebhookStatus.PAUSED, WebhookStatus.DISABLED])(
    'sends nothing to a webhook that is %s',
    async status => {
      const row = await webhook({ status })
      const post = answers(200)

      expect(await deliverer.deliver(jobFor(row), 1, { post })).toBe(WebhookOutcome.SKIPPED)
      expect(post).not.toHaveBeenCalled()
    }
  )

  it('lets a failure that may pass reach BullMQ and counts it', async () => {
    const row = await webhook()
    for (const [attempt, failure] of [
      new WebhookPostFailed('bad_status', true, 503),
      new WebhookPostFailed('no_answer:ECONNRESET', true),
      new WebhookPostFailed('bad_status', true, 429)
    ].entries()) {
      await expect(
        deliverer.deliver(jobFor(row), attempt + 1, { post: fails(failure) })
      ).rejects.toBe(failure)
    }

    const log = await logOf(row.id)
    expect(log.map(entry => [entry.attempt, entry.statusCode, entry.success])).toEqual([
      [1, 503, false],
      [2, null, false],
      [3, 429, false]
    ])
    expect(log[1]?.error).toBe('no_answer:ECONNRESET')
    const after = await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.consecutiveFailures).toBe(3)
    expect(after.lastFailureAt).not.toBeNull()
    expect(counted['false']).toBe(3)
  })

  it('gives up on this delivery, and only this one, for a 4xx that will not change', async () => {
    const row = await webhook()

    const outcome = await deliverer.deliver(jobFor(row), 1, {
      post: fails(new WebhookPostFailed('bad_status', false, 404))
    })

    expect(outcome).toBe(WebhookOutcome.FAILED_FOR_GOOD)
    expect((await logOf(row.id))[0]).toMatchObject({ statusCode: 404, success: false })
    // Still on: the next event is a new delivery
    expect((await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      WebhookStatus.ACTIVE
    )
  })

  it('refuses an address that stopped leading to the public internet, and does not try it again', async () => {
    const row = await webhook()

    const outcome = await deliverer.deliver(jobFor(row), 1, {
      post: fails(new UnsafeUrlError('its host is not on the public internet'))
    })

    expect(outcome).toBe(WebhookOutcome.FAILED_FOR_GOOD)
    const [entry] = await logOf(row.id)
    expect(entry).toMatchObject({
      success: false,
      statusCode: null,
      error: 'address_not_allowed'
    })
  })

  it('writes down a secret that cannot be opened, counts it, and does not ask again', async () => {
    const row = await webhook()
    await owner.webhook.update({
      where: { id: row.id },
      data: { secret: Buffer.from('damaged-not-sealed-bytes-at-all') }
    })
    const post = answers(200)

    const outcome = await deliverer.deliver(jobFor(row), 1, { post })

    expect(outcome).toBe(WebhookOutcome.FAILED_FOR_GOOD)
    expect(post).not.toHaveBeenCalled()
    const [entry] = await logOf(row.id)
    expect(entry).toMatchObject({
      success: false,
      error: 'secret_unreadable'
    })
    expect(
      (await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })).consecutiveFailures
    ).toBe(1)
  })

  it('does not send again, nor count a failure, when the endpoint took the delivery and the log could not be written', async () => {
    const row = await webhook()
    const create = jest
      .spyOn(app.get(PrismaService).client.webhookDelivery, 'create')
      .mockRejectedValueOnce(new Error('pool timeout'))
    const post = answers(200)

    expect(await deliverer.deliver(jobFor(row), 1, { post })).toBe(WebhookOutcome.DELIVERED)

    create.mockRestore()
    expect(post).toHaveBeenCalledTimes(1)
    // No row of a failure, and the count did not move: the endpoint said yes
    expect(await logOf(row.id)).toHaveLength(0)
    expect(
      (await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })).consecutiveFailures
    ).toBe(0)
  })

  it('counts a delivery once, when its last try fails, and not every try of it', async () => {
    const row = await webhook()
    const failure = new WebhookPostFailed('bad_status', true, 503)

    for (const attempt of [1, 2, 3, 4]) {
      await expect(
        deliverer.deliver(jobFor(row), attempt, { post: fails(failure), maxAttempts: 5 })
      ).rejects.toBe(failure)
    }
    expect(
      (await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })).consecutiveFailures
    ).toBe(0)

    await expect(
      deliverer.deliver(jobFor(row), 5, { post: fails(failure), maxAttempts: 5 })
    ).rejects.toBe(failure)

    // Five rows of the log, one failure of the webhook
    expect(await logOf(row.id)).toHaveLength(5)
    expect(
      (await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })).consecutiveFailures
    ).toBe(1)
  })

  it('does not send an event the webhook stopped following after it was queued', async () => {
    const row = await webhook()
    await owner.webhook.update({
      where: { id: row.id },
      data: { events: [Events.ORDER_CANCELLED] }
    })
    const post = answers(200)

    expect(await deliverer.deliver(jobFor(row), 1, { post })).toBe(WebhookOutcome.SKIPPED)
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps the log short and clean: no address, no response, no secret', async () => {
    const row = await webhook()
    const long = new WebhookPostFailed(`no_answer:${'x'.repeat(2000)}`, false)

    await deliverer.deliver(jobFor(row), 1, { post: fails(long) })

    const [entry] = await logOf(row.id)
    expect(entry?.error?.length).toBeLessThanOrEqual(WebhookLimits.DELIVERY_ERROR_MAX_LENGTH)
    expect(JSON.stringify(entry)).not.toContain(row.plain)
    expect(JSON.stringify(entry)).not.toContain('hooks.example.com')
  })

  it('turns the webhook off at the failure that makes the twentieth in a row, and tells whoever manages webhooks, once', async () => {
    const manager = await actorWithPermissions(owner, app, {
      prefix,
      name: `hookManager${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_MANAGE_WEBHOOKS]
    })
    const bystander = await actorWithPermissions(owner, app, {
      prefix,
      name: `hookBystander${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_VIEW]
    })
    const row = await webhook({ failures: WebhookLimits.MAX_CONSECUTIVE_FAILURES - 2 })
    const failure = new WebhookPostFailed('bad_status', true, 500)

    // 18 -> 19: still on, asks again
    await expect(deliverer.deliver(jobFor(row), 1, { post: fails(failure) })).rejects.toBe(failure)
    expect((await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      WebhookStatus.ACTIVE
    )
    // 19 -> 20: off, and the rest of the retries of this delivery are not asked for
    const outcome = await deliverer.deliver(jobFor(row), 2, { post: fails(failure) })

    expect(outcome).toBe(WebhookOutcome.FAILED_FOR_GOOD)
    const off = await owner.webhook.findUniqueOrThrow({ where: { id: row.id } })
    expect(off).toMatchObject({ status: WebhookStatus.DISABLED, consecutiveFailures: 20 })

    const told = await until(
      () =>
        owner.notification.findMany({
          where: { storeId: ctx.storeA.id, type: NotificationTypes.WEBHOOK_AUTO_DISABLED }
        }),
      rows => rows.length > 0
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    const all = await owner.notification.findMany({
      where: { storeId: ctx.storeA.id, type: NotificationTypes.WEBHOOK_AUTO_DISABLED }
    })
    expect(told.length).toBeGreaterThan(0)
    expect(all.map(entry => entry.userId)).toContain(manager.id)
    expect(all.map(entry => entry.userId)).not.toContain(bystander.id)
    // Once for each admin: not once for each failure
    expect(all.filter(entry => entry.userId === manager.id)).toHaveLength(1)
    expect(all[0]).toMatchObject({
      resourceType: WEBHOOK_RESOURCE_TYPE,
      resourceId: row.id,
      actionPath: AppPaths.store.settings(ctx.storeA.id, StoreSettingsSections.WEBHOOKS)
    })

    // A delivery already running that fails too says nothing more
    const late = await deliverer.deliver(jobFor(row), 1, { post: fails(failure) })
    expect(late).toBe(WebhookOutcome.SKIPPED)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(
      await owner.notification.count({
        where: {
          storeId: ctx.storeA.id,
          type: NotificationTypes.WEBHOOK_AUTO_DISABLED,
          userId: manager.id
        }
      })
    ).toBe(1)
  })

  it('does not tell the admins of another store', async () => {
    const row = await webhook({ failures: WebhookLimits.MAX_CONSECUTIVE_FAILURES - 1 })

    await deliverer.deliver(jobFor(row), 1, {
      post: fails(new WebhookPostFailed('bad_status', true, 500))
    })
    await until(
      () =>
        owner.notification.count({
          where: { storeId: ctx.storeA.id, type: NotificationTypes.WEBHOOK_AUTO_DISABLED }
        }),
      count => count > 0
    )
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(
      await owner.notification.count({
        where: {
          type: NotificationTypes.WEBHOOK_AUTO_DISABLED,
          storeId: { in: [ctx.storeB.id, ctx.storeA2.id] }
        }
      })
    ).toBe(0)
  })

  it('ends quietly when the webhook is deleted while its delivery runs', async () => {
    const row = await webhook()
    const post = jest.fn(async () => {
      await owner.webhook.delete({ where: { id: row.id } })
      throw new WebhookPostFailed('bad_status', true, 500)
    })

    await expect(deliverer.deliver(jobFor(row), 1, { post })).rejects.toBeInstanceOf(
      WebhookPostFailed
    )
    expect(await owner.webhookDelivery.count({ where: { webhookId: row.id } })).toBe(0)
  })

  it('has a route to read the log that the failures wrote', async () => {
    const row = await webhook()
    await deliverer.deliver(jobFor(row), 1, { post: answers(200) })

    const response = await api(app, ctx.adminA, ctx.storeA)
      .get(ApiRoutes.settings.webhookDeliveries(row.id))
      .expect(200)

    expect((response.body as { items: unknown[] }).items).toHaveLength(1)
  })
})
