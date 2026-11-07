import type { AvailableShortcuts } from '@platform/core/domain'

export type ShortcutGroup = keyof typeof AvailableShortcuts

// The groups of the table, in the order the sheet draws them
const ALL_GROUPS: readonly ShortcutGroup[] = ['list', 'conversation', 'global']

// The groups the `?` sheet shows for the screen the person is on: the ones that work there and the global
// ones. With no conversation open the keys of a conversation do nothing; on a phone with one open the list
// is hidden, so its keys do nothing either. From `md` the list and the conversation are on screen together.
export function shortcutGroupsFor({
  isConversationOpen,
  isListVisible
}: {
  isConversationOpen: boolean
  isListVisible: boolean
}): readonly ShortcutGroup[] {
  return ALL_GROUPS.filter(group => {
    if (group === 'global') return true
    if (group === 'conversation') return isConversationOpen
    return !isConversationOpen || isListVisible
  })
}
