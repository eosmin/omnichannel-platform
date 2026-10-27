import { conversationCursorSchema, encodeConversationCursor } from './conversation-cursor'

const ID = '4f9a1c52-8c3b-4f0e-9d57-1b2f6c3a7e10'

describe('the cursor of the conversations list', () => {
  it('survives a round trip, with a date and without one', () => {
    const date = new Date('2026-10-26T12:00:00.000Z')

    const withDate = conversationCursorSchema.parse(
      encodeConversationCursor({ lastMessageAt: date, id: ID })
    )
    const withoutDate = conversationCursorSchema.parse(
      encodeConversationCursor({ lastMessageAt: null, id: ID })
    )

    expect(withDate).toEqual({ lastMessageAt: date, id: ID })
    expect(withoutDate).toEqual({ lastMessageAt: null, id: ID })
  })

  it.each([
    ['text that is not base64 json', '%%%'],
    ['json of another shape', Buffer.from('{"a":1}').toString('base64url')],
    [
      'a date that is not a date',
      Buffer.from(JSON.stringify(['yesterday', ID])).toString('base64url')
    ],
    [
      'a tuple with a third element',
      Buffer.from(JSON.stringify([null, ID, 1])).toString('base64url')
    ],
    ['a tuple with one element', Buffer.from(JSON.stringify([ID])).toString('base64url')],
    ['a date with no time', Buffer.from(JSON.stringify(['2026-10-26', ID])).toString('base64url')],
    ['a date as a number', Buffer.from(JSON.stringify([1793000000000, ID])).toString('base64url')],
    ['an id that is not a uuid', Buffer.from(JSON.stringify([null, 'nope'])).toString('base64url')]
  ])('refuses %s', (_label, text) => {
    expect(conversationCursorSchema.safeParse(text).success).toBe(false)
  })

  // A well-formed cursor, padded with spaces inside the JSON to the length asked for, so that only
  // the cap can refuse it
  const padded = (length: number): string => {
    for (let spaces = 0; spaces < length; spaces += 1) {
      const text = Buffer.from(`[null,${' '.repeat(spaces)}"${ID}"]`).toString('base64url')
      if (text.length === length) return text
    }
    throw new Error(`no cursor of ${length} characters`)
  }

  it('takes a well-formed cursor of 256 characters and refuses the next size up', () => {
    expect(conversationCursorSchema.safeParse(padded(256)).success).toBe(true)
    expect(conversationCursorSchema.safeParse(padded(258)).success).toBe(false)
  })
})
