import type { MessageView } from '@platform/api-client'
import { AuthorType, MediaStatus, MessageType } from '@platform/core/domain'

import { groupImageRuns, IMAGE_RUN_WINDOW_MS, isRunImage } from './image-runs'
import type { ThreadItem } from './thread-items'

const AT = Date.UTC(2026, 10, 8, 12, 0, 0)

function picture(id: string, secondsAfter: number, extra: Partial<MessageView> = {}): MessageView {
  return {
    id,
    type: MessageType.IMAGE,
    authorType: AuthorType.CUSTOMER,
    authorId: 'customer-1',
    content: null,
    createdAt: new Date(AT + secondsAfter * 1000).toISOString(),
    media: [{ id: `m-${id}`, contentType: 'image/png', status: MediaStatus.CLEAN }],
    unavailableFiles: [],
    sticker: false,
    orderSummary: null,
    deletedAt: null,
    replyToMessageId: null,
    replyToMediaId: null,
    attachmentUrl: null,
    storyReply: null,
    location: null,
    contacts: null,
    unsupportedType: null,
    system: null,
    ...extra
  } as unknown as MessageView
}

const item = (message: MessageView, showAuthor = true): ThreadItem => ({
  kind: 'message',
  message,
  showAuthor
})
const idsOf = (entry: ReturnType<typeof groupImageRuns>[number]): string[] =>
  entry.kind === 'imageRun'
    ? entry.messages.map(message => message.id)
    : entry.kind === 'message'
      ? [entry.message.id]
      : []

describe('isRunImage', () => {
  it('takes a single clean picture of a customer with nothing else in it', () => {
    expect(isRunImage(picture('a', 0))).toBe(true)
    expect(isRunImage(picture('a', 0, { content: '  ' }))).toBe(true)
  })

  it('leaves out what has words, a quote, a link, a sticker, a deleted one, a team picture and a file not ready', () => {
    expect(isRunImage(picture('a', 0, { content: 'look' }))).toBe(false)
    expect(isRunImage(picture('a', 0, { replyToMessageId: 'x' }))).toBe(false)
    expect(isRunImage(picture('a', 0, { attachmentUrl: 'https://example.com' }))).toBe(false)
    expect(isRunImage(picture('a', 0, { storyReply: { url: null } }))).toBe(false)
    expect(isRunImage(picture('a', 0, { sticker: true }))).toBe(false)
    expect(isRunImage(picture('a', 0, { deletedAt: '2026-11-08T12:00:00Z' }))).toBe(false)
    expect(isRunImage(picture('a', 0, { authorType: AuthorType.AGENT }))).toBe(false)
    expect(isRunImage(picture('a', 0, { media: [] }))).toBe(false)
    expect(
      isRunImage(
        picture('a', 0, {
          media: [{ id: 'm', contentType: 'image/png', status: MediaStatus.INFECTED }]
        } as unknown as Partial<MessageView>)
      )
    ).toBe(false)
    expect(isRunImage(picture('a', 0, { type: MessageType.AUDIO }))).toBe(false)
  })
})

describe('groupImageRuns', () => {
  it('puts two pictures a minute apart in one run, and leaves a lone picture as it was', () => {
    const entries = groupImageRuns([item(picture('a', 0)), item(picture('b', 40))])

    expect(entries.map(idsOf)).toEqual([['a', 'b']])
    expect(entries[0]?.kind).toBe('imageRun')
    expect(groupImageRuns([item(picture('a', 0))])[0]?.kind).toBe('message')
  })

  it('counts the gap from the picture before, so a long burst stays one run, and breaks past the minute', () => {
    const step = IMAGE_RUN_WINDOW_MS / 1000
    const burst = groupImageRuns([
      item(picture('a', 0)),
      item(picture('b', step)),
      item(picture('c', step * 2))
    ])
    expect(burst.map(idsOf)).toEqual([['a', 'b', 'c']])

    const apart = groupImageRuns([item(picture('a', 0)), item(picture('b', step + 1))])
    expect(apart.map(idsOf)).toEqual([['a'], ['b']])
    expect(apart.every(entry => entry.kind === 'message')).toBe(true)
  })

  it('does not cross an author, a day separator or a message of another kind', () => {
    const other = picture('b', 10, { authorId: 'customer-2' })
    expect(groupImageRuns([item(picture('a', 0)), item(other)]).map(idsOf)).toEqual([['a'], ['b']])

    const day: ThreadItem = { kind: 'day', key: '2026-11-09', at: new Date(AT + 20_000) }
    expect(groupImageRuns([item(picture('a', 0)), day, item(picture('b', 30))]).map(idsOf)).toEqual(
      [['a'], [], ['b']]
    )

    const text = picture('t', 10, { type: MessageType.TEXT, content: 'hi', media: [] })
    expect(
      groupImageRuns([item(picture('a', 0)), item(text), item(picture('b', 20))]).map(idsOf)
    ).toEqual([['a'], ['t'], ['b']])
  })

  it('keeps the author label of the first picture and every other entry as it came', () => {
    const entries = groupImageRuns([item(picture('a', 0), true), item(picture('b', 5), false)])
    const [run] = entries
    expect(run?.kind === 'imageRun' && run.showAuthor).toBe(true)

    const system = item(picture('s', 0, { type: MessageType.SYSTEM }))
    expect(groupImageRuns([system])).toEqual([system])
  })

  it('does not join a picture whose date does not read or that is older than the one before it', () => {
    const broken = picture('b', 10, { createdAt: 'not a date' })
    expect(groupImageRuns([item(picture('a', 20)), item(broken)]).map(idsOf)).toEqual([
      ['a'],
      ['b']
    ])
    expect(groupImageRuns([item(picture('a', 20)), item(picture('b', 10))]).map(idsOf)).toEqual([
      ['a'],
      ['b']
    ])
  })
})
