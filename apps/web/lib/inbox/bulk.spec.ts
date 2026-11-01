import { BulkActions, ConversationStatus } from '@platform/core/domain'

import {
  singleResultKey,
  BulkConfirmations,
  BulkOutcomes,
  confirmationOf,
  type PreviousState,
  summaryOf,
  targetCountOf,
  undoStepsOf
} from './bulk'

const state = (id: string, patch: Partial<PreviousState> = {}): PreviousState => ({
  id,
  status: ConversationStatus.OPEN,
  assignedTo: null,
  unreadCount: 0,
  tags: [],
  ...patch
})

describe('confirmationOf', () => {
  it('acts at once on a few reversible conversations', () => {
    expect(confirmationOf({ action: BulkActions.MARK_READ }, 9)).toBe(BulkConfirmations.NONE)
  })

  it('asks with a dialog from ten, and when the number is not known', () => {
    expect(confirmationOf({ action: BulkActions.MARK_READ }, 10)).toBe(BulkConfirmations.DIALOG)
    expect(confirmationOf({ action: BulkActions.MARK_READ }, null)).toBe(BulkConfirmations.DIALOG)
  })

  it('never asks before a file for the exports center, however many conversations', () => {
    expect(confirmationOf({ action: BulkActions.EXPORT_CSV }, 400)).toBe(BulkConfirmations.NONE)
    expect(confirmationOf({ action: BulkActions.EXPORT_CSV }, null)).toBe(BulkConfirmations.NONE)
  })

  it('asks for the phrase to archive, however few', () => {
    expect(confirmationOf({ action: BulkActions.ARCHIVE }, 1)).toBe(BulkConfirmations.TYPED)
  })
})

describe('undoStepsOf', () => {
  it('gives each conversation back to who held it, in one step per holder', () => {
    const steps = undoStepsOf(
      { action: BulkActions.ASSIGN_TO_ME },
      [
        state('a'),
        state('b', { assignedTo: 'ana' }),
        state('c', { assignedTo: 'ana' }),
        state('d', { assignedTo: 'luis' })
      ],
      ['a', 'b', 'c']
    )

    expect(steps).toEqual([
      { operation: { action: BulkActions.UNASSIGN }, conversationIds: ['a'] },
      {
        operation: { action: BulkActions.ASSIGN_TO_AGENT, params: { userId: 'ana' } },
        conversationIds: ['b', 'c']
      }
    ])
  })

  it('puts each status back, and leaves the ones that cannot be set again', () => {
    const steps = undoStepsOf(
      { action: BulkActions.SET_STATUS, params: { status: ConversationStatus.RESOLVED } },
      [
        state('a'),
        state('b', { status: ConversationStatus.PENDING }),
        state('c', { status: ConversationStatus.SNOOZED })
      ],
      ['a', 'b', 'c']
    )

    expect(steps).toEqual([
      {
        operation: { action: BulkActions.SET_STATUS, params: { status: ConversationStatus.OPEN } },
        conversationIds: ['a']
      },
      {
        operation: {
          action: BulkActions.SET_STATUS,
          params: { status: ConversationStatus.PENDING }
        },
        conversationIds: ['b']
      }
    ])
  })

  it('takes a tag off only where the action put it', () => {
    const tag = { id: 't1', name: 'VIP', color: '#fff' }
    const steps = undoStepsOf(
      { action: BulkActions.ADD_TAG, params: { tagId: 't1' } },
      [state('a'), state('b', { tags: [tag] })],
      ['a', 'b']
    )

    expect(steps).toEqual([
      {
        operation: { action: BulkActions.REMOVE_TAG, params: { tagId: 't1' } },
        conversationIds: ['a']
      }
    ])
  })

  it('puts a tag back only where the action took it off', () => {
    const tag = { id: 't1', name: 'VIP', color: '#fff' }
    const steps = undoStepsOf(
      { action: BulkActions.REMOVE_TAG, params: { tagId: 't1' } },
      [state('a'), state('b', { tags: [tag] })],
      ['a', 'b']
    )

    expect(steps).toEqual([
      {
        operation: { action: BulkActions.ADD_TAG, params: { tagId: 't1' } },
        conversationIds: ['b']
      }
    ])
  })

  it('marks unread again only what was unread, and read again only what was read', () => {
    const read = undoStepsOf(
      { action: BulkActions.MARK_READ },
      [state('a', { unreadCount: 3 }), state('b')],
      ['a', 'b']
    )
    const unread = undoStepsOf(
      { action: BulkActions.MARK_UNREAD },
      [state('a', { unreadCount: 3 }), state('b')],
      ['a', 'b']
    )

    expect(read).toEqual([
      { operation: { action: BulkActions.MARK_UNREAD }, conversationIds: ['a'] }
    ])
    expect(unread).toEqual([
      { operation: { action: BulkActions.MARK_READ }, conversationIds: ['b'] }
    ])
  })

  it('ignores a conversation that did not go through, and cannot take back an archive', () => {
    expect(
      undoStepsOf({ action: BulkActions.UNASSIGN }, [state('a', { assignedTo: 'ana' })], [])
    ).toEqual([])
    expect(undoStepsOf({ action: BulkActions.ARCHIVE }, [state('a')], ['a'])).toEqual([])
  })
})

describe('summaryOf', () => {
  it('says all done when nothing failed', () => {
    expect(summaryOf({ succeeded: ['a'], failed: [], truncated: false })).toMatchObject({
      outcome: BulkOutcomes.ALL_DONE,
      succeeded: 1,
      failed: 0
    })
  })

  it('counts the reasons, the most frequent first', () => {
    const summary = summaryOf({
      succeeded: ['a'],
      failed: [
        { id: 'b', code: 'FORBIDDEN' },
        { id: 'c', code: 'CONFLICT' },
        { id: 'd', code: 'CONFLICT' }
      ],
      truncated: true
    })

    expect(summary.outcome).toBe(BulkOutcomes.SOME_DONE)
    expect(summary.reasons).toEqual([
      { code: 'CONFLICT', count: 2 },
      { code: 'FORBIDDEN', count: 1 }
    ])
    expect(summary.truncated).toBe(true)
  })

  it('says none done when every conversation failed', () => {
    expect(
      summaryOf({ succeeded: [], failed: [{ id: 'a', code: 'FORBIDDEN' }], truncated: false })
        .outcome
    ).toBe(BulkOutcomes.NONE_DONE)
  })
})

describe('targetCountOf', () => {
  it('counts the ids and does not know what a filter reaches', () => {
    expect(targetCountOf({ conversationIds: ['a', 'b'] })).toBe(2)
    expect(targetCountOf({ filter: { tagId: 't' } })).toBeNull()
  })
})

describe('singleResultKey', () => {
  it('names what each kind of action did', () => {
    expect(singleResultKey({ action: BulkActions.ASSIGN_TO_ME })).toBe('assignedToYou')
    expect(
      singleResultKey({
        action: BulkActions.SET_STATUS,
        params: { status: ConversationStatus.RESOLVED }
      })
    ).toBe('resolved')
    expect(
      singleResultKey({
        action: BulkActions.SET_STATUS,
        params: { status: ConversationStatus.PENDING }
      })
    ).toBe('pending')
    expect(singleResultKey({ action: BulkActions.ADD_TAG, params: { tagId: 't' } })).toBe(
      'tagAdded'
    )
    expect(singleResultKey({ action: BulkActions.ARCHIVE })).toBe('archived')
  })
})
