import {
  AuthorType,
  ContactCardLimits,
  MediaStatus,
  MessageLimits,
  MessageMetadataKeys,
  MessageType
} from '@platform/core/domain'

import { messageView } from './messages.views'

const row = (metadata: unknown): Parameters<typeof messageView>[0] => ({
  id: 'm1',
  conversationId: 'c1',
  type: MessageType.TEXT,
  content: 'hola',
  authorType: AuthorType.CUSTOMER,
  authorId: null,
  replyToMessageId: null,
  deliveryStatus: null,
  deliveryError: null,
  failureDefinitive: null,
  mentions: [],
  metadata,
  captionState: null,
  version: 1,
  editedAt: null,
  editedByType: null,
  editedById: null,
  pendingContent: null,
  editStatus: null,
  editError: null,
  deletedAt: null,
  deletedByType: null,
  deletedById: null,
  deleteStatus: null,
  deleteError: null,
  reactions: [],
  media: [],
  createdAt: new Date('2026-10-30T10:00:00Z')
})

describe('messageView attachmentUrl', () => {
  it('carries the link of a shared post as it came', () => {
    const view = messageView(row({ attachmentUrl: 'https://www.instagram.com/p/abc/' }))

    expect(view.attachmentUrl).toBe('https://www.instagram.com/p/abc/')
  })

  it.each([
    ['no metadata', null],
    ['metadata without a link', { attachmentType: 'ig_post' }],
    ['a javascript link', { attachmentUrl: 'javascript:alert(1)' }],
    ['a data link', { attachmentUrl: 'data:text/html,<script>1</script>' }],
    ['a link with credentials', { attachmentUrl: 'https://user:pass@example.com/' }],
    ['a link that is no text', { attachmentUrl: 42 }]
  ])('is null for %s', (_name, metadata) => {
    expect(messageView(row(metadata)).attachmentUrl).toBeNull()
  })

  it('never carries the rest of the metadata of the channel', () => {
    const view = messageView(row({ attachmentUrl: 'https://example.com/a', secret: 'x' }))

    expect(JSON.stringify(view)).not.toContain('secret')
  })
})

describe('messageView media', () => {
  const file = {
    id: 'f1',
    filename: 'a.png',
    contentType: 'image/png',
    fileSize: 10,
    status: MediaStatus.CLEAN,
    position: null,
    deliveryStatus: null,
    sendErrorCode: null,
    caption: null,
    captionState: null
  }
  const shown = {
    id: 'f1',
    filename: 'a.png',
    contentType: 'image/png',
    fileSize: 10,
    status: MediaStatus.CLEAN,
    position: null,
    delivery: null,
    errorCode: null,
    caption: null,
    captionState: null
  }

  it('lists the files of a message without a link or a key', () => {
    const view = messageView({ ...row(null), media: [file] })
    expect(view.media).toEqual([shown])
  })

  it('tells where each file of a reply went and how the channel took it, and nothing of the provider', () => {
    const view = messageView({
      ...row(null),
      media: [
        {
          ...file,
          id: 'f1',
          position: 0,
          deliveryStatus: 'sent',
          channelMessageId: 'wamid.secret'
        },
        {
          ...file,
          id: 'f2',
          position: 1,
          deliveryStatus: 'failed',
          sendErrorCode: 'CHANNEL_MESSAGE_FAILED'
        }
      ] as never
    })
    expect(view.media.map(item => [item.position, item.delivery, item.errorCode])).toEqual([
      [0, 'sent', null],
      [1, 'failed', 'CHANNEL_MESSAGE_FAILED']
    ])
    expect(JSON.stringify(view)).not.toContain('wamid.secret')
  })

  it('carries the text under each file and how it went, as text of the agent and a known state', () => {
    const view = messageView({
      ...row(null),
      media: [
        { ...file, id: 'f1', position: 0, caption: 'first', captionState: 'sent' },
        { ...file, id: 'f2', position: 1, caption: 'second <b>', captionState: 'weird' }
      ] as never
    })
    expect(view.media.map(item => [item.caption, item.captionState])).toEqual([
      ['first', 'sent'],
      ['second <b>', null]
    ])
  })

  it('refuses a delivery state it does not know', () => {
    expect(() =>
      messageView({ ...row(null), media: [{ ...file, deliveryStatus: 'weird' }] })
    ).toThrow()
  })

  it('lists no file for a deleted message', () => {
    const view = messageView({ ...row(null), media: [file], deletedAt: new Date() })
    expect(view.media).toEqual([])
  })

  it('refuses a status it does not know', () => {
    expect(() => messageView({ ...row(null), media: [{ ...file, status: 'weird' }] })).toThrow()
  })
})

