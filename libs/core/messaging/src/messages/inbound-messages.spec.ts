import { AuthorType, MessageType } from '@platform/core/domain'

import { insertInboundMessage } from './inbound-messages'

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
