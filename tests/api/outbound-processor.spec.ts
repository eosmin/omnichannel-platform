import { UnrecoverableError } from 'bullmq'

import { JobNames } from '@platform/core/queues'

import type { ReadReceiptSender } from '../../apps/worker/src/outbound/read-receipt-sender.service'
import type { TypingSender } from '../../apps/worker/src/outbound/typing-sender.service'
import { OutboundProcessor } from '../../apps/worker/src/processors/outbound.processor'
import type { ProcessorSupport } from '../../apps/worker/src/processors/processor-support'

type ProcessorJob = Parameters<OutboundProcessor['process']>[0]

const job = (name: string, data: unknown, attemptsMade = 0): ProcessorJob =>
  ({ name, data, attemptsMade, opts: { attempts: 2 } }) as unknown as ProcessorJob // the fields the processor reads

describe('OutboundProcessor', () => {
  const send = jest.fn().mockResolvedValue(undefined)
  const sendTyping = jest.fn().mockResolvedValue(undefined)
  const support = {
    run: (_queue: string, current: ProcessorJob, work: (job: ProcessorJob) => Promise<void>) =>
      work(current)
  } as unknown as ProcessorSupport // test double: runs the work with no metrics
  const processor = new OutboundProcessor(
    support,
    {} as never, // the replies are not what is tested
    {} as never, // the reactions are not what is tested
    {} as never, // the edits are not what is tested
    { send } as unknown as ReadReceiptSender,
    { send: sendTyping } as unknown as TypingSender
  )
  const ids = {
    storeId: '0b1f5a63-8d2e-4c4d-9a41-0a1b2c3d4e5f',
    conversationId: '1c2f6b74-9e3f-4d5e-8b52-1b2c3d4e5f60',
    messageId: '2d307c85-af40-4e6f-9c63-2c3d4e5f6071'
  }

  beforeEach(() => {
    send.mockClear()
    sendTyping.mockClear()
  })

  it('hands a read receipt job to the sender, with whether it is the last attempt', async () => {
    await processor.process(job(JobNames.SEND_OUTBOUND_READ_RECEIPT, ids))

    expect(send).toHaveBeenCalledWith(ids, false)
  })

  it('tells the sender when it is the last attempt', async () => {
    await processor.process(job(JobNames.SEND_OUTBOUND_READ_RECEIPT, ids, 1))

    expect(send).toHaveBeenCalledWith(ids, true)
  })

  it('refuses for good a read receipt job that does not fit its schema', async () => {
    await expect(
      processor.process(job(JobNames.SEND_OUTBOUND_READ_RECEIPT, { ...ids, conversationId: 'x' }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(send).not.toHaveBeenCalled()
  })

  it('hands a typing job to the typing sender', async () => {
    const typing = {
      storeId: ids.storeId,
      conversationId: ids.conversationId,
      active: true,
      at: 1
    }

    await processor.process(job(JobNames.SEND_OUTBOUND_TYPING, typing))

    expect(sendTyping).toHaveBeenCalledWith(typing)
  })

  it('refuses for good a typing job that does not fit its schema', async () => {
    await expect(
      processor.process(job(JobNames.SEND_OUTBOUND_TYPING, { ...ids, active: 'yes', at: 1 }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(sendTyping).not.toHaveBeenCalled()
  })

  it('refuses a job name the queue does not know', async () => {
    await expect(processor.process(job('send-something-else', ids))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
  })
})
