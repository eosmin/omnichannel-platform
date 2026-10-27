import { type Queue } from 'bullmq'

import type { SendOutboundMessageJob } from '@platform/core/queues'

import { OutboundQueue, outboundJobId } from './outbound-queue'

const job: SendOutboundMessageJob = { storeId: 'store', messageId: 'message' }

function queueWith(state: string | null): {
  queue: Queue<SendOutboundMessageJob>
  removed: jest.Mock
  added: jest.Mock
} {
  const removed = jest.fn().mockResolvedValue(undefined)
  const added = jest.fn().mockResolvedValue(undefined)
  const queue = {
    getJob: jest
      .fn()
      .mockResolvedValue(state === null ? undefined : { getState: () => state, remove: removed }),
    add: added
  } as unknown as Queue<SendOutboundMessageJob> // the two methods the class calls
  return { queue, removed, added }
}

describe('OutboundQueue.requeue', () => {
  it.each(['failed', 'completed'])(
    'removes a %s job that BullMQ still keeps, because it would ignore a new job with its id',
    async state => {
      const { queue, removed, added } = queueWith(state)

      await new OutboundQueue(queue).requeue(job)

      expect(removed).toHaveBeenCalledTimes(1)
      expect(added).toHaveBeenCalledWith(expect.any(String), job, {
        jobId: outboundJobId('message')
      })
    }
  )

  it.each(['waiting', 'delayed', 'active'])(
    'leaves a %s job alone: the send is on its way',
    async state => {
      const { queue, removed } = queueWith(state)

      await new OutboundQueue(queue).requeue(job)

      expect(removed).not.toHaveBeenCalled()
    }
  )

  it('adds the job when there is none', async () => {
    const { queue, added } = queueWith(null)

    await new OutboundQueue(queue).requeue(job)

    expect(added).toHaveBeenCalledTimes(1)
  })
})
