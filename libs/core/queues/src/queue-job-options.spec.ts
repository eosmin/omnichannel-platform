import { QueueNames } from '@platform/core/queues'

import { QueueJobOptions } from './queue-job-options'

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
