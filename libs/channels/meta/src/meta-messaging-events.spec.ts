import { InboundLimits, MessageType, OriginKinds } from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { MetaMessaging, MetaGraph } from './meta-constants'
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

  it('keeps the link of a shared reel beside its caption', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          text: 'mira este',
          attachments: [
            { type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/abc/' } }
          ]
        })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({
      content: 'mira este',
      metadata: { attachmentType: 'ig_reel', attachmentUrl: 'https://www.instagram.com/reel/abc/' }
    })
  })

  it('keeps the link of a shared post beside a file, and a type name that is plain', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [
            { type: 'image', payload: { url: CDN } },
            { type: 'story_mention', payload: { url: 'https://www.instagram.com/stories/x/1/' } }
          ]
        })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({
      type: MessageType.IMAGE,
      metadata: {
        attachmentType: 'story_mention',
        attachmentUrl: 'https://www.instagram.com/stories/x/1/'
      }
    })
  })

  it('keeps the link of the story an Instagram customer replied to, beside the text (IG-07)', () => {
    const story = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1'
    const [event] = messagingToEvents(
      wrap(
        inbound({ mid: 'm1', text: 'me encanta', reply_to: { story: { url: story, id: '9' } } })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({
      content: 'me encanta',
      metadata: { storyReply: { url: story } }
    })
    // The story is not a shared link: nothing is drawn as one
    expect(event?.message?.metadata).not.toHaveProperty('attachmentUrl')
    // No reply to a message: the story is not one
    expect(event?.message).toMatchObject({ replyToExternalId: undefined })
  })

  it('reads a reply to both a message and a story, and a story without a link as a story reply with no link', () => {
    const [both] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          text: 'hola',
          reply_to: { mid: 'm0', story: { url: 'https://lookaside.fbsbx.com/x' } }
        })
      ),
      OBJECT
    )
    expect(both?.message).toMatchObject({ replyToExternalId: 'm0' })
    const [noLink] = messagingToEvents(
      wrap(inbound({ mid: 'm2', text: 'hola', reply_to: { story: { id: '9' } } })),
      OBJECT
    )
    expect(noLink?.message).toMatchObject({ metadata: { storyReply: {} } })
    // Not a story: nothing
    const [plain] = messagingToEvents(wrap(inbound({ mid: 'm3', text: 'hola' })), OBJECT)
    expect(plain?.message).not.toHaveProperty('metadata')
  })

  it('keeps the story reply beside a like', () => {
    const story = { url: 'https://lookaside.fbsbx.com/x' }
    const [like] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm5',
          attachments: [
            {
              type: 'image',
              payload: {
                url: 'https://scontent.cdninstagram.com/like.png',
                sticker_id: MetaMessaging.LIKE_STICKER_IDS[0]
              }
            }
          ],
          reply_to: { story }
        })
      ),
      OBJECT
    )
    expect(like?.message).toMatchObject({
      content: MetaMessaging.LIKE_TEXT,
      metadata: { storyReply: story }
    })
  })

  it('drops the link of a story on a host that is not allowed, and keeps that it was a story', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({ mid: 'm6', text: 'hi', reply_to: { story: { url: 'https://example.com/x' } } })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({ metadata: { storyReply: {} } })
    expect(JSON.stringify(event?.message)).not.toContain('example.com')
  })

  it('keeps both what the customer shared and the story they replied to', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [{ type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/a/' } }],
          reply_to: { story: { url: 'https://lookaside.fbsbx.com/x' } }
        })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({
      metadata: {
        attachmentUrl: 'https://www.instagram.com/reel/a/',
        storyReply: { url: 'https://lookaside.fbsbx.com/x' }
      }
    })
  })

  it.each(['https://127.0.0.1/a.jpg', 'https://10.0.0.5/a.jpg', 'http://localhost/a.jpg'])(
    'keeps a file whose link is not a public address (%s), for the worker to refuse with a notice (MS-04)',
    url => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', attachments: [{ type: 'image', payload: { url } }] })),
        OBJECT
      )
      expect(event?.message).toMatchObject({
        type: MessageType.IMAGE,
        media: [{ ref: url }]
      })
    }
  )

  it.each(['1234567890', 'abc-1', '   ', ''])(
    'does not hand a customer text that could pass for an id of the provider to the worker (%j)',
    url => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', attachments: [{ type: 'image', payload: { url } }] })),
        OBJECT
      )
      expect(event?.message?.media).toBeUndefined()
      expect(event?.message).toMatchObject({ content: '[image]' })
    }
  )

  it('keeps the photo and the story reply when the customer replies to a story with a file', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [{ type: 'image', payload: { url: CDN } }],
          reply_to: { story: { url: 'https://lookaside.fbsbx.com/x' } }
        })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({
      type: MessageType.IMAGE,
      media: [{ ref: CDN }],
      metadata: { storyReply: { url: 'https://lookaside.fbsbx.com/x' } }
    })
  })

  it('does not put the type name of a sender into the metadata when it is not plain', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          text: 'hola',
          attachments: [
            { type: 'x'.repeat(9000), payload: { url: 'https://www.instagram.com/p/a/' } }
          ]
        })
      ),
      OBJECT
    )
    expect(event?.message?.metadata).toEqual({
      attachmentType: 'unsupported',
      attachmentUrl: 'https://www.instagram.com/p/a/'
    })
  })

  it('finds a shared link after a file that has none', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [
            { type: 'image' },
            { type: 'ig_post', payload: { url: 'https://www.instagram.com/p/abc/' } }
          ]
        })
      ),
      OBJECT
    )
    expect(event?.message).toMatchObject({
      content: '[ig_post]',
      metadata: { attachmentUrl: 'https://www.instagram.com/p/abc/' }
    })
  })

  it('keeps a message with nothing readable as an unsupported marker', () => {
    const [event] = messagingToEvents(wrap(inbound({ mid: 'm1', is_unsupported: true })), OBJECT)
    expect(event?.message).toMatchObject({
      content: '[unsupported]',
      metadata: { unsupportedType: 'unsupported' }
    })
  })

  describe('a place that Instagram sends as a template', () => {
    const template = (url: string | undefined, element: object = {}): object => ({
      type: 'template',
      payload: {
        generic: {
          elements: [
            {
              title: 'Mi casa',
              subtitle: 'Colonia Escalón',
              image_url: 'https://scontent.cdninstagram.com/v/map.jpg',
              ...(url === undefined ? {} : { default_action: { type: 'web_url', url } }),
              ...element
            }
          ]
        }
      }
    })

    it('is a location card when the link is a map with coordinates', () => {
      const [event] = messagingToEvents(
        wrap(
          inbound({
            mid: 'm1',
            attachments: [template('https://maps.apple.com/?coordinate=13.69,-89.21')]
          })
        ),
        OBJECT
      )
      expect(event?.message).toMatchObject({
        type: MessageType.LOCATION,
        content: 'Mi casa',
        metadata: {
          latitude: 13.69,
          longitude: -89.21,
          name: 'Mi casa',
          address: 'Colonia Escalón'
        }
      })
      expect(event?.message?.media).toBeUndefined()
    })

    it('reads the link of a button when the element has no default action', () => {
      const [event] = messagingToEvents(
        wrap(
          inbound({
            mid: 'm1',
            attachments: [
              template(undefined, {
                buttons: [
                  {
                    type: 'web_url',
                    url: 'https://www.google.com/maps/place/Casa/@13.69,-89.21,17z'
                  }
                ]
              })
            ]
          })
        ),
        OBJECT
      )
      expect(event?.message?.type).toBe(MessageType.LOCATION)
    })

    it.each([
      ['a link that is not a map', 'https://evil.example/?ll=13.69,-89.21'],
      ['a short link with no coordinates', 'https://maps.app.goo.gl/abc'],
      ['no link', undefined]
    ])('stays the marker of an unsupported type with %s', (_name, url) => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', attachments: [template(url)] })),
        OBJECT
      )
      expect(event?.message).toMatchObject({
        type: MessageType.TEXT,
        content: '[template]',
        metadata: { unsupportedType: 'template' }
      })
      // Whatever the template held, the title is not put in the message
      expect(JSON.stringify(event?.message)).not.toContain('Mi casa')
    })

    it('is a location card even when the template has no title', () => {
      const [event] = messagingToEvents(
        wrap(
          inbound({
            mid: 'm1',
            attachments: [
              {
                type: 'template',
                payload: {
                  generic: {
                    elements: [
                      { default_action: { url: 'https://maps.apple.com/?coordinate=13.69,-89.21' } }
                    ]
                  }
                }
              }
            ]
          })
        ),
        OBJECT
      )
      expect(event?.message).toMatchObject({
        type: MessageType.LOCATION,
        metadata: { latitude: 13.69, longitude: -89.21 }
      })
    })

    it('reads the map link from a second element and names its fields', () => {
      const [event] = messagingToEvents(
        wrap(
          inbound({
            mid: 'm1',
            attachments: [
              {
                type: 'template',
                payload: {
                  generic: {
                    elements: [
                      { title: 'Header' },
                      {
                        title: 'Casa',
                        buttons: [{ url: 'https://maps.apple.com/?coordinate=13.69,-89.21' }]
                      }
                    ]
                  }
                }
              }
            ]
          })
        ),
        OBJECT
      )
      expect(event?.message?.type).toBe(MessageType.LOCATION)
    })

    it('names the fields of the element for the team, never their values', () => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', attachments: [template('https://evil.example/x?secret=1')] })),
        OBJECT
      )
      const shape = event?.message?.metadata?.unsupportedShape as {
        attachments: { elementFields: string[] }[]
      }
      expect(shape.attachments[0]?.elementFields).toEqual(
        expect.arrayContaining([
          'title',
          'subtitle',
          'image_url',
          'default_action',
          'default_action.url'
        ])
      )
      expect(JSON.stringify(shape)).not.toContain('secret')
      expect(JSON.stringify(shape)).not.toContain('Mi casa')
    })
  })

  it('keeps only the names of what a type it cannot read carried, for the team to map it later', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [
            {
              type: 'ig_place',
              title: 'Secret street 1',
              payload: {
                url: 'https://l.instagram.com/?u=secret',
                coordinates: { lat: 1, long: 2 }
              }
            },
            { type: '</b> x', payload: { 'bad key!': 1, ok_key: 2 } }
          ],
          extra_field: 'secret value'
        })
      ),
      OBJECT
    )
    expect(event?.message?.metadata).toMatchObject({
      unsupportedShape: {
        messageFields: ['mid', 'attachments', 'extra_field'],
        attachments: [
          {
            type: 'ig_place',
            fields: ['type', 'title', 'payload'],
            payloadFields: ['url', 'coordinates', 'coordinates.lat', 'coordinates.long']
          },
          { type: 'unsupported', fields: ['type', 'payload'], payloadFields: ['ok_key'] }
        ]
      }
    })
    // Names only: no value of the customer, no link
    const stored = JSON.stringify(event?.message?.metadata?.unsupportedShape)
    expect(stored).not.toContain('secret')
    expect(stored).not.toContain('instagram.com')
  })

  it('keeps the shape of the worst message inside the metadata cap, link included', () => {
    const names = (prefix: string, count: number): Record<string, number> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`${prefix}${i}`.padEnd(32, 'x'), 1])
      )
    const nested = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`n${i}`.padEnd(32, 'y'), names('k', 30)])
    )
    const url = `https://www.instagram.com/${'a'.repeat(2000)}`
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          ...names('m', 40),
          attachments: Array.from({ length: 20 }, () => ({
            type: 't'.repeat(32),
            ...names('f', 40),
            payload: {
              url,
              ...nested,
              generic: {
                elements: [
                  { ...names('e', 40), default_action: names('d', 40), buttons: [names('b', 40)] }
                ]
              }
            }
          }))
        })
      ),
      OBJECT
    )
    expect(Buffer.byteLength(JSON.stringify(event?.message?.metadata))).toBeLessThan(
      InboundLimits.METADATA_MAX_BYTES
    )
    expect(event?.message?.metadata?.unsupportedShape).toBeDefined()
  })

  it('names the top-level fields first, so nested ones never push them out', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          attachments: [
            {
              type: 'ig_place',
              payload: { coordinates: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, last_one: 1 }
            }
          ]
        })
      ),
      OBJECT
    )
    const shape = event?.message?.metadata?.unsupportedShape as {
      attachments: { payloadFields: string[] }[]
    }
    expect(shape.attachments[0]?.payloadFields.slice(0, 2)).toEqual(['coordinates', 'last_one'])
  })

  it('does not add a shape to a message that is read', () => {
    const [event] = messagingToEvents(wrap(inbound({ mid: 'm1', text: 'hola' })), OBJECT)
    expect(event?.message?.metadata).toBeUndefined()
  })

  it('does not mark as unsupported a text that comes with a shared link', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({
          mid: 'm1',
          text: '[ig_post]',
          attachments: [{ type: 'ig_post', payload: { url: 'https://www.instagram.com/p/abc/' } }]
        })
      ),
      OBJECT
    )
    expect(event?.message?.metadata).not.toHaveProperty('unsupportedType')
  })

  it('hands an attachment with a url that is not http to the worker, which refuses it with a notice', () => {
    const [event] = messagingToEvents(
      wrap(
        inbound({ mid: 'm1', attachments: [{ type: 'image', payload: { url: 'javascript:1' } }] })
      ),
      OBJECT
    )
    // Never fetched from here: the worker checks every link and marks the file `unsafe_link`
    expect(event?.message).toMatchObject({ media: [{ ref: 'javascript:1' }] })
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

  it('skips an echo of the account to itself', () => {
    expect(
      messagingToEvents(
        wrap({
          sender: { id: ACCOUNT },
          recipient: { id: ACCOUNT },
          timestamp: MS,
          message: { mid: 'm3', text: 'x', is_echo: true }
        }),
        OBJECT
      )
    ).toEqual([])
  })

  it('skips a message that is not for the account', () => {
    expect(
      messagingToEvents(
        wrap({ ...inbound({ mid: 'm1', text: 'x' }), recipient: { id: '999' } }),
        OBJECT
      )
    ).toEqual([])
  })

  describe('deletions', () => {
    it('maps a message the customer took back', () => {
      const [event] = messagingToEvents(wrap(inbound({ mid: 'm2', is_deleted: true })), OBJECT)
      expect(event).toEqual({
        type: ChannelEventTypes.MESSAGE_DELETED,
        connectionId: ACCOUNT,
        channelIdentity: CUSTOMER,
        deletion: { targetExternalId: 'm2' },
        timestamp: new Date(MS).toISOString()
      })
    })

    it('maps a message the owner took back in the provider app, as the owner', () => {
      const [event] = messagingToEvents(
        wrap({
          sender: { id: ACCOUNT },
          recipient: { id: CUSTOMER },
          timestamp: MS,
          message: { mid: 'm3', is_echo: true, is_deleted: true }
        }),
        OBJECT
      )
      expect(event?.type).toBe(ChannelEventTypes.MESSAGE_DELETED)
      expect(event?.channelIdentity).toBe(CUSTOMER)
      expect(event?.deletion).toEqual({ targetExternalId: 'm3', from: 'external' })
    })

    it('skips a deletion that is not between the account and a customer', () => {
      expect(
        messagingToEvents(
          wrap({ ...inbound({ mid: 'm2', is_deleted: true }), recipient: { id: '999' } }),
          OBJECT
        )
      ).toEqual([])
    })
  })

  describe('edits', () => {
    const edit = (body: object, extra: object = {}): object => ({
      sender: { id: CUSTOMER },
      recipient: { id: ACCOUNT },
      timestamp: MS,
      message_edit: body,
      ...extra
    })

    it('maps the edit of a customer with its whole new text', () => {
      const [event] = messagingToEvents(
        wrap(edit({ mid: 'm1', text: 'new text', num_edit: 1 })),
        OBJECT
      )
      expect(event).toEqual({
        type: ChannelEventTypes.MESSAGE_EDITED,
        connectionId: ACCOUNT,
        channelIdentity: CUSTOMER,
        edit: { targetExternalId: 'm1', content: 'new text', eventId: 'm1:1' },
        timestamp: new Date(MS).toISOString()
      })
    })

    it.each([
      ['an edit with no text', edit({ mid: 'm1', num_edit: 1 })],
      ['an edit with blank text', edit({ mid: 'm1', text: '  ' })],
      ['an edit not for the account', edit({ mid: 'm1', text: 'x' }, { recipient: { id: '999' } })]
    ])('skips %s', (_label, item) => {
      expect(messagingToEvents(wrap(item), OBJECT)).toEqual([])
    })
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

    it('reads the ad inside the message when the one beside it is empty', () => {
      const [event] = messagingToEvents(
        wrap(inbound({ mid: 'm1', text: 'hola', referral }, { referral: {} })),
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
