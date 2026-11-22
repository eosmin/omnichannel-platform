import { createHmac, randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { WebhookSources } from '@platform/core/domain'
import { ResendWebhookVerifier } from '@platform/core/email'
import { JobNames, QueueNames } from '@platform/core/queues'

import { createTestApp } from '../helpers/app'
import { ownerClient } from '../helpers/database'
import { anonymousApi } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const OK = 200
const UNAUTHORIZED = 401

// A secret of the shape Svix gives (`whsec_` and base64): a test one, it opens nothing
const SECRET_BYTES = Buffer.from('test-secret-of-the-resend-webhook-spec')
const TEST_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`
const STORE_ID = randomUUID()

// Signs as Svix does: HMAC-SHA256 of `id.timestamp.body` with the decoded secret, `v1,` and base64
function sign(id: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', SECRET_BYTES)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64')
  return `v1,${digest}`
}

const nowSeconds = (): string => String(Math.floor(Date.now() / 1000))

// The webhook of Resend through the real app, the real raw body and the real verifier (the secret of the test), with the analytics
// queue read instead of run. The unit spec of the controller fakes the verifier; this one proves a signed body gets in, and only that.
describe('the signed webhook of Resend', () => {
  let app: INestApplication
  let owner: OwnerClient
  let queue: CapturedQueue
  const runEvents: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    queue = new CapturedQueue()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(ResendWebhookVerifier)
        .useValue(new ResendWebhookVerifier(TEST_SECRET))
        .overrideProvider(getQueueToken(QueueNames.ANALYTICS))
        .useValue(queue)
    )
  })
  beforeEach(() => {
    queue.jobs.length = 0
  })
  afterAll(async () => {
    await owner.processedWebhookEvent.deleteMany({
      where: { source: WebhookSources.RESEND, eventId: { in: runEvents } }
    })
    await app.close()
    await owner.$disconnect()
  })

  function event(): { id: string; body: string } {
    const id = `msg_it_${randomUUID()}`
    runEvents.push(id)
    const body = JSON.stringify({
      type: 'email.opened',
      created_at: new Date().toISOString(),
      data: { email_id: 'email_1', tags: { storeId: STORE_ID, template: 'order-confirmation' } }
    })
    return { id, body }
  }

  function post(id: string, timestamp: string, signature: string, body: string) {
    return anonymousApi(app)
      .post(ApiRoutes.webhooks.resend)
      .set('content-type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', timestamp)
      .set('svix-signature', signature)
      .send(body)
  }

  it('takes a body signed with the secret into the analytics queue, once, however many times Resend retries it', async () => {
    const { id, body } = event()
    const timestamp = nowSeconds()
    const signature = sign(id, timestamp, body)

    await post(id, timestamp, signature, body).expect(OK)
    await post(id, timestamp, signature, body).expect(OK)

    expect(queue.jobs).toHaveLength(1)
    expect(queue.jobs[0]).toMatchObject({
      name: JobNames.TRACK_EVENT,
      data: { event: 'email.engagement', storeId: STORE_ID, eventKey: id },
      opts: { jobId: id }
    })
  })

  it.each([
    [
      'a signature made with another secret',
      (id: string, ts: string, body: string) =>
        `v1,${createHmac('sha256', Buffer.from('another-secret')).update(`${id}.${ts}.${body}`).digest('base64')}`
    ],
    ['no signature at all', () => '']
  ])('refuses %s and queues nothing', async (_name, signer) => {
    const { id, body } = event()
    const timestamp = nowSeconds()

    await post(id, timestamp, signer(id, timestamp, body), body).expect(UNAUTHORIZED)

    expect(queue.jobs).toHaveLength(0)
  })

  it('refuses a body changed after it was signed', async () => {
    const { id, body } = event()
    const timestamp = nowSeconds()
    const signature = sign(id, timestamp, body)

    await post(
      id,
      timestamp,
      signature,
      body.replace('order-confirmation', 'something-else')
    ).expect(UNAUTHORIZED)

    expect(queue.jobs).toHaveLength(0)
  })

  it('refuses a body that was signed long ago (a replay)', async () => {
    const { id, body } = event()
    const old = String(Math.floor(Date.now() / 1000) - 3600)

    await post(id, old, sign(id, old, body), body).expect(UNAUTHORIZED)

    expect(queue.jobs).toHaveLength(0)
  })
})