describe('messageView unavailableFiles', () => {
  const metadata = { unavailableFiles: [{ index: 1, code: 'refused' }], secret: 'x' }

  it('lists the files the worker could not keep, and nothing else of the metadata', () => {
    const view = messageView(row(metadata))

    expect(view.unavailableFiles).toEqual([{ index: 1, code: 'refused', canRetry: false }])
    expect(JSON.stringify(view)).not.toContain('secret')
  })

  it.each([
    ['no metadata', null],
    ['metadata without the list', { attachmentUrl: 'https://example.com/a' }],
    ['a list that is no list', { unavailableFiles: 'x' }]
  ])('is empty for %s', (_name, value) => {
    expect(messageView(row(value)).unavailableFiles).toEqual([])
  })

  it('draws a code it does not know as the generic one, and keeps the other entries', () => {
    const view = messageView(
      row({
        unavailableFiles: [
          { index: 0, code: 'refused' },
          { index: 1, code: 'weird' }
        ]
      })
    )

    expect(view.unavailableFiles).toEqual([
      { index: 0, code: 'refused', canRetry: false },
      { index: 1, code: 'fetch_failed', canRetry: false }
    ])
  })

  describe('canRetry', () => {
    const source = {
      pluginId: 'whatsapp',
      connectionId: 'conn',
      ref: 'wa-media-id',
      contentType: 'image/jpeg',
      filename: null
    }
    const canRetry = (entry: object): boolean | undefined =>
      messageView(row({ unavailableFiles: [{ index: 0, ...entry }] })).unavailableFiles[0]?.canRetry

    it('is true for a failed fetch whose source was kept', () => {
      expect(canRetry({ code: 'fetch_failed', source })).toBe(true)
    })

    it.each(['refused', 'unsafe_link', 'channel_cannot_fetch'])(
      'is false for %s: the answer would be the same',
      code => {
        expect(canRetry({ code, source })).toBe(false)
      }
    )

    it('is false for a code of a newer worker, though it is drawn as the generic one', () => {
      expect(canRetry({ code: 'quarantined', source })).toBe(false)
    })

    it('is false when no source was kept (a file lost before this existed)', () => {
      expect(canRetry({ code: 'fetch_failed' })).toBe(false)
    })

    it('is false for a source that is a link and not the id of the provider', () => {
      expect(
        canRetry({ code: 'fetch_failed', source: { ...source, ref: 'https://cdn.example.com/a' } })
      ).toBe(false)
    })

    it('never carries the source to the thread', () => {
      const view = messageView(
        row({ unavailableFiles: [{ index: 0, code: 'fetch_failed', source }] })
      )
      expect(JSON.stringify(view)).not.toContain('wa-media-id')
    })
  })

  it('is empty for a deleted message', () => {
    expect(messageView({ ...row(metadata), deletedAt: new Date() }).unavailableFiles).toEqual([])
  })
})

describe('messageView captionState', () => {
  it.each(['failed', 'unconfirmed', 'sent'])('carries %s', captionState => {
    expect(messageView({ ...row(null), captionState }).captionState).toBe(captionState)
  })

  it.each([null, 'weird'])('is null for %j', captionState => {
    expect(messageView({ ...row(null), captionState }).captionState).toBeNull()
  })

  it('is null for a deleted message', () => {
    expect(
      messageView({ ...row(null), captionState: 'failed', deletedAt: new Date() }).captionState
    ).toBeNull()
  })
})

describe('messageView sticker', () => {
  const image = (metadata: unknown, patch: object = {}): ReturnType<typeof messageView> =>
    messageView({ ...row(metadata), type: MessageType.IMAGE, content: null, ...patch })

  it('marks an image the channel said is a sticker', () => {
    expect(image({ [MessageMetadataKeys.STICKER]: true }).sticker).toBe(true)
  })

  it.each([
    ['no metadata', null],
    ['metadata without the mark', { attachmentUrl: 'https://example.com/a' }],
    ['a mark that is not true', { [MessageMetadataKeys.STICKER]: 'yes' }]
  ])('is false for %s', (_name, metadata) => {
    expect(image(metadata).sticker).toBe(false)
  })

  it('is false for a deleted sticker and for any type but an image', () => {
    const metadata = { [MessageMetadataKeys.STICKER]: true }

    expect(image(metadata, { deletedAt: new Date('2026-10-30T11:00:00Z') }).sticker).toBe(false)
    expect(messageView(row(metadata)).sticker).toBe(false)
  })
})

