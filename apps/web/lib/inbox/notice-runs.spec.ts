import type { MessageView } from '@platform/api-client'

import { groupImageRuns } from './image-runs'
import { groupNoticeRuns, isRunNotice } from './notice-runs'
import { buildThreadItems } from './thread-items'

const notice = (id: string, over: Partial<MessageView> = {}): MessageView =>
  ({
    id,
    conversationId: 'c1',
    type: 'TEXT',
    content: '[order]',
    authorType: 'customer',
    authorId: 'cust-1',
    replyToMessageId: null,
    reactions: [],
    media: [],
    unavailableFiles: [],
    location: null,
    contacts: null,
    attachmentUrl: null,
    unsupportedType: 'order',
    deletedAt: null,
    createdAt: '2026-11-09T10:00:00.000Z',
    ...over
  }) as unknown as MessageView

const entriesOf = (messages: MessageView[]) =>
  groupNoticeRuns(groupImageRuns(buildThreadItems([messages.toReversed()], 'UTC')))

describe('isRunNotice', () => {
  it('is a plain notice of the customer, with nothing else in it', () => {
    expect(isRunNotice(notice('a'))).toBe(true)
  })

  it.each([
    ['a text', { unsupportedType: null }],
    ['a file that could not be fetched', { unsupportedType: 'image' }],
    ['a message of the team', { authorType: 'agent' }],
    ['a deleted one', { deletedAt: '2026-11-09T11:00:00.000Z' }],
    ['one with a reaction', { reactions: [{ emoji: 'x' }] as never }],
    ['one that quotes another', { replyToMessageId: 'z' }],
    ['one with a link to open', { attachmentUrl: 'https://example.com/p' }],
    ['one with a file', { media: [{ id: 'f' }] as never }],
    ['one with a file that did not arrive', { unavailableFiles: [{ index: 0 }] as never }],
    ['one with a place', { location: { latitude: 1 } as never }],
    ['one with cards', { contacts: [{ name: 'Ana' }] as never }],
    ['a note of the team', { type: 'INTERNAL_NOTE' }]
  ])('is not %s', (_name, over) => {
    expect(isRunNotice(notice('a', over))).toBe(false)
  })
})

describe('groupNoticeRuns', () => {
  it('puts consecutive notices of one customer in one entry, in order', () => {
    const entries = entriesOf([notice('a'), notice('b'), notice('c')])

    const runs = entries.filter(entry => entry.kind === 'noticeRun')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.kind === 'noticeRun' && runs[0].messages.map(m => m.id)).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('leaves a lone notice as the message it is', () => {
    const entries = entriesOf([notice('a')])

    expect(entries.some(entry => entry.kind === 'noticeRun')).toBe(false)
    expect(entries.filter(entry => entry.kind === 'message')).toHaveLength(1)
  })

  it('ends the run at any other message, a day, or another customer', () => {
    const text = notice('t', { unsupportedType: null, content: 'hola' })
    const entries = entriesOf([
      notice('a'),
      notice('b'),
      text,
      notice('c'),
      notice('d', { authorId: 'cust-2' }),
      notice('e', { authorId: 'cust-2', createdAt: '2026-11-10T10:00:00.000Z' })
    ])

    const runs = entries.flatMap(entry => (entry.kind === 'noticeRun' ? [entry] : []))
    expect(runs.map(run => run.messages.map(m => m.id))).toEqual([['a', 'b']])
  })

  it('keeps every message of the thread in its place and shows the author once', () => {
    const entries = entriesOf([notice('a'), notice('b')])
    const run = entries.find(entry => entry.kind === 'noticeRun')

    expect(run?.kind === 'noticeRun' && run.showAuthor).toBe(true)
    expect(entries.map(entry => entry.kind)).toEqual(['day', 'noticeRun'])
  })
})
