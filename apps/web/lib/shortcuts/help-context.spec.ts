import { shortcutGroupsFor } from './help-context'

describe('shortcutGroupsFor', () => {
  it('shows the list and the global keys when no conversation is open', () => {
    expect(shortcutGroupsFor({ isConversationOpen: false, isListVisible: true })).toEqual([
      'list',
      'global'
    ])
    // A phone shows the list when none is open, but the flag cannot hide it then
    expect(shortcutGroupsFor({ isConversationOpen: false, isListVisible: false })).toEqual([
      'list',
      'global'
    ])
  })

  it('shows all three groups when the list and the conversation are on screen together', () => {
    expect(shortcutGroupsFor({ isConversationOpen: true, isListVisible: true })).toEqual([
      'list',
      'conversation',
      'global'
    ])
  })

  it('leaves the list out on a phone with a conversation open: the list is hidden', () => {
    expect(shortcutGroupsFor({ isConversationOpen: true, isListVisible: false })).toEqual([
      'conversation',
      'global'
    ])
  })
})
