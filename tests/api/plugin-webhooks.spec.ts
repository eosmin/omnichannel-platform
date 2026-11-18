import { createHmac, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  PLUGIN_REVOKE_CONFIRMATION,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginPricingModels,
  PluginStatus,
  WebhookHeaders,
  WebhookLimits
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'
import { JobNames, QueueNames, type TriggerPluginWebhookJob } from '@platform/core/queues'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginChallengeService } from '../../apps/api/src/modules/plugins/plugin-challenge.service'
import { WebhookDispatcher } from '../../apps/api/src/modules/tenant-webhooks/webhook-dispatcher'
import { WebhookPostFailed } from '../../apps/worker/src/webhooks/pinned-https-post'
import { PluginWebhookDeliverer } from '../../apps/worker/src/webhooks/plugin-webhook-deliverer.service'
import { WebhookOutcome } from '../../apps/worker/src/webhooks/webhook-sending'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { standalone } from '../helpers/leaks'
import { type CapturedQueue, queueOf } from '../helpers/queue'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const NOT_FOUND = 404
const SIGNATURE_HEADER = 'X-Acme-Signature'

interface ErrorBody {
  error: { code: string }
}
interface SetupResult {
  apiKey: string
  webhookSecret: string | null
  installationId: string
}

// TDD_10 §6.5 and §6.6, Step 5.6 PR P3: the webhooks of a plugin installation (what is queued, what it may contain, how it is
// signed, when it is turned off) and the revocation. The network is replaced by a function that answers what the test says;
// the database, the cipher, the bus, the queue wiring and the api that tells the admins are the real ones.
describe('The webhooks of an integration plugin and its revocation', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let queue: CapturedQueue
  let deliverer: PluginWebhookDeliverer
  let cipher: CredentialCipher
  let counter = 0
  const counted: Record<string, number> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(PluginChallengeService).useValue({ run: jest.fn() })
    )
    ctx = await seedTestContext(owner, app, prefix)
    queue = queueOf(app, QueueNames.WEBHOOKS)
    cipher = app.get(CredentialCipher)
    const metric = {
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
    deliverer = new PluginWebhookDeliverer(
      app.get(PrismaService),
      cipher,
      app.get(DomainEvents),
      metric,
      logger
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    queue.jobs.length = 0
    for (const key of Object.keys(counted)) delete counted[key]
    // Every test starts with no installation: what an event reaches depends on who is installed in the store
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const newId = () => {
    counter += 1
    return `${prefix}-w${counter}`
  }
  const manifestOf = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    version: '1.0.0',
    name: `Plugin ${id}`,
    description: 'Hears about the messages of the store',
    author: { name: 'Acme Inc', email: 'support@acme.com' },
    type: PluginCatalogTypes.INTEGRATION,
    pricing: { model: PluginPricingModels.FREE },
    scopes: [PluginScopes.MESSAGES_READ],
    webhooks: {
      endpoint: 'https://hooks.acme.com/platform',
      events: [Events.MESSAGE_RECEIVED],
      signatureHeader: SIGNATURE_HEADER
    },
    ...over
  })
  const exchange = (code: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      .post(`${API_PREFIX}${PluginApiRoutes.setupExchange}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .send({ code })
  }
  const callWithKey = (key: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      .get(`${API_PREFIX}${PluginApiRoutes.installation}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .set('authorization', `Bearer ${key}`)
  }
  // Register, install with what the manifest asks for and trade the code, in store A (or B for the other organization)
  const setUp = async (
    over: Record<string, unknown> = {},
    agent: typeof asAdmin = asAdmin
  ): Promise<{ id: string; setup: SetupResult }> => {
    const id = newId()
    await agent().post(ApiRoutes.plugins.register).send(manifestOf(id, over)).expect(CREATED)
    const consent = (await agent().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
      scopes: string[]
    }
    const installed = await agent()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: consent.scopes })
      .expect(CREATED)
    const offer = (installed.body as { setup: { code: string } }).setup
    const setup = (await exchange(offer.code).expect(OK)).body as SetupResult
    return { id, setup }
  }
  const dispatcher = () => app.get(WebhookDispatcher)
  // The whole sensitive text, never a short number: a job is full of random uuids that now and then hold "4111" by chance
  const SENSITIVE_PREVIEW = 'my card number is 4111'
  const messageReceived = (storeId: string) => ({
    storeId,
    conversationId: randomUUID(),
    messageId: randomUUID(),
    customerId: randomUUID(),
    channelType: 'web',
    authorType: 'customer',
    contentPreview: SENSITIVE_PREVIEW,
    receivedAt: '2026-11-15T10:00:00.000Z',
    visibility: { hidden: false, assignedTo: randomUUID() }
  })
  const pluginJobs = () => queue.jobs.filter(job => job.name === JobNames.TRIGGER_PLUGIN_WEBHOOK)
  const jobFor = (
    installationId: string,
    storeId: string,
    over: Partial<TriggerPluginWebhookJob> = {}
  ): TriggerPluginWebhookJob => ({
    pluginInstallationId: installationId,
    storeId,
    deliveryId: randomUUID(),
    event: Events.MESSAGE_RECEIVED,
    payload: { storeId, messageId: 'm-1' },
    ...over
  })
  const answers = (status: number) => jest.fn(() => Promise.resolve(status))
  const fails = (error: Error) => jest.fn(() => Promise.reject(error))
  const logOf = (installationId: string) =>
    owner.webhookDelivery.findMany({
      where: { pluginInstallationId: installationId },
      orderBy: { createdAt: 'asc' }
    })

  describe('the secret that signs', () => {
    it('is handed to the plugin once with its key, kept sealed, and is in no audit entry', async () => {
      const { id, setup } = await setUp()

      expect(setup.webhookSecret).toMatch(/^whsec_/)
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: setup.installationId }
      })
      // Sealed: the bytes are not the secret, and opening them gives it back
      expect(Buffer.from(row.webhookSecret ?? []).toString('utf8')).not.toContain(
        setup.webhookSecret as string
      )
      expect(cipher.open(row.webhookSecret as Uint8Array)['secret']).toBe(setup.webhookSecret)
      expect(row).toMatchObject({
        webhookEndpoint: 'https://hooks.acme.com/platform',
        webhookConsecutiveFailures: 0,
        webhookDisabledAt: null
      })
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        resourceId: setup.installationId
      })
      expect(JSON.stringify(entries)).not.toContain(setup.webhookSecret as string)
      expect(id).toContain(prefix)
    })

    it('does not exist for a plugin that has no webhook endpoint', async () => {
      const { setup } = await setUp({ webhooks: undefined })

      expect(setup.webhookSecret).toBeNull()
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: setup.installationId }
      })
      expect(row.webhookSecret).toBeNull()
    })
  })

  describe('what is queued for an event', () => {
    it('queues one delivery for the installation that follows the event, redacted to its scopes', async () => {
      const { setup } = await setUp()
      const event = messageReceived(ctx.storeA.id)

      await dispatcher().dispatch(Events.MESSAGE_RECEIVED, event)

      const [job] = pluginJobs()
      expect(pluginJobs()).toHaveLength(1)
      const data = job?.data as TriggerPluginWebhookJob
      expect(data).toMatchObject({
        pluginInstallationId: setup.installationId,
        storeId: ctx.storeA.id,
        event: Events.MESSAGE_RECEIVED
      })
      expect(job?.opts?.jobId).toBe(data.deliveryId)
      // messages:read opens the message and its conversation: not the customer, the text, the team or the channel's flags
      expect(data.payload).toEqual({
        storeId: ctx.storeA.id,
        conversationId: event.conversationId,
        messageId: event.messageId,
        channelType: 'web',
        authorType: 'customer',
        receivedAt: event.receivedAt
      })
      const text = JSON.stringify(data)
      expect(text).not.toContain(event.customerId)
      expect(text).not.toContain(SENSITIVE_PREVIEW)
      expect(text).not.toMatch(standalone('4111'))
      expect(text).not.toContain(event.visibility.assignedTo)
    })

    it('adds the customer id only to a plugin that was granted customers:read', async () => {
      await setUp({
        scopes: [PluginScopes.MESSAGES_READ, PluginScopes.CUSTOMERS_READ]
      })
      const event = messageReceived(ctx.storeA.id)

      await dispatcher().dispatch(Events.MESSAGE_RECEIVED, event)

      const [job] = pluginJobs()
      expect((job?.data as TriggerPluginWebhookJob).payload).toMatchObject({
        customerId: event.customerId
      })
      expect(JSON.stringify(job?.data)).not.toContain(SENSITIVE_PREVIEW)
      expect(JSON.stringify(job?.data)).not.toMatch(standalone('4111'))
    })

    it('queues nothing for a plugin that does not hold the scope of the event, or does not follow it', async () => {
      await setUp({ scopes: [PluginScopes.ORDERS_READ] })
      await setUp({
        webhooks: {
          endpoint: 'https://hooks.acme.com/platform',
          events: [Events.CUSTOMER_CREATED],
          signatureHeader: SIGNATURE_HEADER
        }
      })

      await dispatcher().dispatch(Events.MESSAGE_RECEIVED, messageReceived(ctx.storeA.id))

      expect(pluginJobs()).toHaveLength(0)
    })

    it('never tells a plugin of the events of another store', async () => {
      const mine = await setUp()
      const theirs = await setUp({}, asAdminB)

      await dispatcher().dispatch(Events.MESSAGE_RECEIVED, messageReceived(ctx.storeA.id))
      await dispatcher().dispatch(Events.MESSAGE_RECEIVED, messageReceived(ctx.storeB.id))

      const byInstallation = pluginJobs().map(job => {
        const data = job.data as TriggerPluginWebhookJob
        return [data.pluginInstallationId, data.storeId]
      })
      expect(byInstallation).toHaveLength(2)
      expect(byInstallation).toContainEqual([mine.setup.installationId, ctx.storeA.id])
      expect(byInstallation).toContainEqual([theirs.setup.installationId, ctx.storeB.id])
    })

    it('queues nothing for an installation that was turned off, revoked or whose plugin is not approved', async () => {
      const off = await setUp()
      await owner.pluginInstallation.update({
        where: { id: off.setup.installationId },
        data: { webhookDisabledAt: new Date() }
      })
      const suspended = await setUp()
      await owner.plugin.update({
        where: { id: suspended.id },
        data: { status: PluginStatus.SUSPENDED }
      })

      await dispatcher().dispatch(Events.MESSAGE_RECEIVED, messageReceived(ctx.storeA.id))

      expect(pluginJobs()).toHaveLength(0)
    })
  })

  describe('a delivery', () => {
    it('is signed with the secret the plugin was given, under the header its manifest names, and is logged', async () => {
      const { setup } = await setUp()
      const job = jobFor(setup.installationId, ctx.storeA.id, { correlationId: 'corr-1' })
      const post = answers(200)

      const outcome = await deliverer.deliver(job, 1, { post, now: () => 1_700_000_000_000 })

      expect(outcome).toBe(WebhookOutcome.DELIVERED)
      const [url, options] = post.mock.calls[0] as unknown as [
        string,
        { body: string; headers: Record<string, string> }
      ]
      // The address is the one that passed the challenge
      expect(url).toBe('https://hooks.acme.com/platform')
      expect(JSON.parse(options.body)).toEqual({
        event: Events.MESSAGE_RECEIVED,
        data: job.payload,
        timestamp: 1_700_000_000_000,
        deliveryId: job.deliveryId
      })
      const expected = createHmac('sha256', setup.webhookSecret as string)
        .update(options.body)
        .digest('hex')
      expect(options.headers[SIGNATURE_HEADER]).toBe(`sha256=${expected}`)
      expect(options.headers[WebhookHeaders.EVENT]).toBe(Events.MESSAGE_RECEIVED)
      expect(options.headers[WebhookHeaders.DELIVERY]).toBe(job.deliveryId)
      const [entry] = await logOf(setup.installationId)
      expect(entry).toMatchObject({
        event: Events.MESSAGE_RECEIVED,
        statusCode: 200,
        success: true,
        attempt: 1,
        webhookId: null
      })
      expect(counted['true']).toBe(1)
    })

    it('goes to the address kept on the installation, not to the one a newer manifest names', async () => {
      const { id, setup } = await setUp()
      const row = await owner.plugin.findUniqueOrThrow({ where: { id } })
      await owner.plugin.update({
        where: { id },
        data: {
          manifest: {
            ...(row.manifest as Record<string, unknown>),
            webhooks: {
              endpoint: 'https://evil.example.com/steal',
              events: [Events.MESSAGE_RECEIVED],
              signatureHeader: SIGNATURE_HEADER
            }
          }
        }
      })
      const post = answers(200)

      await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, { post })

      const [url] = post.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://hooks.acme.com/platform')
    })

    it('holds the deliveries of a day to the cap of the manifest: the next is dropped, not failed, and a retry of one that began still goes', async () => {
      const { setup } = await setUp({ limits: { maxWebhooksPerDay: 2 } })
      const post = answers(200)
      const deliver = (attempt: number, at: number) =>
        deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), attempt, {
          post,
          now: () => at
        })
      const now = Date.now()

      expect(await deliver(1, now)).toBe(WebhookOutcome.DELIVERED)
      expect(await deliver(1, now)).toBe(WebhookOutcome.DELIVERED)
      expect(await deliver(1, now)).toBe(WebhookOutcome.SKIPPED)
      expect(post).toHaveBeenCalledTimes(2)
      // A dropped delivery is no failure of the endpoint: nothing is logged and nothing counts toward turning it off
      expect(await logOf(setup.installationId)).toHaveLength(2)
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: setup.installationId }
      })
      expect(row.webhookConsecutiveFailures).toBe(0)
      // A delivery that began is finished
      expect(await deliver(2, now)).toBe(WebhookOutcome.DELIVERED)
      // A day later the first two are out of the window
      expect(await deliver(1, now + WebhookLimits.PLUGIN_DAY_MS + 60_000)).toBe(
        WebhookOutcome.DELIVERED
      )
    })

    it('has no cap when the manifest names none', async () => {
      const { setup } = await setUp()
      const post = answers(200)
      for (let i = 0; i < 3; i += 1) {
        expect(
          await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, { post })
        ).toBe(WebhookOutcome.DELIVERED)
      }
    })

    it('sends nothing for an event whose scope the installation no longer holds', async () => {
      const { setup } = await setUp()
      await owner.pluginInstallation.update({
        where: { id: setup.installationId },
        data: { scopes: [PluginScopes.ORDERS_READ] }
      })
      const post = answers(200)

      const outcome = await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, {
        post
      })

      expect(outcome).toBe(WebhookOutcome.SKIPPED)
      expect(post).not.toHaveBeenCalled()
    })

    it('reads the installation under the store of the job: a job that names another store delivers nothing', async () => {
      const { setup } = await setUp()
      const post = answers(200)

      const outcome = await deliverer.deliver(jobFor(setup.installationId, ctx.storeB.id), 1, {
        post
      })

      expect(outcome).toBe(WebhookOutcome.SKIPPED)
      expect(post).not.toHaveBeenCalled()
      expect(await logOf(setup.installationId)).toHaveLength(0)
    })

    it('logs a failure with a code, never the secret or the address, and clears the count with a delivery that goes through', async () => {
      const { setup } = await setUp()
      await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, {
        post: fails(new WebhookPostFailed('bad_status', false, 400))
      })
      const [failed] = await logOf(setup.installationId)
      expect(failed).toMatchObject({ success: false, statusCode: 400, error: 'bad_status' })
      expect(JSON.stringify(failed)).not.toContain(setup.webhookSecret as string)
      expect(JSON.stringify(failed)).not.toContain('hooks.acme.com')
      expect(
        (await owner.pluginInstallation.findUniqueOrThrow({ where: { id: setup.installationId } }))
          .webhookConsecutiveFailures
      ).toBe(1)

      await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, {
        post: answers(200)
      })

      expect(
        (await owner.pluginInstallation.findUniqueOrThrow({ where: { id: setup.installationId } }))
          .webhookConsecutiveFailures
      ).toBe(0)
    })

    it('turns the webhooks of the installation off at the twentieth failure in a row and tells whoever manages plugins, once', async () => {
      const manager = await actorWithPermissions(owner, app, {
        prefix,
        name: `plugManager${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SETTINGS_MANAGE_PLUGINS]
      })
      const bystander = await actorWithPermissions(owner, app, {
        prefix,
        name: `plugBystander${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SETTINGS_VIEW]
      })
      const { setup } = await setUp()
      await owner.pluginInstallation.update({
        where: { id: setup.installationId },
        data: { webhookConsecutiveFailures: WebhookLimits.MAX_CONSECUTIVE_FAILURES - 1 }
      })

      const outcome = await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, {
        post: fails(new WebhookPostFailed('bad_status', true, 500))
      })

      expect(outcome).toBe(WebhookOutcome.FAILED_FOR_GOOD)
      const off = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: setup.installationId }
      })
      expect(off.webhookDisabledAt).not.toBeNull()
      expect(off.webhookConsecutiveFailures).toBe(WebhookLimits.MAX_CONSECUTIVE_FAILURES)
      // It stays installed: only its webhooks stopped
      expect(off.status).toBe(PluginInstallationStatus.ACTIVE)
      let told = 0
      for (let turn = 0; turn < 60 && told === 0; turn += 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
        told = await owner.notification.count({
          where: { storeId: ctx.storeA.id, type: NotificationTypes.PLUGIN_ERROR }
        })
      }
      await new Promise(resolve => setTimeout(resolve, 300))
      const all = await owner.notification.findMany({
        where: { storeId: ctx.storeA.id, type: NotificationTypes.PLUGIN_ERROR }
      })
      expect(all.map(entry => entry.userId)).toContain(manager.id)
      expect(all.map(entry => entry.userId)).not.toContain(bystander.id)
      expect(all.filter(entry => entry.userId === manager.id)).toHaveLength(1)
      expect(all[0]).toMatchObject({ resourceId: setup.installationId })
      // Another store's admins heard nothing
      expect(
        await owner.notification.count({
          where: {
            type: NotificationTypes.PLUGIN_ERROR,
            storeId: { in: [ctx.storeB.id, ctx.storeA2.id] }
          }
        })
      ).toBe(0)
      // A delivery that was already queued sends nothing more
      const post = answers(200)
      expect(
        await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, { post })
      ).toBe(WebhookOutcome.SKIPPED)
      expect(post).not.toHaveBeenCalled()
    })
  })

  describe('revoking', () => {
    const revoke = (installationId: string, body?: Record<string, unknown>) =>
      asAdmin()
        .post(ApiRoutes.plugins.revoke(installationId))
        .send(body ?? {})

    it('needs the word as written: without it, with it in lower case or with another word, nothing changes', async () => {
      const { setup } = await setUp()

      for (const body of [undefined, { confirmation: 'revoke' }, { confirmation: 'yes' }]) {
        const response = await revoke(setup.installationId, body).expect(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_REVOKE_NOT_CONFIRMED)
      }

      await callWithKey(setup.apiKey).expect(OK)
      expect(
        (await owner.pluginInstallation.findUniqueOrThrow({ where: { id: setup.installationId } }))
          .status
      ).toBe(PluginInstallationStatus.ACTIVE)
      expect(pluginJobs()).toHaveLength(0)
    })

    it('stops the key at the next call, clears its hash, audits it and queues the last webhook', async () => {
      const { id, setup } = await setUp()
      await callWithKey(setup.apiKey).expect(OK)

      await revoke(setup.installationId, { confirmation: PLUGIN_REVOKE_CONFIRMATION }).expect(OK)

      const refused = await callWithKey(setup.apiKey).expect(UNAUTHORIZED)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PLUGIN_API_KEY_INVALID)
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: setup.installationId }
      })
      expect(row).toMatchObject({
        status: PluginInstallationStatus.REVOKED,
        apiKeyHash: null,
        apiKeyPrefix: null
      })
      expect(row.revokedAt).not.toBeNull()
      const [entry] = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.PLUGIN_REVOKED,
        resourceId: setup.installationId
      })
      expect(entry?.userId).toBe(ctx.adminA.id)
      expect(JSON.stringify(entry)).not.toContain(setup.apiKey)

      const [job] = pluginJobs()
      expect(pluginJobs()).toHaveLength(1)
      expect(job?.data).toMatchObject({
        pluginInstallationId: setup.installationId,
        storeId: ctx.storeA.id,
        event: Events.PLUGIN_REVOKED,
        final: true,
        payload: { storeId: ctx.storeA.id, installationId: setup.installationId, pluginId: id }
      })

      // Revoking again asks for the same job (the id is the same, so the queue holds one) and changes nothing else
      await revoke(setup.installationId, { confirmation: PLUGIN_REVOKE_CONFIRMATION }).expect(OK)
      expect(new Set(pluginJobs().map(queued => queued.opts?.jobId)).size).toBe(1)
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.PLUGIN_REVOKED, resourceId: setup.installationId }
        })
      ).toBe(1)
    })

    it('delivers the last webhook signed with the kept secret, then removes the endpoint and the secret', async () => {
      const { setup } = await setUp()
      await revoke(setup.installationId, { confirmation: PLUGIN_REVOKE_CONFIRMATION }).expect(OK)
      const final = pluginJobs()[0]?.data as TriggerPluginWebhookJob
      const post = answers(200)

      const outcome = await deliverer.deliver(final, 1, { post, now: () => 1_700_000_000_000 })

      expect(outcome).toBe(WebhookOutcome.DELIVERED)
      const [url, options] = post.mock.calls[0] as unknown as [
        string,
        { body: string; headers: Record<string, string> }
      ]
      expect(url).toBe('https://hooks.acme.com/platform')
      expect(JSON.parse(options.body)).toMatchObject({
        event: Events.PLUGIN_REVOKED,
        deliveryId: final.deliveryId
      })
      expect(options.headers[SIGNATURE_HEADER]).toBe(
        `sha256=${createHmac('sha256', setup.webhookSecret as string)
          .update(options.body)
          .digest('hex')}`
      )
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: setup.installationId }
      })
      expect(row.webhookEndpoint).toBeNull()
      expect(row.webhookSecret).toBeNull()
      // Nothing else can be sent to a revoked installation
      const later = answers(200)
      expect(
        await deliverer.deliver(jobFor(setup.installationId, ctx.storeA.id), 1, { post: later })
      ).toBe(WebhookOutcome.SKIPPED)
      expect(later).not.toHaveBeenCalled()
    })

    it('removes the endpoint and the secret even when the last webhook cannot be delivered', async () => {
      const { setup } = await setUp()
      await revoke(setup.installationId, { confirmation: PLUGIN_REVOKE_CONFIRMATION }).expect(OK)
      const final = pluginJobs()[0]?.data as TriggerPluginWebhookJob

      const outcome = await deliverer.deliver(final, 1, {
        post: fails(new WebhookPostFailed('no_answer:ECONNREFUSED', false))
      })

      expect(outcome).toBe(WebhookOutcome.FAILED_FOR_GOOD)
      const row = await owner.pluginInstallation.findUniqueOrThrow({
        where: { id: setup.installationId }
      })
      expect(row.webhookSecret).toBeNull()
      expect(row.webhookEndpoint).toBeNull()
      // The failure is logged, and counts toward nothing
      expect(await logOf(setup.installationId)).toHaveLength(1)
      expect(row.webhookConsecutiveFailures).toBe(0)
    })

    it('does not deliver the last webhook of an installation that was installed again meanwhile', async () => {
      const { id, setup } = await setUp()
      await revoke(setup.installationId, { confirmation: PLUGIN_REVOKE_CONFIRMATION }).expect(OK)
      const final = pluginJobs()[0]?.data as TriggerPluginWebhookJob
      const consent = (await asAdmin().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
        scopes: string[]
      }
      await asAdmin()
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: id, scopes: consent.scopes })
        .expect(CREATED)
      // Nothing of the earlier incarnation is kept: no secret to sign with, no count of failures
      expect(
        await owner.pluginInstallation.findUniqueOrThrow({ where: { id: setup.installationId } })
      ).toMatchObject({
        status: PluginInstallationStatus.PENDING_SETUP,
        webhookSecret: null,
        webhookDisabledAt: null,
        webhookConsecutiveFailures: 0
      })
      const post = answers(200)

      const outcome = await deliverer.deliver(final, 1, { post })

      expect(outcome).toBe(WebhookOutcome.SKIPPED)
      expect(post).not.toHaveBeenCalled()
    })

    it('does not send the last webhook to a plugin that is suspended, and closes the subscription', async () => {
      const { id, setup } = await setUp()
      await revoke(setup.installationId, { confirmation: PLUGIN_REVOKE_CONFIRMATION }).expect(OK)
      const final = pluginJobs()[0]?.data as TriggerPluginWebhookJob
      await owner.plugin.update({ where: { id }, data: { status: PluginStatus.SUSPENDED } })
      const post = answers(200)

      const outcome = await deliverer.deliver(final, 1, { post })

      expect(outcome).toBe(WebhookOutcome.SKIPPED)
      expect(post).not.toHaveBeenCalled()
      expect(
        await owner.pluginInstallation.findUniqueOrThrow({ where: { id: setup.installationId } })
      ).toMatchObject({ webhookSecret: null, webhookEndpoint: null })
    })

    it('does not let another store revoke the installation', async () => {
      const { setup } = await setUp()

      await asAdminB()
        .post(ApiRoutes.plugins.revoke(setup.installationId))
        .send({ confirmation: PLUGIN_REVOKE_CONFIRMATION })
        .expect(NOT_FOUND)

      await callWithKey(setup.apiKey).expect(OK)
      expect(pluginJobs()).toHaveLength(0)
    })
  })
})
