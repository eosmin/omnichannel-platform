import { randomUUID } from 'node:crypto'

import { MessageType } from '@platform/core/domain'
import { MediaMessageLimits } from '@platform/core/storage'

import { createMessageSchema } from './messages.schemas'

const media = (over: Record<string, unknown> = {}) => ({
  type: MessageType.IMAGE,
  conversationId: randomUUID(),
  mediaIds: [randomUUID()],
  idempotencyKey: randomUUID(),
  ...over
})

describe('createMessageSchema, a message with a file', () => {
  it.each([MessageType.IMAGE, MessageType.VIDEO, MessageType.AUDIO, MessageType.DOCUMENT])(
    'takes %s with one file and no caption',
    type => {
      expect(createMessageSchema.safeParse(media({ type })).success).toBe(true)
    }
  )

  it('takes several files in order (the channel and the switch decide how many go, later)', () => {
    const ids = Array.from({ length: MediaMessageLimits.MAX_FILES }, () => randomUUID())
    const parsed = createMessageSchema.safeParse(media({ mediaIds: ids }))
    expect(parsed.success && 'mediaIds' in parsed.data ? parsed.data.mediaIds : null).toEqual(ids)
  })

  it('takes a caption, trimmed, and a reply', () => {
    const parsed = createMessageSchema.safeParse(
      media({ content: '  hello  ', replyToMessageId: randomUUID() })
    )
    expect(parsed.success && 'content' in parsed.data ? parsed.data.content : null).toBe('hello')
  })

  it('takes a blank caption as none', () => {
    const parsed = createMessageSchema.safeParse(media({ content: '   ' }))
    expect(parsed.success && 'content' in parsed.data ? parsed.data.content : 'x').toBeUndefined()
  })

  it('writes the id of the file in lower case', () => {
    const id = randomUUID()
    const parsed = createMessageSchema.safeParse(media({ mediaIds: [id.toUpperCase()] }))
    expect(parsed.success && 'mediaIds' in parsed.data ? parsed.data.mediaIds : null).toEqual([id])
  })

  it.each([
    ['no file', { mediaIds: [] }],
    ['no list of files', { mediaIds: undefined }],
    ['no file', { mediaIds: [] }],
    [
      'more files than any request may carry',
      { mediaIds: Array.from({ length: MediaMessageLimits.MAX_FILES + 1 }, () => randomUUID()) }
    ],
    [
      'the same file twice',
      (() => {
        const id = randomUUID()
        return { mediaIds: [id, id] }
      })()
    ],
    ['no key', { idempotencyKey: undefined }],
    ['a field it does not know', { mentions: [] }]
  ])('refuses %s', (_name, over) => {
    expect(createMessageSchema.safeParse(media(over)).success).toBe(false)
  })

  it('refuses mediaIds on a text', () => {
    expect(
      createMessageSchema.safeParse(media({ type: MessageType.TEXT, content: 'hi' })).success
    ).toBe(false)
  })
})
