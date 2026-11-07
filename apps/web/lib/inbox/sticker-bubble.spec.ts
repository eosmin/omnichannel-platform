import { MediaStatus } from '@platform/core/domain'

import { drawsWithoutBubble } from './sticker-bubble'

const file = { status: MediaStatus.CLEAN, contentType: 'image/webp' }
const sticker = {
  sticker: true,
  content: null,
  replyToMessageId: null,
  attachmentUrl: null,
  unsupportedType: null,
  media: [file],
  unavailableFiles: []
}

describe('drawsWithoutBubble', () => {
  it('draws a sticker alone', () => {
    expect(drawsWithoutBubble(sticker, 'media')).toBe(true)
    expect(drawsWithoutBubble({ ...sticker, content: '' }, 'media')).toBe(true)
  })

  it('draws a sticker still being checked alone too: its skeleton has the box of the sticker', () => {
    expect(
      drawsWithoutBubble({ ...sticker, media: [{ ...file, status: MediaStatus.PENDING }] }, 'media')
    ).toBe(true)
  })

  it('draws a sticker whose file is not stored yet alone, so its box does not change when it arrives', () => {
    const pending = { ...sticker, media: [] }
    expect(drawsWithoutBubble(pending, 'media', true)).toBe(true)
    // Not awaiting: no file and no word to explain it keeps the bubble, as before
    expect(drawsWithoutBubble(pending, 'media')).toBe(false)
    // Awaiting does not widen anything else: words, a quote and a note still need their bubble
    expect(drawsWithoutBubble({ ...pending, content: 'look' }, 'media', true)).toBe(false)
    expect(drawsWithoutBubble({ ...pending, replyToMessageId: 'm0' }, 'media', true)).toBe(false)
    expect(drawsWithoutBubble(pending, 'note', true)).toBe(false)
    expect(drawsWithoutBubble({ ...pending, sticker: false }, 'media', true)).toBe(false)
  })

  it('keeps the bubble of anything that is not a plain sticker', () => {
    expect(drawsWithoutBubble({ ...sticker, sticker: false }, 'media')).toBe(false)
    expect(drawsWithoutBubble({ ...sticker, content: 'look' }, 'media')).toBe(false)
    expect(drawsWithoutBubble({ ...sticker, replyToMessageId: 'm0' }, 'media')).toBe(false)
    expect(
      drawsWithoutBubble({ ...sticker, attachmentUrl: 'https://example.com/a' }, 'media')
    ).toBe(false)
    expect(drawsWithoutBubble({ ...sticker, media: [] }, 'media')).toBe(false)
  })

  it('keeps the bubble when the message is a note or was deleted', () => {
    expect(drawsWithoutBubble(sticker, 'note')).toBe(false)
    expect(drawsWithoutBubble(sticker, 'deleted')).toBe(false)
  })

  it('keeps the bubble when a file ended in a state that says words', () => {
    for (const status of [MediaStatus.INFECTED, MediaStatus.UNSCANNABLE]) {
      expect(drawsWithoutBubble({ ...sticker, media: [{ ...file, status }] }, 'media')).toBe(false)
    }
    expect(
      drawsWithoutBubble(
        { ...sticker, unavailableFiles: [{ index: 0, code: 'refused', canRetry: false }] },
        'media'
      )
    ).toBe(false)
  })

  it('keeps the bubble when any of several files ended in a state that says words', () => {
    const infected = { ...file, status: MediaStatus.INFECTED }
    expect(drawsWithoutBubble({ ...sticker, media: [file, infected] }, 'media')).toBe(false)
    expect(drawsWithoutBubble({ ...sticker, media: [infected, file] }, 'media')).toBe(false)
  })

  it('keeps the bubble when the file is not a picture: the box of a sticker is a picture’s', () => {
    expect(
      drawsWithoutBubble(
        { ...sticker, media: [{ ...file, contentType: 'application/octet-stream' }] },
        'media'
      )
    ).toBe(false)
    expect(
      drawsWithoutBubble({ ...sticker, media: [{ ...file, contentType: 'audio/ogg' }] }, 'media')
    ).toBe(false)
  })
})
