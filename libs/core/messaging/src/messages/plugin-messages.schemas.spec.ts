import { randomUUID } from 'node:crypto'

import { AuthorType, MessageType } from '@platform/core/domain'

import { pluginCreateMessageSchema, pluginMessageOf } from './plugin-messages.schemas'

const plugin = { id: 'order-bot', name: 'Order Bot', uploaderId: 'plugin:installation-1' }
const base = () => ({
  type: 'text',
  conversationId: randomUUID(),
  content: 'Your order is on its way',
  idempotencyKey: randomUUID()
})

describe('pluginCreateMessageSchema', () => {
  it('defaults to a system message that is not quiet', () => {
    const parsed = pluginCreateMessageSchema.parse(base())

    expect(parsed).toMatchObject({ authorType: AuthorType.SYSTEM, quiet: false })
  })

  it('needs the key of idempotency for a note too: a plugin retries', () => {
    const note: Record<string, unknown> = { ...base(), type: 'note' }
    delete note.idempotencyKey

    expect(pluginCreateMessageSchema.safeParse(note).success).toBe(false)
  })

  it.each([
    ['an agent without a user', { authorType: AuthorType.AGENT }],
    ['a system message with a user', { userId: randomUUID() }],
    [
      'a nickname on an agent message',
      { authorType: AuthorType.AGENT, userId: randomUUID(), nickname: 'x' }
    ],
    ['a file with no files', { type: 'image', content: undefined }],
    ['a template', { type: 'template' }],
    ['an avatar', { avatar: 'https://evil.example.com/a.png' }],
    ['a mention', { type: 'note', mentions: [randomUUID()] }],
    ['a file type the human route has not', { type: 'sticker', mediaIds: [randomUUID()] }],
    ['a text with files', { mediaIds: [randomUUID()] }],
    ['a file quoted by a note', { type: 'note', replyToMediaId: randomUUID() }],
    ['a quiet that is not a boolean', { quiet: 'yes' }],
    ['an author that is the customer', { authorType: AuthorType.CUSTOMER }]
  ])('refuses %s', (_name, extra) => {
    expect(pluginCreateMessageSchema.safeParse({ ...base(), ...extra }).success).toBe(false)
  })

  it('takes a user in any spelling and keeps it in lower case', () => {
    const userId = randomUUID()

    const parsed = pluginCreateMessageSchema.parse({
      ...base(),
      authorType: AuthorType.AGENT,
      userId: userId.toUpperCase()
    })

    expect(parsed.userId).toBe(userId)
  })
})

describe('pluginMessageOf', () => {
  it('builds a text with the origin of the system and the name of the plugin as the nickname', () => {
    const parsed = pluginCreateMessageSchema.parse(base())

    const { body, origin } = pluginMessageOf(parsed, plugin)

    expect(body).toMatchObject({ type: MessageType.TEXT, content: 'Your order is on its way' })
    expect(origin).toEqual({
      pluginId: 'order-bot',
      uploaderId: 'plugin:installation-1',
      quiet: false,
      author: AuthorType.SYSTEM,
      nickname: 'Order Bot'
    })
  })

  it('cleans the nickname the plugin chose, and uses the name of the plugin when nothing is left', () => {
    const chosen = pluginMessageOf(
      pluginCreateMessageSchema.parse({ ...base(), nickname: ' Bo\u0000t ' }),
      plugin
    )
    const empty = pluginMessageOf(
      pluginCreateMessageSchema.parse({ ...base(), nickname: '\u0000 \n' }),
      plugin
    )

    expect(chosen.origin).toMatchObject({ nickname: 'Bo t' })
    expect(empty.origin).toMatchObject({ nickname: 'Order Bot' })
  })

  it('builds a note with no mentions and the origin of a person for an agent message', () => {
    const userId = randomUUID()
    const parsed = pluginCreateMessageSchema.parse({
      ...base(),
      type: 'note',
      authorType: AuthorType.AGENT,
      userId,
      quiet: true
    })

    const { body, origin } = pluginMessageOf(parsed, plugin)

    expect(body).toMatchObject({ type: MessageType.INTERNAL_NOTE, mentions: [] })
    expect(origin).toEqual({
      pluginId: 'order-bot',
      uploaderId: 'plugin:installation-1',
      quiet: true,
      author: AuthorType.AGENT,
      userId
    })
  })
})

describe('a file or an album of a plugin', () => {
  const file = (extra: Record<string, unknown> = {}) => ({
    type: 'image',
    conversationId: randomUUID(),
    mediaIds: [randomUUID()],
    idempotencyKey: randomUUID(),
    ...extra
  })

  it.each([
    ['image', MessageType.IMAGE],
    ['video', MessageType.VIDEO],
    ['audio', MessageType.AUDIO],
    ['document', MessageType.DOCUMENT]
  ])(
    'takes a %s and gives the service its type, files and the owner of the upload',
    (type, expected) => {
      const parsed = pluginCreateMessageSchema.parse(file({ type, content: 'Here you are' }))

      const { body, origin } = pluginMessageOf(parsed, plugin)

      expect(body).toMatchObject({ type: expected, content: 'Here you are' })
      expect('mediaIds' in body && body.mediaIds).toHaveLength(1)
      expect(origin.uploaderId).toBe('plugin:installation-1')
    }
  )

  it('takes an album with a text under each file and the quote of a file', () => {
    const ids = [randomUUID(), randomUUID()]
    const quoted = randomUUID()
    const parsed = pluginCreateMessageSchema.parse(
      file({
        mediaIds: ids,
        captions: ['one', ''],
        replyToMessageId: randomUUID(),
        replyToMediaId: quoted
      })
    )

    const { body } = pluginMessageOf(parsed, plugin)

    expect(body).toMatchObject({ mediaIds: ids, captions: ['one', null], replyToMediaId: quoted })
  })

  it.each([
    ['no files', { mediaIds: [] }],
    [
      'the same file twice',
      { mediaIds: ['6f1c6e0e-1b8a-4d57-9d54-3c3c8f2a1b11', '6F1C6E0E-1B8A-4D57-9D54-3C3C8F2A1B11'] }
    ],
    ['no key of idempotency', { idempotencyKey: undefined }],
    ['a field of the human route', { mentions: [randomUUID()] }],
    ['a quote that is not an id', { replyToMediaId: 'x' }]
  ])('refuses %s', (_name, extra) => {
    expect(pluginCreateMessageSchema.safeParse(file(extra)).success).toBe(false)
  })

  it('holds a file to the same rules of author as a text', () => {
    expect(
      pluginCreateMessageSchema.safeParse(file({ authorType: AuthorType.AGENT })).success
    ).toBe(false)
    expect(pluginCreateMessageSchema.safeParse(file({ userId: randomUUID() })).success).toBe(false)
  })
})
