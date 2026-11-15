import { randomUUID } from 'node:crypto'

import { AuthorType, MessageType } from '@platform/core/domain'

import { pluginCreateMessageSchema, pluginMessageOf } from './plugin-messages.schemas'

const plugin = { id: 'order-bot', name: 'Order Bot' }
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
    ['a file type', { type: 'image' }],
    ['a template', { type: 'template' }],
    ['an avatar', { avatar: 'https://evil.example.com/a.png' }],
    ['a mention', { type: 'note', mentions: [randomUUID()] }],
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
    expect(origin).toEqual({ pluginId: 'order-bot', quiet: true, author: AuthorType.AGENT, userId })
  })
})
