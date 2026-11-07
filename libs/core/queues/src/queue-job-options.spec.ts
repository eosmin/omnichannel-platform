import { OutboundLimits } from '@platform/core/domain'
import { QueueNames } from '@platform/core/queues'

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

  it('keeps failed jobs of every working queue, so they can be retried from Bull Board', () => {
    for (const name of Object.values(QueueNames)) {
      if (name === QueueNames.DEAD_LETTER) continue
      expect(QueueJobOptions[name].removeOnFail).toEqual({ count: 5000 })
    }
  })
})