describe('messageView location', () => {
  const located = (metadata: unknown, patch: object = {}): ReturnType<typeof messageView> =>
    messageView({ ...row(metadata), type: MessageType.LOCATION, content: 'Shop', ...patch })

  it('carries the place of a location with its coordinates, name and address', () => {
    const view = located({ latitude: 19.4, longitude: -99.1, name: 'Shop', address: 'Street 1' })

    expect(view.location).toEqual({
      latitude: 19.4,
      longitude: -99.1,
      name: 'Shop',
      address: 'Street 1'
    })
  })

  it('has no name or address when the channel gave none', () => {
    expect(located({ latitude: 0, longitude: 0 }).location).toEqual({
      latitude: 0,
      longitude: 0,
      name: null,
      address: null
    })
  })

  it('cuts a name and an address that are too long, and drops blank ones', () => {
    const view = located({
      latitude: 1,
      longitude: 2,
      name: 'n'.repeat(1000),
      address: '   '
    })

    expect(view.location?.name).toHaveLength(MessageLimits.LOCATION_TEXT_MAX_LENGTH)
    expect(view.location?.address).toBeNull()
  })

  it.each([
    ['no metadata', null],
    ['no coordinates', { name: 'x' }],
    ['a latitude out of range', { latitude: 91, longitude: 0 }],
    ['a longitude out of range', { latitude: 0, longitude: -181 }],
    ['coordinates that are text', { latitude: '19.4', longitude: '-99.1' }],
    ['a null coordinate', { latitude: null, longitude: 1 }]
  ])('is null for %s: the thread draws no card with a made-up place', (_name, metadata) => {
    expect(located(metadata).location).toBeNull()
  })

  it('is null for a deleted location and for any other type', () => {
    const metadata = { latitude: 1, longitude: 2 }

    expect(located(metadata, { deletedAt: new Date('2026-10-30T11:00:00Z') }).location).toBeNull()
    expect(messageView(row(metadata)).location).toBeNull()
  })

  it('takes the characters that reorder or hide text out of the name and the address', () => {
    const view = located({
      latitude: 1,
      longitude: 2,
      name: 'Bank\u202E gnihsihp\u200B',
      address: '\u2066Street\u2069 1'
    })

    expect(view.location?.name).toBe('Bank gnihsihp')
    expect(view.location?.address).toBe('Street 1')
  })

  it('cuts by characters, never through the middle of one', () => {
    const view = located({ latitude: 1, longitude: 2, name: '🏠'.repeat(150) })

    expect(view.location?.name).toBe('🏠'.repeat(MessageLimits.LOCATION_TEXT_MAX_LENGTH / 2))
  })

  it('never carries the rest of the metadata of the channel', () => {
    const view = located({ latitude: 1, longitude: 2, secret: 'x' })

    expect(JSON.stringify(view)).not.toContain('secret')
  })
})

