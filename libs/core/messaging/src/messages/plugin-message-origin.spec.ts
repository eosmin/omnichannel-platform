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
    media: [],
    reactions: [
      { emoji: '👍', authorType: AuthorType.AGENT, authorId: MEMBER },
      { emoji: '❤️', authorType: AuthorType.CUSTOMER, authorId: CUSTOMER }
    ]
  }) as unknown as MessageView

describe('pluginMessageViewOf, the files (BAN-R-meta)', () => {
  const withFile = (): MessageView =>
    ({
      ...answer(null),
      media: [{ id: 'f1', filename: 'cedula.pdf', contentType: 'application/pdf', fileSize: 9 }]
    }) as unknown as MessageView

  it('takes the name, the type and the size out of a key without media:read', () => {
    const [file] = pluginMessageViewOf(withFile(), true).media
    expect(file).toMatchObject({ id: 'f1', filename: null, contentType: null, fileSize: null })
  })

  it('keeps them for a key with media:read', () => {
    const [file] = pluginMessageViewOf(withFile(), true, true).media
    expect(file?.filename).toBe('cedula.pdf')
  })
})

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

  // HC-216: a plugin is not told that the quoted message was deleted, nor who wrote it
  it.each([false, true])('gives nothing of a deleted quote, with messages:read %s', reads => {
    const deleted = quote({ deleted: true, content: null, file: null })
    const seen = pluginMessageViewOf(answer(deleted), reads)

    expect(seen.replyTo).toBeNull()
    expect(JSON.stringify(seen.replyTo)).not.toContain(MEMBER)
  })

  it('does not change the answer it was given', () => {
    const message = answer(quote())

    pluginMessageViewOf(message, true)
    pluginMessageViewOf(message, false)

    expect(message.replyTo?.authorId).toBe(MEMBER)
    expect(message.mentions).toEqual([MEMBER])
  })
})
