import { type Job, UnrecoverableError } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import {
  JobContextError,
  JobContextGoneError,
  JobContextMismatchError
} from '@platform/core/database'
import { MessageType } from '@platform/core/domain'
import type {
  InboundMessageChangesService,
  InboundMessageService,
  MessageReactionsService
} from '@platform/core/messaging'
import { QueueNames } from '@platform/core/queues'
import type { ProcessChannelEventJob } from '@platform/plugins/runtime'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import type { ProfileRequester } from '../../apps/worker/src/inbound/profile-requester.service'
import type { ChannelReceipts } from '../../apps/worker/src/outbound/channel-receipts.service'
import { InboundProcessor } from '../../apps/worker/src/processors/inbound.processor'
import type { ProcessorSupport } from '../../apps/worker/src/processors/processor-support'

// The store of a connection may be deleted between the moment the api resolved it and the context of the work (TDD_10 §4): the
// processor must end that job as done, with a warning, and must not retry it, while any other failure still reaches the queue.
describe('InboundProcessor and a store that was deleted', () => {
  const PLUGIN = 'test-channel'
  const subjectGone = jest.fn()
  const handleMessageReceived = jest.fn()
  const request = jest.fn()
  const handleReceipt = jest.fn()

  const support = {
    run: (_queue: string, job: Job, run: (job: Job) => Promise<void>) => run(job),
    subjectGone
  } as unknown as ProcessorSupport
  const processor = new InboundProcessor(
    support,
    { handleMessageReceived } as unknown as InboundMessageService,
    {} as unknown as MessageReactionsService,
    {} as unknown as InboundMessageChangesService,
    { handleReceipt } as unknown as ChannelReceipts,
    { request } as unknown as ProfileRequester,
    {
      setContext: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    } as unknown as PinoLogger
  )

  const jobOf = (data: unknown): Job<ProcessChannelEventJob> =>
    ({
      name: 'process-channel-event',
      data,
      attemptsMade: 0,
      opts: { attempts: 3 }
    }) as unknown as Job<ProcessChannelEventJob>

  const received = (): ProcessChannelEventJob => ({
    pluginId: PLUGIN,
    receivedAt: new Date().toISOString(),
    event: {
      type: ChannelEventTypes.MESSAGE_RECEIVED,
      connectionId: 'connection-1',
      channelIdentity: 'customer-1',
      message: {
        externalId: 'external-1',
        type: MessageType.TEXT,
        content: 'hello',
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    }
  })

  beforeEach(() => {
    subjectGone.mockReset()
    handleMessageReceived.mockReset()
    request.mockReset()
    handleReceipt.mockReset()
  })

  it('ends as done, with a warning, a message of a connection whose store is gone, and asks for no profile', async () => {
    const gone = new JobContextGoneError('gone')
    handleMessageReceived.mockRejectedValue(gone)
    const job = jobOf(received())
    await expect(processor.process(job)).resolves.toBeUndefined()
    expect(subjectGone).toHaveBeenCalledTimes(1)
    expect(subjectGone).toHaveBeenCalledWith(QueueNames.INBOUND, job, gone)
    expect(request).not.toHaveBeenCalled()
  })

  it('ends as done a receipt whose store is gone, the same way', async () => {
    handleReceipt.mockRejectedValue(new JobContextGoneError('gone'))
    const receipt: ProcessChannelEventJob = {
      pluginId: PLUGIN,
      receivedAt: new Date().toISOString(),
      event: {
        type: ChannelEventTypes.MESSAGE_DELIVERED,
        connectionId: 'connection-1',
        channelIdentity: 'customer-1',
        status: { externalId: 'external-1' },
        timestamp: new Date().toISOString()
      }
    }
    await expect(processor.process(jobOf(receipt))).resolves.toBeUndefined()
    expect(subjectGone).toHaveBeenCalledTimes(1)
  })

  it('lets any other failure reach the queue, so that the job is retried', async () => {
    handleMessageReceived.mockRejectedValue(new JobContextError('hidden'))
    await expect(processor.process(jobOf(received()))).rejects.toBeInstanceOf(JobContextError)
    expect(subjectGone).not.toHaveBeenCalled()
  })

  it('does not retry a payload whose store is not the one of its row', async () => {
    handleMessageReceived.mockRejectedValue(new JobContextMismatchError('no'))
    await expect(processor.process(jobOf(received()))).rejects.toBeInstanceOf(UnrecoverableError)
    expect(subjectGone).not.toHaveBeenCalled()
  })

  it('sends to the dead letter queue an event that does not fit its schema, without touching the database', async () => {
    const job = received()
    await expect(
      processor.process(jobOf({ ...job, event: { ...job.event, connectionId: '' } }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(
      processor.process(jobOf({ ...job, pluginId: 'Not A Channel' }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(handleMessageReceived).not.toHaveBeenCalled()
    expect(subjectGone).not.toHaveBeenCalled()
  })
})
