import { InboundLimits, MessageType, RemoteChannelApiLimits } from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import {
  remoteChannelEventSchema,
  remoteChannelEventsBodySchema
} from './remote-channel-event.schema'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const at = (offset: number): string => new Date(NOW + offset).toISOString()

const received = (over: object = {}, message: object = {}): object => ({
  type: ChannelEventTypes.MESSAGE_RECEIVED,
  connectionId: 'account-1',
  channelIdentity: 'customer-1',
  message: {
    externalId: 'm-1',
    type: MessageType.TEXT,
    content: 'hello',
    timestamp: at(-MINUTE),
    ...message
  },
  timestamp: at(-MINUTE),
  ...over
})

const image = (ref: string, extra: object = {}): object =>
  received(
    {},
    {
      type: MessageType.IMAGE,
      content: null,
      media: [{ ref, contentType: 'image/png', filename: null, ...extra }]
    }
  )

function paths(value: object): string[] {
  const result = remoteChannelEventSchema.safeParse(value)
  return result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))
}

describe('remoteChannelEventSchema', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('takes the event of a plugin that keeps to the caps', () => {
    expect(paths(received())).toEqual([])
    expect(paths(image('https://cdn.example.com/a.png'))).toEqual([])
  })

  it('refuses an identity, a name and a text over their caps, and takes them at the cap', () => {
    const limits = RemoteChannelApiLimits
    expect(
      paths(received({ channelIdentity: 'x'.repeat(limits.CHANNEL_IDENTITY_MAX_LENGTH) }))
    ).toEqual([])
    expect(
      paths(received({ channelIdentity: 'x'.repeat(limits.CHANNEL_IDENTITY_MAX_LENGTH + 1) }))
    ).toEqual(['channelIdentity'])
    expect(
      paths(
        received({
          channelProfile: { displayName: 'x'.repeat(limits.PROFILE_NAME_MAX_LENGTH + 1) }
        })
      )
    ).toEqual(['channelProfile.displayName'])
    expect(paths(received({}, { content: 'x'.repeat(limits.MESSAGE_CONTENT_MAX_LENGTH) }))).toEqual(
      []
    )
    expect(
      paths(received({}, { content: 'x'.repeat(limits.MESSAGE_CONTENT_MAX_LENGTH + 1) }))
    ).toEqual(['message.content'])
  })

  it('refuses metadata over 4 KB', () => {
    const big = { note: 'x'.repeat(RemoteChannelApiLimits.MESSAGE_METADATA_MAX_BYTES) }
    expect(paths(received({}, { metadata: big }))).toEqual(['message.metadata'])
    expect(paths(received({}, { metadata: { note: 'short' } }))).toEqual([])
  })

  it('judges the timestamps against the clock: 30 days back, 5 minutes ahead', () => {
    expect(paths(received({ timestamp: at(-30 * DAY) }))).toEqual([])
    expect(paths(received({ timestamp: at(-30 * DAY - 1000) }))).toEqual(['timestamp'])
    expect(paths(received({ timestamp: at(5 * MINUTE) }))).toEqual([])
    expect(paths(received({ timestamp: at(5 * MINUTE + 1000) }))).toEqual(['timestamp'])
    expect(paths(received({}, { timestamp: at(6 * MINUTE) }))).toEqual(['message.timestamp'])
    expect(paths(received({}, { timestamp: at(-31 * DAY) }))).toEqual(['message.timestamp'])
  })

  it('takes one file per message', () => {
    const two = received(
      {},
      {
        type: MessageType.IMAGE,
        content: null,
        media: [
          { ref: 'https://cdn.example.com/a.png', contentType: 'image/png', filename: null },
          { ref: 'https://cdn.example.com/b.png', contentType: 'image/png', filename: null }
        ]
      }
    )
    expect(paths(two)).toEqual(['message.media'])
  })

  it.each([
    ['plain http', 'http://cdn.example.com/a.png'],
    ['an address literal on the private network', 'https://10.0.0.5/a.png'],
    ['the loopback', 'https://127.0.0.1/a.png'],
    ['the metadata address', 'https://169.254.169.254/latest'],
    ['a name with no dot', 'https://intranet/a.png'],
    ['a private suffix', 'https://files.internal/a.png'],
    ['credentials', 'https://user:pass@cdn.example.com/a.png'],
    ['another port', 'https://cdn.example.com:8443/a.png'],
    ['a provider id that is not an address', 'media-123']
  ])('refuses a file at %s', (_name, ref) => {
    expect(paths(image(ref))).toEqual(['message.media.0.ref'])
  })

  it('refuses an address over its cap', () => {
    const ref = `https://cdn.example.com/${'a'.repeat(InboundLimits.MEDIA_REF_MAX_LENGTH)}`
    expect(paths(image(ref))).toContain('message.media.0.ref')
  })

  it('does not let a remote plugin name the stored file', () => {
    expect(
      paths(image('https://cdn.example.com/a.png', { id: '0b7a0e6e-0e4c-4a6e-9a3e-2f0c1d7d3a11' }))
    ).toEqual(['message.media.0.id'])
  })

  it.each([
    'http://cdn.example.com/a.png',
    'https://10.0.0.1/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA'
  ])('refuses an avatar at %s', avatarUrl => {
    expect(paths(received({ channelProfile: { avatarUrl } }))).toContain('channelProfile.avatarUrl')
  })

  it('takes a public https avatar', () => {
    expect(
      paths(received({ channelProfile: { avatarUrl: 'https://cdn.example.com/a.png' } }))
    ).toEqual([])
  })

  describe('the origin of a message', () => {
    const withOrigin = (origin: object): object => received({}, { origin })
    it('takes public https addresses and a small referral', () => {
      expect(
        paths(
          withOrigin({
            kind: 'ad',
            sourceUrl: 'https://ads.example.com/1',
            thumbnailUrl: 'https://cdn.example.com/t.jpg',
            media: { type: 'image', url: 'https://cdn.example.com/a.jpg' },
            referral: { a: 1 }
          })
        )
      ).toEqual([])
    })

    it.each([
      ['sourceUrl', { sourceUrl: 'http://ads.example.com/1' }, 'message.origin.sourceUrl'],
      ['thumbnailUrl', { thumbnailUrl: 'https://10.0.0.1/t.jpg' }, 'message.origin.thumbnailUrl'],
      [
        'media url',
        { media: { type: 'image', url: 'https://169.254.169.254/x' } },
        'message.origin.media.url'
      ],
      ['media ref', { media: { type: 'image', ref: 'media-123' } }, 'message.origin.media.ref']
    ])('refuses a %s that is not a public https address', (_name, extra, path) => {
      expect(paths(withOrigin({ kind: 'ad', ...extra }))).toContain(path)
    })

    it('refuses a referral over 4 KB', () => {
      const referral = { note: 'x'.repeat(RemoteChannelApiLimits.MESSAGE_METADATA_MAX_BYTES) }
      expect(paths(withOrigin({ kind: 'ad', referral }))).toEqual(['message.origin.referral'])
    })
  })

  it('refuses an edit whose text is over the cap', () => {
    const edit = {
      type: ChannelEventTypes.MESSAGE_EDITED,
      connectionId: 'account-1',
      channelIdentity: 'customer-1',
      edit: {
        targetExternalId: 'm-1',
        content: 'x'.repeat(RemoteChannelApiLimits.MESSAGE_CONTENT_MAX_LENGTH + 1)
      },
      timestamp: at(0)
    }
    expect(paths(edit)).toEqual(['edit.content'])
  })

  it('keeps the rules of the event of §2', () => {
    // A received event with no message is still refused by the base schema
    expect(paths({ ...received(), message: undefined })).toContain('message')
  })
})

describe('remoteChannelEventsBodySchema', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('takes one to 50 events and nothing else', () => {
    const one = { events: [received()] }
    expect(remoteChannelEventsBodySchema.safeParse(one).success).toBe(true)
    expect(remoteChannelEventsBodySchema.safeParse({ events: [] }).success).toBe(false)
    const fifty = { events: Array.from({ length: 50 }, () => received()) }
    expect(remoteChannelEventsBodySchema.safeParse(fifty).success).toBe(true)
    const fiftyOne = { events: Array.from({ length: 51 }, () => received()) }
    expect(remoteChannelEventsBodySchema.safeParse(fiftyOne).success).toBe(false)
    expect(
      remoteChannelEventsBodySchema.safeParse({ events: [received()], storeId: 'x' }).success
    ).toBe(false)
  })

  it('names the event that failed in the path', () => {
    const result = remoteChannelEventsBodySchema.safeParse({
      events: [received(), received({ timestamp: at(-40 * DAY) })]
    })
    expect(result.success).toBe(false)
    expect(result.success ? [] : result.error.issues.map(issue => issue.path.join('.'))).toEqual([
      'events.1.timestamp'
    ])
  })
})
