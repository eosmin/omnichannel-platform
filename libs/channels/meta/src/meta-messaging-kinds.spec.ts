import { MessageType, MetaGraph, MetaMessaging } from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { messagingToEvents } from './meta-messaging-events'

const ACCOUNT = '112233445566778'
const CUSTOMER = '1234567890123456'
const OBJECT = 'page'
const MS = 1_761_600_000_000
const STICKER = 'https://scontent.xx.fbcdn.net/v/like.png?sig=1'
const PHOTO = 'https://scontent.xx.fbcdn.net/v/photo.jpg?sig=2'
const LIKE_ID = Number(MetaMessaging.LIKE_STICKER_ID)

const messageOf = (message: object): ReturnType<typeof messagingToEvents>[number]['message'] => {
  const [event] = messagingToEvents(
    {
      object: OBJECT,
      entry: [
        {
          id: ACCOUNT,
          time: MS,
          messaging: [
            { sender: { id: CUSTOMER }, recipient: { id: ACCOUNT }, timestamp: MS, message }
          ]
        }
      ]
    },
    OBJECT
  )
  expect(event?.type).toBe(ChannelEventTypes.MESSAGE_RECEIVED)
  return event?.message
}

describe('the like of Messenger', () => {
  it('is one thumbs up and nothing to fetch, whether it comes as a sticker, an image or both', () => {
    const sticker = { type: 'image', payload: { url: STICKER, sticker_id: LIKE_ID } }
    const image = { type: 'image', payload: { url: STICKER } }
    for (const attachments of [[sticker], [sticker, image], [image, sticker]]) {
      const message = messageOf({ mid: 'm1', attachments })
      expect(message).toMatchObject({ type: MessageType.TEXT, content: MetaMessaging.LIKE_TEXT })
      expect(message?.media).toBeUndefined()
    }
  })

  it('knows the id when Meta sends it as text', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [
        { type: 'sticker', payload: { url: STICKER, sticker_id: MetaMessaging.LIKE_STICKER_ID } }
      ]
    })
    expect(message).toMatchObject({ type: MessageType.TEXT, content: MetaMessaging.LIKE_TEXT })
  })

  it('does not swallow a photo that came with it, or the words beside it', () => {
    const like = { type: 'image', payload: { url: STICKER, sticker_id: LIKE_ID } }
    const photo = { type: 'image', payload: { url: PHOTO } }
    expect(messageOf({ mid: 'm1', attachments: [like, photo] })).toMatchObject({
      type: MessageType.IMAGE,
      media: [{ ref: STICKER }, { ref: PHOTO }]
    })
    expect(messageOf({ mid: 'm2', text: 'gracias', attachments: [like] })).toMatchObject({
      content: 'gracias'
    })
  })

  // MSG-LIKE: the medium and the large like are other stickers of the same thumbs up
  it.each(['369239343222814', '369239383222810'])(
    'is the same thumbs up for the sticker %s',
    id => {
      const sticker = { type: 'image', payload: { url: STICKER, sticker_id: id } }
      const message = messageOf({
        mid: 'm1',
        attachments: [sticker, { type: 'image', payload: { url: STICKER } }]
      })
      expect(message).toMatchObject({ type: MessageType.TEXT, content: MetaMessaging.LIKE_TEXT })
      expect(message?.media).toBeUndefined()
      // The id may come as a number, which does not lose digits at this size
      const byNumber = messageOf({
        mid: 'm2',
        attachments: [{ type: 'image', payload: { url: STICKER, sticker_id: Number(id) } }]
      })
      expect(byNumber).toMatchObject({ type: MessageType.TEXT, content: MetaMessaging.LIKE_TEXT })
      expect(byNumber?.media).toBeUndefined()
      expect(byNumber?.metadata).toBeUndefined()
    }
  )

  it('is not set off by another sticker', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [{ type: 'image', payload: { url: PHOTO, sticker_id: 123 } }]
    })
    expect(message).toMatchObject({ type: MessageType.IMAGE, media: [{ ref: PHOTO }] })
  })

  // MSG-STK: a sticker with an id is marked, so the thread draws it at its own size and not as a photo
  it('marks a sticker that is not a like as a sticker', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [{ type: 'image', payload: { url: PHOTO, sticker_id: 123 } }]
    })
    expect(message?.metadata).toEqual({ sticker: true })
  })

  it('does not read a neighbouring id as a like', () => {
    for (const id of ['369239343222813', '369239383222811', '36923926322282']) {
      const message = messageOf({
        mid: 'm1',
        attachments: [{ type: 'image', payload: { url: STICKER, sticker_id: id } }]
      })
      expect(message).toMatchObject({ type: MessageType.IMAGE, metadata: { sticker: true } })
    }
  })

  it('marks an attachment of the type sticker that has no id', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [{ type: 'sticker', payload: { url: PHOTO } }]
    })
    expect(message).toMatchObject({ type: MessageType.IMAGE, metadata: { sticker: true } })
  })

  it('marks a sticker that comes with its image of the same link', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [
        { type: 'sticker', payload: { url: PHOTO, sticker_id: 7 } },
        { type: 'image', payload: { url: PHOTO } }
      ]
    })
    expect(message?.metadata).toEqual({ sticker: true })
  })

  it('does not mark a photo, nor a photo sent beside a sticker', () => {
    expect(
      messageOf({ mid: 'm1', attachments: [{ type: 'image', payload: { url: PHOTO } }] })?.metadata
    ).toBeUndefined()
    expect(
      messageOf({
        mid: 'm2',
        attachments: [
          { type: 'image', payload: { url: PHOTO } },
          { type: 'image', payload: { url: STICKER, sticker_id: 7 } }
        ]
      })?.metadata
    ).toBeUndefined()
  })
})