// The text a channel stores for a type it cannot read is `[type]`, the provider's English name for it.
// The thread must not draw that: the view says which type it was and the interface writes the sentence.
describe('messageView unsupportedShape', () => {
  it('never lets the names a worker logs reach the thread', () => {
    const view = messageView({
      ...row({
        [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'share',
        [MessageMetadataKeys.UNSUPPORTED_SHAPE]: {
          messageFields: ['mid'],
          attachments: [{ type: 'share', fields: ['type'], payloadFields: ['url'] }]
        }
      }),
      content: '[share]'
    })
    expect(JSON.stringify(view)).not.toContain('payloadFields')
    expect(JSON.stringify(view)).not.toContain(MessageMetadataKeys.UNSUPPORTED_SHAPE)
  })
})

describe('messageView unsupportedType', () => {
  const marker = (type: string, metadata: unknown, content = `[${type}]`) =>
    messageView({ ...row(metadata), content })

  it.each([
    [
      'Instagram or Messenger',
      'story_mention',
      { [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'story_mention' }
    ],
    ['WhatsApp', 'unsupported', { [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'unsupported' }]
  ])('names the type of a marker from %s', (_channel, type, metadata) => {
    expect(marker(type, metadata).unsupportedType).toBe(type)
  })

  it.each([
    [
      'a text that only looks like a marker',
      { [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'image' },
      '[location]'
    ],
    ['no metadata', null, '[image]'],
    [
      'a marker with more text',
      { [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'image' },
      '[image] hola'
    ],
    [
      'a type that is not a plain name',
      { [MessageMetadataKeys.UNSUPPORTED_TYPE]: '<b>x</b>' },
      '[<b>x</b>]'
    ],
    [
      'a customer who typed it with a link only',
      { attachmentUrl: 'https://example.com/a' },
      '[image]'
    ]
  ])('is null for %s', (_name, metadata, content) => {
    expect(messageView({ ...row(metadata), content }).unsupportedType).toBeNull()
  })

  it('is null for a deleted message and for any type but a text', () => {
    const metadata = { [MessageMetadataKeys.UNSUPPORTED_TYPE]: 'image' }
    expect(
      messageView({
        ...row(metadata),
        content: '[image]',
        deletedAt: new Date('2026-10-30T11:00:00Z')
      }).unsupportedType
    ).toBeNull()
    expect(
      messageView({ ...row(metadata), content: '[image]', type: MessageType.IMAGE }).unsupportedType
    ).toBeNull()
  })
})

describe('messageView edited and then deleted (W3a)', () => {
  const edited = {
    editedAt: new Date('2026-10-30T10:05:00Z'),
    editedByType: AuthorType.CUSTOMER,
    editedById: 'u1',
    pendingContent: 'hola otra vez',
    editStatus: 'failed',
    editError: 'CHANNEL_MESSAGE_FAILED',
    version: 2
  }

  it('says it was edited while it was only edited', () => {
    const view = messageView({ ...row(null), ...edited })
    expect(view.editedAt).toEqual(edited.editedAt)
    expect(view.content).toBe('hola')
  })

  it('lets the deletion win: no "edited", no editor, no content, no edit waiting', () => {
    const view = messageView({
      ...row(null),
      ...edited,
      deletedAt: new Date('2026-10-30T10:10:00Z')
    })
    expect(view.editedAt).toBeNull()
    expect(view.editedByType).toBeNull()
    expect(view.editedById).toBeNull()
    expect(view.pendingEdit).toBe(false)
    expect(view.editStatus).toBeNull()
    expect(view.editError).toBeNull()
    expect(view.content).toBeNull()
    // What says it was deleted, and by whom, stays
    expect(view.deletedAt).toEqual(new Date('2026-10-30T10:10:00Z'))
    expect(view.version).toBe(2)
  })
})

describe('messageView location from Messenger and Instagram', () => {
  it('lists the place with the metadata the Meta plugin stores, the same as one from WhatsApp', () => {
    const view = messageView({
      ...row({ latitude: 13.6929, longitude: -89.2182, name: 'Ana location' }),
      type: 'LOCATION'
    })
    expect(view.location).toEqual({
      latitude: 13.6929,
      longitude: -89.2182,
      name: 'Ana location',
      address: null
    })
  })
})

describe('messageView contacts', () => {
  const cards = {
    contacts: [
      {
        name: 'Ana',
        phones: [{ number: '+52 55 1234 5678', kind: 'CELL' }],
        emails: [{ address: 'ana@example.com' }]
      }
    ]
  }
  const of = (type: string, metadata: unknown, over: object = {}) =>
    messageView({ ...row(metadata), type, ...over })

  it('lists the cards of a CONTACTS message, and only them', () => {
    const view = of('CONTACTS', { ...cards, secret: 'x' })
    expect(view.contacts).toEqual(cards.contacts)
    expect(JSON.stringify(view)).not.toContain('secret')
  })

  it('has none for another type, a deleted message, or metadata that does not hold', () => {
    expect(of('TEXT', cards).contacts).toBeNull()
    expect(of('CONTACTS', cards, { deletedAt: new Date() }).contacts).toBeNull()
    for (const metadata of [
      null,
      {},
      { contacts: 'x' },
      { contacts: [{ name: 1 }] },
      { contacts: [] }
    ]) {
      expect(of('CONTACTS', metadata).contacts).toBeNull()
    }
  })

  it('bounds and cleans what a column anyone could have written holds', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      name: `C${index}\u0000\n`,
      phones: Array.from({ length: 20 }, () => ({ number: '5'.repeat(500) })),
      emails: Array.from({ length: 20 }, () => ({ address: 'e'.repeat(500) }))
    }))
    const view = of('CONTACTS', { contacts: many })
    expect(view.contacts).toHaveLength(ContactCardLimits.MAX_CONTACTS)
    const [first] = view.contacts ?? []
    expect(first?.name).toBe('C0')
    expect(first?.phones).toHaveLength(ContactCardLimits.MAX_PHONES)
    expect(first?.phones[0]?.number).toHaveLength(ContactCardLimits.PHONE_MAX_LENGTH)
    expect(first?.emails).toHaveLength(ContactCardLimits.MAX_EMAILS)
    expect(first?.emails[0]?.address).toHaveLength(ContactCardLimits.EMAIL_MAX_LENGTH)
  })

  it('names a card by its first phone or email when its name is empty, and drops one with nothing', () => {
    const view = of('CONTACTS', {
      contacts: [
        { name: '\u200F', phones: [{ number: '555' }], emails: [] },
        { name: '', phones: [], emails: [{ address: 'x@example.com' }] },
        { name: '', phones: [{ number: '\u0000' }], emails: [] }
      ]
    })
    expect(view.contacts?.map(card => card.name)).toEqual(['555', 'x@example.com'])
  })
})
