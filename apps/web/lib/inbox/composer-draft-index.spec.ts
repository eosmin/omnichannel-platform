import {
  conversationIdsWithDraft,
  previewOfDraft,
  publishDraft,
  resetDraftIndex,
  subscribeToDrafts
} from './composer-draft-index'
import { DRAFT_MAX_AGE_MS } from './composer-drafts'

describe('previewOfDraft', () => {
  it('keeps one line, trimmed, and the kind', () => {
    expect(previewOfDraft({ text: '  Hello\n  there  ', isNote: false })).toEqual({
      text: 'Hello there',
      isNote: false
    })
    expect(previewOfDraft({ text: 'Call him', isNote: true })).toEqual({
      text: 'Call him',
      isNote: true
    })
  })

  it('is no draft when there are only spaces or line breaks', () => {
    expect(previewOfDraft({ text: ' \n\t ', isNote: false })).toBeNull()
    expect(previewOfDraft({ text: '', isNote: true })).toBeNull()
  })
})

describe('the index of drafts of the list', () => {
  const scope = { userId: 'u1', storeId: 's1', conversationId: 'c1' }
  afterEach(() => resetDraftIndex())

  it('tells its listeners when a draft is typed, changed and sent, and not when nothing changed', () => {
    const heard = jest.fn()
    const stop = subscribeToDrafts(heard)

    publishDraft(scope, { text: 'Hi', isNote: false })
    publishDraft(scope, { text: 'Hi', isNote: false })
    expect(heard).toHaveBeenCalledTimes(1)
    publishDraft(scope, { text: 'Hi there', isNote: false })
    expect(heard).toHaveBeenCalledTimes(2)
    // Sent: the box is empty
    publishDraft(scope, { text: '', isNote: false })
    expect(heard).toHaveBeenCalledTimes(3)
    stop()
    publishDraft(scope, { text: 'Again', isNote: false })
    expect(heard).toHaveBeenCalledTimes(3)
  })

  it('forgets everything when the session ends, and says so once', () => {
    publishDraft(scope, { text: 'Hi', isNote: false })
    const heard = jest.fn()
    const stop = subscribeToDrafts(heard)

    resetDraftIndex()
    resetDraftIndex()
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('the conversations with a draft', () => {
  afterEach(() => resetDraftIndex())

  it('lists, sorted, those of this person in this store that hold text, and follows what is typed and sent', () => {
    publishDraft(
      { userId: 'u1', storeId: 's1', conversationId: 'c2' },
      { text: 'b', isNote: false }
    )
    publishDraft({ userId: 'u1', storeId: 's1', conversationId: 'c1' }, { text: 'a', isNote: true })
    // Another store and another person are not in it, and spaces only is no draft
    publishDraft(
      { userId: 'u1', storeId: 's2', conversationId: 'c3' },
      { text: 'c', isNote: false }
    )
    publishDraft(
      { userId: 'u2', storeId: 's1', conversationId: 'c4' },
      { text: 'd', isNote: false }
    )
    publishDraft(
      { userId: 'u1', storeId: 's1', conversationId: 'c5' },
      { text: '  ', isNote: false }
    )

    expect(conversationIdsWithDraft('u1', 's1')).toEqual(['c1', 'c2'])

    publishDraft({ userId: 'u1', storeId: 's1', conversationId: 'c1' }, { text: '', isNote: true })
    expect(conversationIdsWithDraft('u1', 's1')).toEqual(['c2'])
  })

  it('gives the same array while nothing changed, so that what depends on it does not run again', () => {
    publishDraft(
      { userId: 'u1', storeId: 's1', conversationId: 'c1' },
      { text: 'a', isNote: false }
    )
    const first = conversationIdsWithDraft('u1', 's1')

    expect(conversationIdsWithDraft('u1', 's1')).toBe(first)
    // A change of text keeps the ids, and so the array
    publishDraft(
      { userId: 'u1', storeId: 's1', conversationId: 'c1' },
      { text: 'ab', isNote: false }
    )
    expect(conversationIdsWithDraft('u1', 's1')).toBe(first)
  })

  it('is empty after the session ends', () => {
    publishDraft(
      { userId: 'u1', storeId: 's1', conversationId: 'c1' },
      { text: 'a', isNote: false }
    )
    resetDraftIndex()

    expect(conversationIdsWithDraft('u1', 's1')).toEqual([])
  })

  it('drops a draft that is old enough to be dropped, with no other change to make it look again', () => {
    const real = Date.now()
    const spy = jest.spyOn(Date, 'now').mockReturnValue(real)
    try {
      publishDraft(
        { userId: 'u1', storeId: 's1', conversationId: 'c1' },
        { text: 'a', isNote: false }
      )
      expect(conversationIdsWithDraft('u1', 's1')).toEqual(['c1'])

      spy.mockReturnValue(real + DRAFT_MAX_AGE_MS + 1000)
      expect(conversationIdsWithDraft('u1', 's1')).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
