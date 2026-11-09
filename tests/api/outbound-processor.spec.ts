import { UnrecoverableError } from 'bullmq'

import { JobNames } from '@platform/core/queues'

import type { MessageChangeSender } from '../../apps/worker/src/outbound/message-change-sender.service'
import type { OutboundSender } from '../../apps/worker/src/outbound/outbound-sender.service'
import type { ReactionSender } from '../../apps/worker/src/outbound/reaction-sender.service'
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
  const sendReaction = jest.fn().mockResolvedValue(undefined)
  const sendReply = jest.fn().mockResolvedValue(undefined)
  const sendEdit = jest.fn().mockResolvedValue(undefined)
  const sendDeletion = jest.fn().mockResolvedValue(undefined)
  const sendCaption = jest.fn().mockResolvedValue(undefined)
  const support = {
    run: (_queue: string, current: ProcessorJob, work: (job: ProcessorJob) => Promise<void>) =>
      work(current)
  } as unknown as ProcessorSupport // test double: runs the work with no metrics
  const processor = new OutboundProcessor(
    support,
    { send: sendReply } as unknown as OutboundSender,
    { send: sendReaction } as unknown as ReactionSender,
    { sendEdit, sendDeletion, sendCaption } as unknown as MessageChangeSender,
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
    sendReaction.mockClear()
    sendReply.mockClear()
    sendEdit.mockClear()
    sendDeletion.mockClear()
    sendCaption.mockClear()
  })

  // What the queue stores is JSON: the job the worker reads is the one that crossed Redis
  const throughRedis = <T>(data: T): T => JSON.parse(JSON.stringify(data)) as T

  it('hands a reply job to the sender with its correlation id', async () => {
    const reply = { storeId: ids.storeId, messageId: ids.messageId, correlationId: 'req-1' }

    await processor.process(job(JobNames.SEND_OUTBOUND_MESSAGE, throughRedis(reply)))

    expect(sendReply).toHaveBeenCalledWith(reply, false)
  })

  it.each([
    [JobNames.SEND_OUTBOUND_EDIT, sendEdit],
    [JobNames.SEND_OUTBOUND_DELETE, sendDeletion],
    [JobNames.SEND_OUTBOUND_CAPTION, sendCaption]
  ])('hands a %s job to its own sender with every field', async (name, sender) => {
    const change = {
      storeId: ids.storeId,
      messageId: ids.messageId,
      version: 4,
      correlationId: 'req-1'
    }

    await processor.process(job(name, throughRedis(change)))

    expect(sender).toHaveBeenCalledWith(change, false)
  })

  it('hands a reaction under one file of an album to the sender with that file', async () => {
    const reaction = {
      storeId: ids.storeId,
      messageId: ids.messageId,
      userId: '3e418d96-b051-4f70-8d74-3d4e5f607182',
      version: 7,
      mediaId: '4f529ea7-c162-4081-9e85-4e5f60718293',
      correlationId: 'req-1'
    }

    await processor.process(job(JobNames.SEND_OUTBOUND_REACTION, throughRedis(reaction)))

    expect(sendReaction).toHaveBeenCalledWith(reaction, false)
  })

  it('hands a reaction under a message with no file as it came', async () => {
    const reaction = {
      storeId: ids.storeId,
      messageId: ids.messageId,
      userId: '3e418d96-b051-4f70-8d74-3d4e5f607182',
      version: 7
    }

    await processor.process(job(JobNames.SEND_OUTBOUND_REACTION, throughRedis(reaction)))

    expect(sendReaction).toHaveBeenCalledWith(reaction, false)
  })

  it('refuses for good a reaction whose file is no id', async () => {
    await expect(
      processor.process(
        job(JobNames.SEND_OUTBOUND_REACTION, {
          ...ids,
          userId: ids.storeId,
          version: 1,
          mediaId: 'x'
        })
      )
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(sendReaction).not.toHaveBeenCalled()
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
