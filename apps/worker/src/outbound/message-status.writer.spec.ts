import { DeliveryStatus } from '@platform/core/domain'

import { MessageStatusWriter } from './message-status.writer'

const STORE = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '22222222-2222-4222-8222-222222222222'

function setup(changed: number) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    message: {
      updateMany: jest
        .fn()
        .mockResolvedValueOnce({ count: changed })
        .mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({
        metadata: { other: 1 },
        conversationId: 'c',
        conversation: { status: 'open', assignedTo: null }
      })
    }
  }
  const prisma = { transaction: jest.fn((work: (t: typeof tx) => Promise<boolean>) => work(tx)) }
  const events = { publish: jest.fn() }
  return { writer: new MessageStatusWriter(prisma as never, events as never), tx, events }
}

describe('MessageStatusWriter caption facts', () => {
  const change = {
    storeId: STORE,
    messageId: MESSAGE,
    to: DeliveryStatus.SENT as typeof DeliveryStatus.SENT,
    captionExternalId: 'cap-1',
    captionFailed: true
  }

  it('writes the caption id and the flag when the state changes', async () => {
    const { writer, tx, events } = setup(1)

    await expect(writer.apply(change)).resolves.toBe(true)

    const data = tx.message.updateMany.mock.calls.map(call => (call as [{ data: object }])[0].data)
    expect(data).toContainEqual({ captionChannelMessageId: 'cap-1' })
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect(events.publish).toHaveBeenCalled()
  })

  it('writes them too when a receipt moved the message past that state first, without an event', async () => {
    const { writer, tx, events } = setup(0)

    await expect(writer.apply(change)).resolves.toBe(false)

    const data = tx.message.updateMany.mock.calls.map(call => (call as [{ data: object }])[0].data)
    expect(data).toContainEqual({ captionChannelMessageId: 'cap-1' })
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect(events.publish).not.toHaveBeenCalled()
  })
})
