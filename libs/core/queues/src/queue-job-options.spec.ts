import { MAGIC_LINK_TTL_MINUTES } from '@platform/core/auth'
import { OutboundLimits } from '@platform/core/domain'
import { AuthEmailQueue, QueueNames } from '@platform/core/queues'

import { OUTBOUND_BACKOFF_TYPE, QueueJobOptions } from './queue-job-options'

describe('QueueJobOptions', () => {
  it('has a policy for every queue', () => {
    expect(Object.keys(QueueJobOptions).sort()).toEqual(Object.values(QueueNames).sort())
  })

  it('retries an email 3 times with exponential backoff', () => {
    expect(QueueJobOptions[QueueNames.EMAIL]).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    })
  })

  it('retries a link email for as long as the link lives, so a provider down for ten minutes still gets it', () => {
    const options = QueueJobOptions[QueueNames.AUTH_EMAIL]
    expect(options).toMatchObject({
      attempts: AuthEmailQueue.RETRY_ATTEMPTS,
      backoff: { type: 'exponential', delay: AuthEmailQueue.RETRY_BASE_MS }
    })
    // BullMQ waits delay * 2^(n-1) after the n-th failure; the last attempt has no wait after it
    let waited = 0
    for (let failure = 1; failure < AuthEmailQueue.RETRY_ATTEMPTS; failure += 1)
      waited += AuthEmailQueue.RETRY_BASE_MS * 2 ** (failure - 1)
    expect(waited).toBeGreaterThanOrEqual(10 * 60_000)
    expect(waited).toBeLessThanOrEqual((MAGIC_LINK_TTL_MINUTES + 1) * 60_000)
  })

  it('retries a reply 5 times with the backoff of the worker, which waits longer after a throttle', () => {
    expect(QueueJobOptions[QueueNames.OUTBOUND]).toMatchObject({
      attempts: 5,
      backoff: { type: OUTBOUND_BACKOFF_TYPE, delay: OutboundLimits.FAILURE_BACKOFF_MS }
    })
  })

  it('never auto-removes the dead-letter queue', () => {
    expect(QueueJobOptions[QueueNames.DEAD_LETTER]).toEqual({
      removeOnComplete: false,
      removeOnFail: false
    })
  })

  it('keeps no job of the auth-email queue once done or given up: they hold an address and a link', () => {
    expect(QueueJobOptions[QueueNames.AUTH_EMAIL]).toMatchObject({
      removeOnComplete: true,
      removeOnFail: true
    })
  })

  it('keeps failed jobs of every working queue, so they can be retried from Bull Board', () => {
    for (const name of Object.values(QueueNames)) {
      if (name === QueueNames.DEAD_LETTER || name === QueueNames.AUTH_EMAIL) continue
      expect(QueueJobOptions[name].removeOnFail).toEqual({ count: 5000 })
    }
  })
})
