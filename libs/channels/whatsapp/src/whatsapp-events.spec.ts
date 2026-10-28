import { MessageType } from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { webhookToEvents } from './whatsapp-events'

const PHONE = '106540352242922'

function webhook(value: object, field = 'messages'): object {
  return {
    object: 'whatsapp_business_account',
    entry: [
      { id: '1', changes: [{ field, value: { metadata: { phone_number_id: PHONE }, ...value } }] }
    ]
  }
}

const received = (message: object): object =>
  webhook({
    messages: [{ from: '15550001111', id: 'wamid.1', timestamp: '1761600000', ...message }]
  })

describe('webhookToEvents', () => {
  it('turns a text into a received message for the recipient number', () => {
    const [event] = webhookToEvents(
      webhook({
        contacts: [{ wa_id: '15550001111', profile: { name: 'Ana' } }],
        messages: [
          {
            from: '15550001111',
            id: 'wamid.1',
            timestamp: '1761600000',
            type: 'text',
            text: { body: 'hola' },
            context: { id: 'wamid.0' }
          }
        ]
      })
    )
    expect(event).toEqual({
      type: ChannelEventTypes.MESSAGE_RECEIVED,
      connectionId: PHONE,
      channelIdentity: '15550001111',
      channelProfile: { displayName: 'Ana' },
      message: {
        externalId: 'wamid.1',
        type: MessageType.TEXT,
        content: 'hola',
        replyToExternalId: 'wamid.0',
        timestamp: '2025-10-27T21:20:00.000Z'
      },
      timestamp: '2025-10-27T21:20:00.000Z'
    })
  })

  it.each([
    ['image', MessageType.IMAGE],
    ['video', MessageType.VIDEO],
    ['audio', MessageType.AUDIO],
    ['document', MessageType.DOCUMENT],
    ['sticker', MessageType.IMAGE]
  ])('keeps the media reference of a %s without fetching it', (type, expected) => {
    const [event] = webhookToEvents(
      received({ type, [type]: { id: '555', mime_type: 'x/y', caption: 'cap', filename: 'f.bin' } })
    )
    expect(event?.message).toMatchObject({
      type: expected,
      content: 'cap',
      media: { ref: '555', contentType: 'x/y', filename: 'f.bin' }
    })
  })

  it('falls back to a generic content type when Meta gives none', () => {
    const [event] = webhookToEvents(received({ type: 'audio', audio: { id: '5' } }))
    expect(event?.message?.media).toEqual({
      ref: '5',
      contentType: 'application/octet-stream',
      filename: null
    })
  })

  it('reads a location, with the coordinates as numbers', () => {
    const [event] = webhookToEvents(
      received({
        type: 'location',
        location: { latitude: '19.4', longitude: -99.1, name: 'Shop', address: 'Street 1' }
      })
    )
    expect(event?.message).toMatchObject({
      type: MessageType.LOCATION,
      content: 'Shop - Street 1',
      metadata: { latitude: 19.4, longitude: -99.1 }
    })
  })

  it('reads the choice of a button or a list as text, keeping its id', () => {
    const [button] = webhookToEvents(
      received({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Yes' } }
      })
    )
    const [list] = webhookToEvents(
      received({
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Two' } }
      })
    )
    expect(button?.message).toMatchObject({ content: 'Yes', metadata: { replyId: 'b1' } })
    expect(list?.message).toMatchObject({ content: 'Two', metadata: { replyId: 'l1' } })
  })

  it('keeps a message of a type it does not know, as a marker, so that it is not lost', () => {
    const [event] = webhookToEvents(received({ type: 'order', order: {} }))
    expect(event?.message).toMatchObject({
      type: MessageType.TEXT,
      content: '[order]',
      metadata: { whatsappType: 'order' }
    })
  })

  it('does not make a message of a reaction', () => {
    expect(
      webhookToEvents(received({ type: 'reaction', reaction: { message_id: 'x', emoji: 'x' } }))
    ).toEqual([])
  })

  it.each([
    ['sent', ChannelEventTypes.MESSAGE_SENT],
    ['delivered', ChannelEventTypes.MESSAGE_DELIVERED],
    ['read', ChannelEventTypes.MESSAGE_READ]
  ])('turns a %s status into its event', (status, type) => {
    const [event] = webhookToEvents(
      webhook({
        statuses: [{ id: 'wamid.9', recipient_id: '15550001111', status, timestamp: '1761600000' }]
      })
    )
    expect(event).toMatchObject({
      type,
      connectionId: PHONE,
      channelIdentity: '15550001111',
      status: { externalId: 'wamid.9' }
    })
  })

  it('carries the error of a failed status as text', () => {
    const [event] = webhookToEvents(
      webhook({
        statuses: [
          {
            id: 'wamid.9',
            recipient_id: '15550001111',
            status: 'failed',
            timestamp: '1761600000',
            errors: [{ code: 131047, title: 'Re-engagement message' }]
          }
        ]
      })
    )
    expect(event).toMatchObject({
      type: ChannelEventTypes.MESSAGE_FAILED,
      status: { error: { code: '131047', message: 'Re-engagement message' } }
    })
  })

  it('ignores a deleted status and the fields it does not subscribe to', () => {
    expect(
      webhookToEvents(
        webhook({
          statuses: [
            { id: 'w', recipient_id: '15550001111', status: 'deleted', timestamp: '1761600000' }
          ]
        })
      )
    ).toEqual([])
    expect(webhookToEvents(webhook({ messages: [{}] }, 'account_update'))).toEqual([])
  })

  it('skips the item that does not fit and keeps the ones beside it', () => {
    const events = webhookToEvents(
      webhook({
        messages: [
          {
            from: '15550001111',
            id: 'a',
            timestamp: 'soon',
            type: 'text',
            text: { body: 'bad time' }
          },
          {
            from: '15550001111',
            id: 'b',
            timestamp: '1761600000',
            type: 'text',
            text: { body: 'ok' }
          },
          'garbage'
        ]
      })
    )
    expect(events.map(event => event.message?.externalId)).toEqual(['b'])
  })

  it('keeps the messages when a contact does not fit', () => {
    const events = webhookToEvents(
      webhook({
        contacts: [{ profile: {} }, { wa_id: '15550001111' }],
        messages: [
          {
            from: '15550001111',
            id: 'b',
            timestamp: '1761600000',
            type: 'text',
            text: { body: 'ok' }
          }
        ]
      })
    )
    expect(events.map(event => event.message?.externalId)).toEqual(['b'])
  })

  it('keeps a media message whose optional fields are odd', () => {
    const [event] = webhookToEvents(
      received({ type: 'image', image: { id: '5', mime_type: '', caption: null, filename: 7 } })
    )
    expect(event?.message).toMatchObject({
      type: MessageType.IMAGE,
      content: null,
      media: { ref: '5', contentType: 'application/octet-stream', filename: null }
    })
  })

  it.each(['system', 'reaction'])('does not make a customer message of a %s', type => {
    expect(webhookToEvents(received({ type, [type]: {} }))).toEqual([])
  })

  it.each([
    ['a blank text', { type: 'text', text: { body: '   ' } }, '[text]'],
    [
      'a reply with no title',
      {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'a', title: '' } }
      },
      '[interactive]'
    ],
    ['a text with no body', { type: 'text', text: {} }, '[text]'],
    ['a location with no coordinates', { type: 'location', location: { name: 'x' } }, '[location]'],
    [
      'a location at Infinity',
      { type: 'location', location: { latitude: 'Infinity', longitude: 1 } },
      '[location]'
    ],
    [
      'a location with empty coordinates',
      { type: 'location', location: { latitude: '', longitude: '' } },
      '[location]'
    ],
    [
      'a location out of range',
      { type: 'location', location: { latitude: 200, longitude: 1 } },
      '[location]'
    ]
  ])('keeps %s as a marker and does not lose or misplace it', (_name, message, content) => {
    const [event] = webhookToEvents(received(message))
    expect(event?.message?.content).toBe(content)
    expect(event?.message?.type).toBe(MessageType.TEXT)
  })

  it('keeps the entries beside one that does not fit', () => {
    const good = (
      webhook({
        messages: [
          {
            from: '15550001111',
            id: 'ok',
            timestamp: '1761600000',
            type: 'text',
            text: { body: 'hi' }
          }
        ]
      }) as { entry: unknown[] }
    ).entry
    const events = webhookToEvents({
      object: 'whatsapp_business_account',
      entry: [{ id: 'no changes' }, { changes: [{ value: {} }] }, ...good]
    })
    expect(events.map(event => event.message?.externalId)).toEqual(['ok'])
  })

  it.each([
    ['a string code', { code: 'abc', title: 'T' }],
    ['no code', { title: 'T' }],
    ['a title that is not text', { code: 5, title: 9 }]
  ])('keeps a failed status whose error has %s', (_name, error) => {
    const [event] = webhookToEvents(
      webhook({
        statuses: [
          {
            id: 'w',
            recipient_id: '15550001111',
            status: 'failed',
            timestamp: '1761600000',
            errors: [error]
          }
        ]
      })
    )
    expect(event?.type).toBe(ChannelEventTypes.MESSAGE_FAILED)
    expect(event?.status?.externalId).toBe('w')
  })

  describe('a customer who has no phone number (business-scoped user id)', () => {
    const BSUID = 'US.13491208655302741918'

    it('identifies the customer by the user id when the phone does not arrive', () => {
      const [event] = webhookToEvents(
        webhook({
          contacts: [{ user_id: BSUID, profile: { name: 'Ana' } }],
          messages: [
            {
              from_user_id: BSUID,
              id: 'wamid.1',
              timestamp: '1761600000',
              type: 'text',
              text: { body: 'hola' }
            }
          ]
        })
      )
      expect(event).toMatchObject({
        channelIdentity: BSUID,
        channelProfile: { displayName: 'Ana' },
        message: { content: 'hola' }
      })
    })

    it('prefers the phone while it arrives, and names the customer from either id', () => {
      const [event] = webhookToEvents(
        webhook({
          contacts: [{ wa_id: '15550001111', user_id: BSUID, profile: { name: 'Ana' } }],
          messages: [
            {
              from: '15550001111',
              from_user_id: BSUID,
              id: 'wamid.1',
              timestamp: '1761600000',
              type: 'text',
              text: { body: 'hola' }
            }
          ]
        })
      )
      expect(event).toMatchObject({
        channelIdentity: '15550001111',
        channelProfile: { displayName: 'Ana' }
      })
    })

    it('keeps the user id beside the phone while both arrive, to join them once the phone stops', () => {
      const [event] = webhookToEvents(
        webhook({
          messages: [
            {
              from: '15550001111',
              from_user_id: BSUID,
              id: 'wamid.1',
              timestamp: '1761600000',
              type: 'text',
              text: { body: 'hola' }
            }
          ]
        })
      )
      expect(event?.message?.metadata).toMatchObject({ whatsappUserId: BSUID })
    })

    it('reads a status addressed by user id', () => {
      const [event] = webhookToEvents(
        webhook({
          statuses: [{ id: 'w', recipient_user_id: BSUID, status: 'read', timestamp: '1761600000' }]
        })
      )
      expect(event).toMatchObject({ type: ChannelEventTypes.MESSAGE_READ, channelIdentity: BSUID })
    })

    it('skips a message that names no customer at all', () => {
      expect(
        webhookToEvents(received({ from: undefined, type: 'text', text: { body: 'x' } }))
      ).toEqual([])
    })
  })

  it('does not keep a blank caption as the content of a media message', () => {
    const [event] = webhookToEvents(received({ type: 'image', image: { id: '5', caption: '   ' } }))
    expect(event?.message?.content).toBeNull()
  })

  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\x\\evil.html', 'evil.html'],
    ['a"b\r\nX: y.pdf', 'abX: y.pdf'],
    ['..', null],
    ['.hidden', 'hidden'],
    ['   ', null]
  ])('keeps only a safe file name: %j becomes %j', (filename, expected) => {
    const [event] = webhookToEvents(received({ type: 'document', document: { id: '5', filename } }))
    expect(event?.message?.media?.filename).toBe(expected)
  })

  it('cuts the id of a button reply so that the event is not refused for its size', () => {
    const [event] = webhookToEvents(
      received({
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'x'.repeat(20_000), title: 'Yes' }
        }
      })
    )
    expect((event?.message?.metadata?.['replyId'] as string).length).toBeLessThanOrEqual(255)
  })

  it.each([
    ['a type with markup', '<img src=x onerror=alert(1)>', '[unknown]'],
    ['a type with a line break', 'a\nb', '[unknown]'],
    ['a plain type', 'order', '[order]']
  ])('marks %s without echoing it', (_name, type, content) => {
    const [event] = webhookToEvents(received({ type, [type]: {} }))
    expect(event?.message?.content).toBe(content)
  })

  describe('the identity of the customer', () => {
    it.each([['+15550001111'], ['1555 000 1111'], ['not a number'], ['1'.repeat(16)]])(
      'does not take %j as a phone, and falls to the user id',
      from => {
        const [event] = webhookToEvents(
          received({ from, from_user_id: 'US.134912', type: 'text', text: { body: 'x' } })
        )
        expect(event?.channelIdentity).toBe('US.134912')
      }
    )

    it('skips a message that names no one it could answer', () => {
      expect(
        webhookToEvents(received({ from: 'not a number', type: 'text', text: { body: 'x' } }))
      ).toEqual([])
    })
  })

  it.each([
    null,
    'text',
    42,
    [],
    {},
    { object: 'page', entry: [] },
    { object: 'whatsapp_business_account' }
  ])('returns nothing for %p', payload => {
    expect(webhookToEvents(payload)).toEqual([])
  })
})
