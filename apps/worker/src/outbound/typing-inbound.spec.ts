import { AuthorType } from '@platform/core/domain'

import { lastInboundOf, lastInboundQuery } from './typing-inbound'

const STORE = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'

describe('lastInboundQuery', () => {
  it('looks for the newest live message of the customer that the provider knows, inside the store', () => {
    expect(lastInboundQuery(STORE, CONVERSATION)).toEqual({
      where: {
        storeId: STORE,
        conversationId: CONVERSATION,
        authorType: AuthorType.CUSTOMER,
        // The customer may take a message back before the indicator is sent
        deletedAt: null,
        channelMessageId: { not: null }
      },
      orderBy: { createdAt: 'desc' },
      select: { channelMessageId: true, createdAt: true }
    })
  })
})

describe('lastInboundOf', () => {
  it('names the provider id and the time of the message', () => {
    expect(
      lastInboundOf(
        { channelMessageId: 'wamid.9', createdAt: new Date('2026-11-04T10:00:00.000Z') },
        true
      )
    ).toEqual({ externalId: 'wamid.9', receivedAt: '2026-11-04T10:00:00.000Z' })
  })

  // WhatsApp shows the indicator through the read receipt, so the store that switched receipts off
  // gets no message offered: it shows no indicator either, instead of marking the message as read
  it('offers no message to a store that does not send read receipts', () => {
    expect(
      lastInboundOf(
        { channelMessageId: 'wamid.9', createdAt: new Date('2026-11-04T10:00:00.000Z') },
        false
      )
    ).toBeUndefined()
  })

  it.each([
    ['no message', null],
    ['a message with no provider id', { channelMessageId: null, createdAt: new Date() }],
    ['a message with an empty provider id', { channelMessageId: '', createdAt: new Date() }]
  ])('gives nothing for %s', (_name, row) => {
    expect(lastInboundOf(row, true)).toBeUndefined()
  })
})
