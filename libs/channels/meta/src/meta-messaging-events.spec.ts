import { MessageType, MetaGraph, OriginKinds } from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { messagingToEvents } from './meta-messaging-events'

const ACCOUNT = '17841400000000001'
const CUSTOMER = '1234567890123456'
const OBJECT = 'instagram'
const MS = 1_761_600_000_000
const CDN = 'https://scontent.cdninstagram.com/v/file.jpg?sig=1'

const wrap = (...items: object[]): object => ({
  object: OBJECT,
  entry: [{ id: ACCOUNT, time: MS, messaging: items }]
})
const inbound = (message: object, extra: object = {}): object => ({
  sender: { id: CUSTOMER },
  recipient: { id: ACCOUNT },
  timestamp: MS,
  message,
  ...extra
})

describe('messagingToEvents', () => {
  it('maps a text message of the customer', () => {
    const [event] = messagingToEvents(wrap(inbound({ mid: 'm1', text: 'hola' })), OBJECT)

    expect(event).toEqual({
      type: ChannelEventTypes.MESSAGE_RECEIVED,
      connectionId: ACCOUNT,
      channelIdentity: CUSTOMER,
      message: {
        externalId: 'm1',
        type: MessageType.TEXT,
        content: 'hola',
        replyToExternalId: undefined,
        timestamp: new Date(MS).toISOString()
      },
      timestamp: new Date(MS).toISOString()
    })
  })

  it('keeps the message it replies to', () => {
    const [event] = messagingToEvents(
      wrap(inbound({ mid: 'm1', text: 'hola', reply_to: { mid: 'm0' } })),
      OBJECT
    )
    expect(event?.message?.replyToExternalId).toBe('m0')
  })

  it('reads every file of an album with the url as its reference', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [
            { type: 'image', payload: { url: CDN } },
            { type: 'image', payload: { url: `${CDN}2` } }
          ]
        })
      ),
      OBJECT
    )

    expect(event?.message).toMatchObject({
      type: MessageType.IMAGE,
      content: null,
      media: [
        { ref: CDN, contentType: MetaGraph.FALLBACK_CONTENT_TYPE, filename: null },
        { ref: `${CDN}2`, contentType: MetaGraph.FALLBACK_CONTENT_TYPE, filename: null }
      ]
    })
  })

  it.each([
    ['video', MessageType.VIDEO],
    ['audio', MessageType.AUDIO],
    ['file', MessageType.DOCUMENT],
    ['sticker', MessageType.IMAGE]
  ])('maps a %s attachment', (kind, type) => {
    const [event] = messagingToEvents(
      wrap(
        inbound({ mid: 'm1', text: 'mira', attachments: [{ type: kind, payload: { url: CDN } }] })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({ type, content: 'mira' })
  })

  it('keeps a shared post as a marker with its link', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [{ type: 'ig_post', payload: { url: 'https://www.instagram.com/p/abc/' } }]
        })
      ),
      OBJECT
    )

    expect(event?.message).toMatchObject({
      type: MessageType.TEXT,
      content: '[ig_post]',
      metadata: { attachmentType: 'ig_post', attachmentUrl: 'https://www.instagram.com/p/abc/' }
    })
  })

  it('keeps a message with nothing readable as an unsupported marker', () => {
    const [event] = messagingToEvents(wrap(inbound({ mid: 'm1', is_unsupported: true })), OBJECT)
    expect(event?.message).toMatchObject({ content: '[unsupported]' })
  })

  it('does not take an attachment with a url that is not http', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({ mid: 'm1', attachments: [{ type: 'image', payload: { url: 'javascript:1' } }] })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({ content: '[image]' })
    expect(event?.message?.media).toBeUndefined()
  })

  it('does not name a type that could be taken for text', () => {
    const [event] = messagingToEvents(
      wrap(inbound({ mid: 'm1', attachments: [{ type: '</b> x', payload: {} }] })),
      OBJECT
    )
    expect(event?.message?.content).toBe('[unsupported]')
  })

  it('maps a message the page wrote as an echo to the customer', () => {
    const [event] = messagingToEvents(
      wrap({
        sender: { id: ACCOUNT },
        recipient: { id: CUSTOMER },
        timestamp: MS,
        message: { mid: 'm2', text: 'respondí desde el celular', is_echo: true }
      }),
      OBJECT
    )

    expect(event).toMatchObject({
      type: ChannelEventTypes.MESSAGE_ECHO,
      connectionId: ACCOUNT,
      channelIdentity: CUSTOMER,
      message: { externalId: 'm2', content: 'respondí desde el celular' }
    })
  })

  it('skips an echo that does not come from the account', () => {
    expect(
      messagingToEvents(
        wrap({
          sender: { id: '999' },
          recipient: { id: CUSTOMER },
          timestamp: MS,
          message: { mid: 'm2', text: 'x', is_echo: true }
        }),
        OBJECT
      )
    ).toEqual([])
  })

  it('skips a message that is not for the account and one the customer took back', () => {
    expect(
      messagingToEvents(
        wrap(
          { ...inbound({ mid: 'm1', text: 'x' }), recipient: { id: '999' } },
          inbound({ mid: 'm2', is_deleted: true })
        ),
        OBJECT
      )
    ).toEqual([])
  })

  describe('reactions', () => {
    const reaction = (body: object): object => ({
      sender: { id: CUSTOMER },
      recipient: { id: ACCOUNT },
      timestamp: MS,
      reaction: body
    })

    it('maps a reaction and the taking back of it', () => {
      const events = messagingToEvents(
        wrap(
          reaction({ action: 'react', emoji: '❤️', reaction: 'love', mid: 'm1' }),
          reaction({ action: 'unreact', mid: 'm1' })
        ),
        OBJECT
      )

      expect(events.map(event => event.reaction)).toEqual([
        { targetExternalId: 'm1', emoji: '❤️' },
        { targetExternalId: 'm1', emoji: null }
      ])
      expect(events[0]).toMatchObject({
        type: ChannelEventTypes.MESSAGE_REACTION,
        connectionId: ACCOUNT,
        channelIdentity: CUSTOMER
      })
    })

    it.each([
      ['no emoji', { action: 'react', mid: 'm1' }],
      ['a blank emoji', { action: 'react', emoji: '  ', mid: 'm1' }],
      ['an emoji too long to be one', { action: 'react', emoji: '😀'.repeat(20), mid: 'm1' }],
      ['an action it does not know', { action: 'tickle', emoji: '❤️', mid: 'm1' }],
      ['no message', { action: 'react', emoji: '❤️', mid: '' }]
    ])('does not make a reaction of %s', (_name, body) => {
      expect(messagingToEvents(wrap(reaction(body)), OBJECT)).toEqual([])
    })

    it('does not read the reaction of the account itself', () => {
      expect(
        messagingToEvents(
          wrap({
            sender: { id: ACCOUNT },
            recipient: { id: CUSTOMER },
            timestamp: MS,
            reaction: { action: 'react', emoji: '👍', mid: 'm1' }
          }),
          OBJECT
        )
      ).toEqual([])
    })
  })

  describe('origin of an ad', () => {
    const referral = {
      ref: 'promo',
      ad_id: '120000000000001',
      source: 'ADS',
      type: 'OPEN_THREAD',
      ads_context_data: {
        ad_title: 'Zapatos',
        photo_url: 'https://scontent.cdninstagram.com/ad.jpg'
      }
    }

    it('takes the ad of the message', () => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', text: 'hola', referral })),
        OBJECT
      )

      expect(event?.message?.origin).toMatchObject({
        kind: OriginKinds.AD,
        sourceId: '120000000000001',
        title: 'Zapatos',
        media: { type: 'image', url: 'https://scontent.cdninstagram.com/ad.jpg' },
        referral
      })
    })

    it('takes the ad that comes beside the message', () => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', text: 'hola' }, { referral })),
        OBJECT
      )
      expect(event?.message?.origin?.kind).toBe(OriginKinds.AD)
    })

    it('calls a link with no ad "other"', () => {
      const [event] = messagingToEvents(
        wrap(
          inbound({
            mid: 'm1',
            text: 'hola',
            referral: { ref: 'bio', source: 'https://ig.me/m/shop', type: 'OPEN_THREAD' }
          })
        ),
        OBJECT
      )
      expect(event?.message?.origin).toMatchObject({
        kind: OriginKinds.OTHER,
        sourceUrl: 'https://ig.me/m/shop'
      })
    })

    it('cuts a title that is too long and never in the middle of an emoji', () => {
      const [event] = messagingToEvents(
        wrap(
          inbound({
            mid: 'm1',
            text: 'hola',
            referral: { ...referral, ads_context_data: { ad_title: '😀'.repeat(200) } }
          })
        ),
        OBJECT
      )
      const title = event?.message?.origin?.title ?? ''
      expect(title.length).toBeLessThanOrEqual(255)
      expect(title).toBe(Array.from(title).join(''))
    })

    it('leaves out an empty referral', () => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', text: 'x', referral: {} })),
        OBJECT
      )
      expect(event?.message?.origin).toBeUndefined()
    })
  })

  describe('a webhook that is not trusted', () => {
    it.each([
      ['another object', { ...wrap(inbound({ mid: 'm1', text: 'x' })), object: 'page' }],
      ['no entries', { object: OBJECT }],
      ['text', 'nope'],
      ['null', null]
    ])('gives no events for %s', (_name, payload) => {
      expect(messagingToEvents(payload, OBJECT)).toEqual([])
    })

    it('skips the entry and the event that do not fit, not the ones beside them', () => {
      const events = messagingToEvents(
        {
          object: OBJECT,
          entry: [
            { id: 'not-digits', messaging: [inbound({ mid: 'a', text: 'x' })] },
            { id: ACCOUNT, changes: [{ field: 'comments' }] },
            {
              id: ACCOUNT,
              messaging: [
                { sender: { id: CUSTOMER } },
                { ...inbound({ mid: 'b', text: 'x' }), timestamp: 1e20 },
                inbound({ mid: 'c', text: 'ok' })
              ]
            }
          ]
        },
        OBJECT
      )

      expect(events.map(event => event.message?.externalId)).toEqual(['c'])
    })

    it('reads a message whose parts are odd as what is left of it', () => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', text: 42, attachments: 'x', reply_to: 7, is_echo: 'yes' })),
        OBJECT
      )
      expect(event).toMatchObject({
        type: ChannelEventTypes.MESSAGE_RECEIVED,
        message: { externalId: 'm1', content: '[unsupported]' }
      })
    })
  })
})
