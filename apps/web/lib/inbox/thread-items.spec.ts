import type { MessageView } from '@platform/api-client'

import { buildThreadItems, deliveryTicksOf, memberIdsOf, messageKindOf } from './thread-items'

const message = (over: Partial<MessageView>): MessageView => ({
  id: 'm1',
  conversationId: 'c1',
  type: 'TEXT',
  content: 'hola',
  authorType: 'customer',
  authorId: null,
  replyToMessageId: null,
  replyTo: null,
  deliveryStatus: null,
  deliveryError: null,
  system: null,
  attachmentUrl: null,
  reactions: [],
  media: [],
  unavailableFiles: [],
  captionFailed: false,
  mentions: [],
  version: 1,
  editedAt: null,
  editedByType: null,
  editedById: null,
  pendingEdit: false,
  editStatus: null,
  editError: null,
  deletedAt: null,
  deletedByType: null,
  deletedById: null,
  deleteStatus: null,
  deleteError: null,
  createdAt: '2026-10-30T10:00:00.000Z',
  ...over
})

describe('messageKindOf', () => {
  it.each([
    [{ type: 'TEXT' }, 'message'],
    [{ type: 'TEMPLATE' }, 'message'],
    [{ type: 'IMAGE' }, 'media'],
    [{ type: 'INTERNAL_NOTE' }, 'note'],
    [{ type: 'LOCATION' }, 'neutral'],
    [{ type: 'ORDER_SUMMARY' }, 'neutral'],
    [{ type: 'SOMETHING_NEW' }, 'neutral'],
    [{ type: 'TEXT', deletedAt: '2026-10-30T11:00:00.000Z' }, 'deleted']
  ])('draws %j as %s', (over, kind) => {
    expect(messageKindOf(message(over))).toBe(kind)
  })

  it('draws a system message that has no metadata as a neutral line, not as a bubble', () => {
    expect(messageKindOf(message({ type: 'SYSTEM', system: null }))).toBe('neutral')
  })
})

describe('deliveryTicksOf', () => {
  it('shows the ticks of a reply only', () => {
    expect(deliveryTicksOf(message({ authorType: 'agent', deliveryStatus: 'read' }))).toBe('read')
    expect(deliveryTicksOf(message({ authorType: 'customer', deliveryStatus: 'read' }))).toBeNull()
    expect(deliveryTicksOf(message({ authorType: 'agent', deliveryStatus: 'weird' }))).toBeNull()
    expect(deliveryTicksOf(message({ authorType: 'agent', deliveryStatus: null }))).toBeNull()
  })
})

describe('buildThreadItems', () => {
  it('draws the oldest first, with a divider at each day, from pages that come newest first', () => {
    const items = buildThreadItems(
      [
        [
          message({ id: 'm3', createdAt: '2026-10-31T10:00:00.000Z' }),
          message({ id: 'm2', createdAt: '2026-10-30T10:05:00.000Z' })
        ],
        [message({ id: 'm1', createdAt: '2026-10-30T10:00:00.000Z' })]
      ],
      'UTC'
    )

    expect(items.map(item => (item.kind === 'day' ? item.key : item.message.id))).toEqual([
      '2026-10-30',
      'm1',
      'm2',
      '2026-10-31',
      'm3'
    ])
  })

  it('keeps a message that two pages repeat once', () => {
    const repeated = message({ id: 'm1' })
    const items = buildThreadItems([[repeated], [repeated]], 'UTC')

    expect(items.filter(item => item.kind === 'message')).toHaveLength(1)
  })

  it('names the author once for a block of messages close together', () => {
    const items = buildThreadItems(
      [
        [
          message({
            id: 'm3',
            authorId: 'a2',
            authorType: 'agent',
            createdAt: '2026-10-30T10:03:00.000Z'
          }),
          message({
            id: 'm2',
            authorId: 'a1',
            authorType: 'agent',
            createdAt: '2026-10-30T10:02:00.000Z'
          }),
          message({
            id: 'm1',
            authorId: 'a1',
            authorType: 'agent',
            createdAt: '2026-10-30T10:01:00.000Z'
          })
        ]
      ],
      'UTC'
    )

    const shown = items.flatMap(item => (item.kind === 'message' ? [item.showAuthor] : []))
    expect(shown).toEqual([true, false, true])
  })

  it('starts a block after a pause, after a note and after a system line', () => {
    const items = buildThreadItems(
      [
        [
          message({ id: 'm4', createdAt: '2026-10-30T10:40:00.000Z' }),
          message({ id: 'm3', type: 'INTERNAL_NOTE', createdAt: '2026-10-30T10:02:00.000Z' }),
          message({ id: 'm2', createdAt: '2026-10-30T10:01:00.000Z' }),
          message({ id: 'm1', createdAt: '2026-10-30T10:00:00.000Z' })
        ]
      ],
      'UTC'
    )

    const shown = items.flatMap(item => (item.kind === 'message' ? [item.showAuthor] : []))
    expect(shown).toEqual([true, false, true, true])
  })
})

describe('memberIdsOf', () => {
  it('names the agents the thread mentions, once each, and not the customer', () => {
    const items = buildThreadItems(
      [
        [
          message({ id: 'm4', type: 'TEXT', authorType: 'customer', authorId: 'customer-1' }),
          message({
            id: 'm3',
            deletedAt: '2026-10-30T11:00:00.000Z',
            deletedByType: 'agent',
            deletedById: 'a2'
          }),
          message({
            id: 'm2',
            type: 'SYSTEM',
            authorType: 'system',
            system: {
              event: 'assigned',
              actor: { type: 'user', id: 'a1' },
              causedBy: null,
              from: null,
              to: null,
              reason: null,
              snoozedUntil: null,
              assignedTo: 'a3',
              previousAssignee: null
            }
          }),
          message({ id: 'm1', authorType: 'agent', authorId: 'a1' })
        ]
      ],
      'UTC'
    )

    expect(memberIdsOf(items).sort()).toEqual(['a1', 'a2', 'a3'])
  })
})
