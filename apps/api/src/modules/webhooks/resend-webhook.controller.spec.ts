import type { Counter } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import type { ProcessedWebhookEventsService } from '@platform/core/database'
import type { ResendWebhookVerifier } from '@platform/core/email'
import { PlatformException } from '@platform/core/errors'
import type { TrackAnalyticsJob } from '@platform/core/queues'

import type { EmailValidityService } from './email-validity.service'
import { ResendWebhookController } from './resend-webhook.controller'

const STORE_ID = '0b5f3f0e-6c36-4a4f-9d16-5b1d1c2f7a10'

interface Harness {
  controller: ResendWebhookController
  add: jest.Mock
  inc: jest.Mock
  warn: jest.Mock<void, [Record<string, unknown>, string]>
  runOnce: jest.Mock
  markInvalid: jest.Mock
}

function build(verified: unknown, { duplicate = false } = {}): Harness {
  const add = jest.fn()
  const inc = jest.fn()
  const warn = jest.fn<void, [Record<string, unknown>, string]>()
  const markInvalid = jest.fn()
  const runOnce = jest.fn(
    async (_source: string, _id: string, _type: string, handler: () => Promise<void>) => {
      if (duplicate) return false
      await handler()
      return true
    }
  )
  const verifier = {
    verify: jest.fn(() => {
      if (verified instanceof Error) throw verified
      return verified
    })
  } as unknown as ResendWebhookVerifier // Only verify() is used
  const controller = new ResendWebhookController(
    verifier,
    { runOnce } as unknown as ProcessedWebhookEventsService,
    { markInvalid } as unknown as EmailValidityService,
    { add } as unknown as Queue<TrackAnalyticsJob>,
    { inc } as unknown as Counter<string>,
    { warn, setContext: jest.fn() } as unknown as PinoLogger
  )
  return { controller, add, inc, warn, runOnce, markInvalid }
}

const request = { rawBody: Buffer.from('{}') } as never // Only rawBody is read, and it is passed through
const call = (controller: ResendWebhookController): Promise<{ received: true }> =>
  controller.handle(request, 'msg_1', '1700000000', 'v1,sig')

