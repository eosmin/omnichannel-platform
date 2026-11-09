import { AuthorType, MessageType } from '@platform/core/domain'

import { insertInboundMessage } from './inbound-messages'
import { messageOfProviderId } from './provider-message-match'

describe('insertInboundMessage metadata', () => {
  it('drops the keys only the platform writes and keeps the rest', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'm1' })
    const tx = { message: { create, findFirst: jest.fn() } }

    await insertInboundMessage(tx as never, {
      storeId: 's',
      conversationId: 'c',
      author: AuthorType.CUSTOMER,
      createdAt: new Date(),
      message: {
        externalId: 'x',
        type: MessageType.TEXT,
        content: 'hi',
        metadata: {
          attachmentUrl: 'https://example.com/a',
          captionFailed: true,
          captionState: 'failed',
          captionExternalId: 'z',
          unavailableFiles: [{ index: 0, code: 'refused' }]
        }
      } as never
    })

    expect((create.mock.calls[0] as [{ data: { metadata: object } }])[0].data.metadata).toEqual({
      attachmentUrl: 'https://example.com/a'
    })
  })
})

describe('insertInboundMessage quote', () => {
  const input = (replyToExternalId?: string) => ({
    storeId: 's',
    conversationId: 'c',
    author: AuthorType.CUSTOMER as typeof AuthorType.CUSTOMER,
    createdAt: new Date(),
    message: {
      externalId: 'x',
      type: MessageType.TEXT,
      content: 'hi',
      ...(replyToExternalId === undefined ? {} : { replyToExternalId })
    } as never
  })

  it.each([
    ['a message that is here', { id: 'm0' }, false],
    ['a message that is not here', null, true]
  ])('says whether the quote of %s was found', async (_name, found, unresolved) => {
    const tx = {
      message: {
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        findFirst: jest.fn().mockResolvedValue(found)
      }
    }
    await expect(insertInboundMessage(tx as never, input('wamid.0'))).resolves.toEqual({
      id: 'm1',
      replyUnresolved: unresolved
    })
    // Scoped to the store and the thread, like every tenant query
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: 's', conversationId: 'c', AND: [messageOfProviderId('s', 'wamid.0')] }
      })
    )
    expect(
      (tx.message.create.mock.calls[0] as [{ data: { replyToMessageId: string | null } }])[0].data
        .replyToMessageId
    ).toBe(found === null ? null : 'm0')
  })

  it('does not call a message with no quote an unresolved one', async () => {
    const tx = {
      message: { create: jest.fn().mockResolvedValue({ id: 'm1' }), findFirst: jest.fn() }
    }
    await expect(insertInboundMessage(tx as never, input())).resolves.toEqual({
      id: 'm1',
      replyUnresolved: false
    })
  })
})
