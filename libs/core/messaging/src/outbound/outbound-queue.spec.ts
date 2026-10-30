import { type Queue } from 'bullmq'

import {
  JobNames,
  type SendOutboundMessageJob,
  type SendOutboundReadReceiptJob,
  type SendOutboundTypingJob
} from '@platform/core/queues'

import {
  OutboundQueue,
  type OutboundQueueJob,
  outboundJobId,
  readReceiptJobId
} from './outbound-queue'

const job: SendOutboundMessageJob = { storeId: 'store', messageId: 'message' }

function queueWith(state: string | null): {
  queue: Queue<OutboundQueueJob>
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
  } as unknown as Queue<OutboundQueueJob> // the two methods the class calls
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

describe('OutboundQueue.enqueueReadReceipt', () => {
  const receipt: SendOutboundReadReceiptJob = {
    storeId: 'store',
    conversationId: 'conversation',
    messageId: 'message'
  }

  it('removes a failed job first, because BullMQ would ignore a new job under its id', async () => {
    const { queue, removed, added } = queueWith('failed')

    await new OutboundQueue(queue).enqueueReadReceipt(receipt)

    expect(removed).toHaveBeenCalledTimes(1)
    expect(added).toHaveBeenCalledWith(expect.any(String), receipt, {
      jobId: readReceiptJobId(receipt),
      attempts: 2
    })
  })

  it.each(['completed', 'waiting', 'active'])(
    'leaves a %s job alone: that message was already told about, or is being',
    async state => {
      const { queue, removed } = queueWith(state)

      await new OutboundQueue(queue).enqueueReadReceipt(receipt)

      expect(removed).not.toHaveBeenCalled()
    }
  )
})

describe('OutboundQueue.enqueueTyping', () => {
  it('adds one attempt with no job id, so a start after a stop is never taken for a repeat', async () => {
    const { queue, added, removed } = queueWith(null)
    const typing: SendOutboundTypingJob = {
      storeId: 'store',
      conversationId: 'c1',
      active: true,
      at: 1
    }

    await new OutboundQueue(queue).enqueueTyping(typing)

    expect(added).toHaveBeenCalledWith(JobNames.SEND_OUTBOUND_TYPING, typing, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true
    })
    // Nothing is removed or reused: every start and stop is a job of its own
    expect(removed).not.toHaveBeenCalled()
  })
})