describe('ResendWebhookController', () => {
  it('rejects a body whose signature does not verify, before touching anything', async () => {
    const unauthorized = new PlatformException('AUTH_UNAUTHORIZED', 'bad signature', 401)
    const { controller, runOnce } = build(unauthorized)
    await expect(call(controller)).rejects.toBe(unauthorized)
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('queues an engagement event of a store email for analytics', async () => {
    const { controller, add } = build({
      type: 'email.opened',
      data: { email_id: 'e1', tags: { storeId: STORE_ID, template: 'order-confirmation' } }
    })
    await expect(call(controller)).resolves.toEqual({ received: true })
    expect(add).toHaveBeenCalledWith(
      'track-event',
      expect.objectContaining({
        event: 'email.engagement',
        storeId: STORE_ID,
        data: { type: 'email.opened', template: 'order-confirmation', messageId: 'e1' }
      }),
      { jobId: 'msg_1' } // The id of the delivery, so that a retried transaction cannot queue it twice
    )
  })

  it('acknowledges and skips an event whose data it cannot read, instead of failing it forever', async () => {
    const { controller, add, warn } = build({ type: 'email.opened', data: { unexpected: true } })
    await expect(call(controller)).resolves.toEqual({ received: true })
    expect(add).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not queue an engagement event whose store id is not a UUID', async () => {
    const { controller, add, warn } = build({
      type: 'email.opened',
      data: { email_id: 'e1', tags: { storeId: 'store-1' } }
    })
    await expect(call(controller)).resolves.toEqual({ received: true })
    expect(add).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('acknowledges and skips a bounce without recipients', async () => {
    const { controller, inc, warn } = build({ type: 'email.bounced', data: { to: [] } })
    await expect(call(controller)).resolves.toEqual({ received: true })
    expect(inc).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('ignores the engagement of an account email, which has no store', async () => {
    const { controller, add } = build({
      type: 'email.clicked',
      data: { email_id: 'e1', tags: { template: 'magic-link' } }
    })
    await call(controller)
    expect(add).not.toHaveBeenCalled()
  })

  it.each([
    ['email.bounced', 'bounced'],
    ['email.failed', 'failed'],
    ['email.complained', 'complained']
  ])('counts %s and logs the address as a hash, never the address', async (type, status) => {
    const { controller, inc, warn } = build({
      type,
      data: { to: ['Person@Example.com'], tags: { template: 'magic-link' } }
    })
    await call(controller)
    expect(inc).toHaveBeenCalledWith({ template: 'magic-link', status })
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toMatch(/example\.com/i)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      type,
      emailHashes: [expect.stringMatching(/^[0-9a-f]{16}$/)]
    })
  })

  describe('addresses the provider reports as dead', () => {
    it.each([
      ['a permanent bounce', 'email.bounced', { bounce: { type: 'Permanent' } }],
      ['a permanent bounce in any case', 'email.bounced', { bounce: { type: 'PERMANENT' } }],
      ['a complaint', 'email.complained', {}]
    ])('marks the recipient invalid after %s', async (_name, type, extra) => {
      const { controller, markInvalid } = build({
        type,
        data: { to: ['Person@Example.com'], ...extra }
      })
      await call(controller)
      expect(markInvalid).toHaveBeenCalledWith(['Person@Example.com'])
    })

    it('marks nobody when the message had several recipients, because it does not say which one', async () => {
      const { controller, markInvalid, warn } = build({
        type: 'email.bounced',
        data: { to: ['a@example.com', 'b@example.com'], bounce: { type: 'Permanent' } }
      })
      await call(controller)
      expect(markInvalid).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: 2 }),
        expect.stringContaining('several recipients')
      )
    })

    it('fails the delivery when the database does, so that the provider sends it again', async () => {
      const { controller, markInvalid } = build({
        type: 'email.complained',
        data: { to: ['a@example.com'] }
      })
      markInvalid.mockRejectedValueOnce(new Error('database down'))
      await expect(call(controller)).rejects.toThrow('database down')
    })

    it.each([
      ['a transient bounce', 'email.bounced', { bounce: { type: 'Transient' } }],
      ['an undetermined bounce', 'email.bounced', { bounce: { type: 'Undetermined' } }],
      ['a bounce that says nothing of its type', 'email.bounced', {}],
      ['a failed send', 'email.failed', { bounce: { type: 'Permanent' } }]
    ])('leaves the recipients valid after %s', async (_name, type, extra) => {
      const { controller, markInvalid } = build({
        type,
        data: { to: ['person@example.com'], ...extra }
      })
      await call(controller)
      expect(markInvalid).not.toHaveBeenCalled()
    })

    it('marks nothing when the event is a retry that was already processed', async () => {
      const { controller, markInvalid } = build(
        { type: 'email.complained', data: { to: ['person@example.com'] } },
        { duplicate: true }
      )
      await call(controller)
      expect(markInvalid).not.toHaveBeenCalled()
    })
  })

  it('acknowledges event types it does not act on', async () => {
    const { controller, add, inc } = build({ type: 'email.delivered', data: {} })
    await expect(call(controller)).resolves.toEqual({ received: true })
    expect(add).not.toHaveBeenCalled()
    expect(inc).not.toHaveBeenCalled()
  })

  it('does nothing for an event it already processed (a Svix retry)', async () => {
    const { controller, add } = build(
      { type: 'email.opened', data: { email_id: 'e1', tags: { storeId: STORE_ID } } },
      { duplicate: true }
    )
    await expect(call(controller)).resolves.toEqual({ received: true })
    expect(add).not.toHaveBeenCalled()
  })
})
