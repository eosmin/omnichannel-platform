import { randomUUID } from 'node:crypto'

import { AuthorType, MessageType } from '@platform/core/domain'

import type { MessageView, QuotedMessage } from './messages.views'
import { pluginMessageViewOf } from './plugin-message-origin'

const MEMBER = randomUUID()
const CUSTOMER = randomUUID()

const quote = (extra: Partial<QuotedMessage> = {}): QuotedMessage => ({
  file: { mediaId: randomUUID(), position: 0 },
  id: randomUUID(),
  type: MessageType.TEXT,
  authorType: AuthorType.AGENT,
  authorId: MEMBER,
  content: 'we will call you',
  deleted: false,
  ...extra
})

const answer = (replyTo: QuotedMessage | null): MessageView =>
  ({
    id: randomUUID(),
    replyToMessageId: replyTo?.id ?? null,
    replyTo,
    mentions: [MEMBER],
    editedById: MEMBER,
    deletedById: MEMBER,
    reactions: [
      { emoji: '👍', authorType: AuthorType.AGENT, authorId: MEMBER },
      { emoji: '❤️', authorType: AuthorType.CUSTOMER, authorId: CUSTOMER }
    ]
  }) as unknown as MessageView

describe('pluginMessageViewOf', () => {
  it('leaves an answer that quotes nothing as it is', () => {
    const message = answer(null)

    expect(pluginMessageViewOf(message, false).replyTo).toBeNull()
    expect(pluginMessageViewOf(message, true).replyTo).toBeNull()
  })

  it.each([false, true])('leaves no id of the team on the view, with messages:read %s', reads => {
    const seen = pluginMessageViewOf(answer(quote()), reads)

    expect(seen.mentions).toEqual([])
    expect(seen.editedById).toBeNull()
    expect(seen.deletedById).toBeNull()
    expect(JSON.stringify(seen)).not.toContain(MEMBER)
  })

  it('gives the reactions of customers to a key that reads messages and none to one that does not', () => {
    expect(pluginMessageViewOf(answer(null), false).reactions).toEqual([])
    expect(pluginMessageViewOf(answer(null), true).reactions).toEqual([
      { emoji: '👍', authorType: AuthorType.AGENT, authorId: null },
      { emoji: '❤️', authorType: AuthorType.CUSTOMER, authorId: CUSTOMER }
    ])
  })

  it('gives the quote as an allowlist: a field added to the quote later does not reach a plugin', () => {
    const seen = pluginMessageViewOf(
      answer({ ...quote(), extra: 'a field of tomorrow' } as unknown as QuotedMessage),
      true
    )

    expect(Object.keys(seen.replyTo ?? {}).sort()).toEqual([
      'authorId',
      'authorType',
      'content',
      'deleted',
      'file',
      'id',
      'type'
    ])
  })

  it('gives only the id of the quoted message to a key that does not read messages', () => {
    const message = answer(quote())

    const seen = pluginMessageViewOf(message, false)

    expect(seen.replyTo).toBeNull()
    expect(seen.replyToMessageId).toBe(message.replyToMessageId)
    expect(JSON.stringify(seen)).not.toContain(MEMBER)
    expect(JSON.stringify(seen)).not.toContain('we will call you')
  })

  it('gives the kind and the text to a key that reads messages, and never the id of the member who wrote it', () => {
    const seen = pluginMessageViewOf(answer(quote()), true)

    expect(seen.replyTo).toMatchObject({
      type: MessageType.TEXT,
      authorType: AuthorType.AGENT,
      authorId: null,
      content: 'we will call you'
    })
  })

  it('never gives the text of an internal note, even to a key that reads messages', () => {
    const seen = pluginMessageViewOf(
      answer(quote({ type: MessageType.INTERNAL_NOTE, content: 'internal: a risk' })),
      true
    )

    expect(seen.replyTo).toMatchObject({
      type: MessageType.INTERNAL_NOTE,
      content: null,
      file: null,
      authorId: null
    })
    expect(JSON.stringify(seen)).not.toContain('internal: a risk')
  })

  it('keeps a deleted quote deleted and without text', () => {
    const seen = pluginMessageViewOf(
      answer(quote({ deleted: true, content: null, file: null })),
      true
    )

    expect(seen.replyTo).toMatchObject({ deleted: true, content: null })
  })

  it('does not change the answer it was given', () => {
    const message = answer(quote())

    pluginMessageViewOf(message, true)
    pluginMessageViewOf(message, false)

    expect(message.replyTo?.authorId).toBe(MEMBER)
    expect(message.mentions).toEqual([MEMBER])
  })
})
