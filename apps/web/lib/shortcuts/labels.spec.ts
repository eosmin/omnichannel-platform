import { Shortcuts } from '@platform/core/domain'

import { bindingKeys } from './labels'

describe('bindingKeys', () => {
  it('writes a single key as it is', () => {
    expect(bindingKeys(Shortcuts.list.NEXT_CONVERSATION, true)).toEqual([['j']])
  })

  it('splits a combination into its keys and names Mod after the platform', () => {
    expect(bindingKeys(Shortcuts.global.SEND_MESSAGE, true)).toEqual([['⌘', 'Enter']])
    expect(bindingKeys(Shortcuts.global.SEND_MESSAGE, false)).toEqual([['Ctrl', 'Enter']])
    expect(bindingKeys(Shortcuts.conversation.INTERNAL_NOTE, false)).toEqual([['Shift', 'N']])
  })

  it('gives each step of a sequence its own list', () => {
    expect(bindingKeys(Shortcuts.global.GO_TO_INBOX, false)).toEqual([['g'], ['i']])
  })

  it('shortens Escape and draws the arrows', () => {
    expect(bindingKeys(Shortcuts.conversation.CLOSE, false)).toEqual([['Esc']])
    expect(bindingKeys('ArrowDown', false)).toEqual([['↓']])
  })
})
