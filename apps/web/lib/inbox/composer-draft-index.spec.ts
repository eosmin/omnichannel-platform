import {
  previewOfDraft,
  publishDraft,
  resetDraftIndex,
  subscribeToDrafts
} from './composer-draft-index'

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
