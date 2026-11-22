import { FILE_WITHOUT_OWNER, filesOfConversationsWhere } from './conversation-files'

describe('filesOfConversationsWhere', () => {
  it('names the files of the messages and of the ads of the conversations, in one store', () => {
    expect(filesOfConversationsWhere('store-1', ['c1', 'c2'])).toEqual({
      storeId: 'store-1',
      orderId: null,
      financeTransactionId: null,
      fiscalDocumentId: null,
      OR: [
        { message: { conversationId: { in: ['c1', 'c2'] } } },
        { origin: { conversationId: { in: ['c1', 'c2'] } } }
      ]
    })
  })

  it('never names a file that belongs to an order or to the books: each of those owners must be empty', () => {
    const where = filesOfConversationsWhere('s', ['c'])
    expect([where.orderId, where.financeTransactionId, where.fiscalDocumentId]).toEqual([
      null,
      null,
      null
    ])
  })

  it('does not share the list it was given', () => {
    const ids = ['c1']
    const where = filesOfConversationsWhere('s', ids)
    ids.push('c2')
    expect(where.OR[0]?.message.conversationId.in).toEqual(['c1'])
  })
})

describe('FILE_WITHOUT_OWNER', () => {
  it('names the three owners a file may have besides a message, each of which must be empty', () => {
    expect(FILE_WITHOUT_OWNER).toEqual({
      orderId: null,
      financeTransactionId: null,
      fiscalDocumentId: null
    })
  })
})