describe('a sticker and its image', () => {
  it('are one file when they share the link', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [
        { type: 'sticker', payload: { url: PHOTO, sticker_id: 7 } },
        { type: 'image', payload: { url: PHOTO } }
      ]
    })
    expect(message?.media).toHaveLength(1)
  })

  it('stay two when the links differ', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [
        { type: 'image', payload: { url: PHOTO } },
        { type: 'image', payload: { url: STICKER } }
      ]
    })
    expect(message?.media).toHaveLength(2)
  })
})

describe('the placeholder beside a photo', () => {
  const attachments = [{ type: 'image', payload: { url: PHOTO } }]

  it('is not kept as the text of the photo', () => {
    expect(messageOf({ mid: 'm1', text: '[Adjuntar foto]', attachments })).toMatchObject({
      type: MessageType.IMAGE,
      content: null
    })
  })

  it('is kept when there is no file to explain it', () => {
    expect(messageOf({ mid: 'm1', text: '[Adjuntar foto]' })).toMatchObject({
      type: MessageType.TEXT,
      content: '[Adjuntar foto]'
    })
  })

  it('leaves a customer who wrote words in brackets alone', () => {
    expect(messageOf({ mid: 'm1', text: '[ok]', attachments })).toMatchObject({ content: '[ok]' })
    expect(messageOf({ mid: 'm2', text: 'mira [Adjuntar foto]', attachments })).toMatchObject({
      content: 'mira [Adjuntar foto]'
    })
  })
})

describe('a place', () => {
  const place = (lat: unknown, long: unknown, title?: string): object => ({
    type: 'location',
    ...(title === undefined ? {} : { title }),
    payload: { coordinates: { lat, long } },
    url: 'https://l.facebook.com/l.php?u=x'
  })

  it('is a location with its coordinates and name', () => {
    expect(
      messageOf({ mid: 'm1', attachments: [place(19.4326, -99.1332, "Ana's location")] })
    ).toEqual({
      externalId: 'm1',
      replyToExternalId: undefined,
      timestamp: new Date(MS).toISOString(),
      type: MessageType.LOCATION,
      content: "Ana's location",
      metadata: { latitude: 19.4326, longitude: -99.1332, name: "Ana's location" }
    })
  })

  it('has no name when Meta gives none, and hostile characters are taken out of it', () => {
    expect(messageOf({ mid: 'm1', attachments: [place(1, 2)] })).toMatchObject({
      type: MessageType.LOCATION,
      content: null,
      metadata: { latitude: 1, longitude: 2 }
    })
    const named = messageOf({ mid: 'm2', attachments: [place(1, 2, `a‮b`)] })
    expect(named?.content).toBe('ab')
  })

  it.each([
    [91, 0],
    [0, 181],
    [Number.NaN, 0],
    ['1', '2']
  ])('is not a place with coordinates %p, %p', (lat, long) => {
    const message = messageOf({ mid: 'm1', attachments: [place(lat, long)] })
    expect(message).toMatchObject({ type: MessageType.TEXT, content: '[location]' })
  })

  it('is the marker of its type when Meta says it is not supported', () => {
    expect(
      messageOf({ mid: 'm1', is_unsupported: true, attachments: [place(1, 2)] })
    ).toMatchObject({
      type: MessageType.TEXT,
      content: '[unsupported]',
      metadata: { unsupportedType: 'unsupported' }
    })
  })
})

describe('a place with more in the message', () => {
  const place = { type: 'location', title: 'Casa', payload: { coordinates: { lat: 1, long: 2 } } }

  it('keeps the words of the customer as the content of the place', () => {
    expect(messageOf({ mid: 'm1', text: 'esta es mi casa', attachments: [place] })).toMatchObject({
      type: MessageType.LOCATION,
      content: 'esta es mi casa',
      metadata: { latitude: 1, longitude: 2, name: 'Casa' }
    })
  })

  it('keeps the file, and the words, when a file came with the place', () => {
    expect(
      messageOf({
        mid: 'm1',
        text: 'mira',
        attachments: [{ type: 'image', payload: { url: PHOTO } }, place]
      })
    ).toMatchObject({ type: MessageType.IMAGE, content: 'mira', media: [{ ref: PHOTO }] })
  })
})

describe('a like with something else beside it', () => {
  it('is not a like when another thing was shared with it', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [
        { type: 'image', payload: { url: STICKER, sticker_id: LIKE_ID } },
        { type: 'fallback', title: 'a link' }
      ]
    })
    expect(message?.content).not.toBe(MetaMessaging.LIKE_TEXT)
  })
})

describe('an audio', () => {
  it('is taken to be a clip in an mp4 container until the file says otherwise', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [{ type: 'audio', payload: { url: PHOTO } }]
    })
    expect(message).toMatchObject({
      type: MessageType.AUDIO,
      media: [{ ref: PHOTO, contentType: MetaGraph.AUDIO_HINT_CONTENT_TYPE }]
    })
  })

  it('does not change the hint of other files', () => {
    const message = messageOf({
      mid: 'm1',
      attachments: [{ type: 'video', payload: { url: PHOTO } }]
    })
    expect(message?.media?.[0]?.contentType).toBe(MetaGraph.FALLBACK_CONTENT_TYPE)
  })
})
