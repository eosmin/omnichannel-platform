import type { MessageView } from '@platform/api-client'
import { AuthorType } from '@platform/core/domain'

// What the thread says of a plugin that wrote, edited or deleted a message. The plugin is told by its id (the name it has
// in the registry), never by a channel: the name drawn for it comes from the directory when the plugin is a channel, else
// it is the id. Its nickname is the text of a plugin, drawn escaped by React and never as markup.
export interface PluginAuthorship {
  pluginId: string
  // The name the plugin chose to write as; null when the message is written on behalf of a person
  nickname: string | null
  // A plugin that writes as the system answers with no person behind it
  automatic: boolean
}

export function pluginAuthorshipOf(
  message: Pick<MessageView, 'authorPluginId' | 'authorNickname' | 'authorType'>
): PluginAuthorship | null {
  const pluginId = message.authorPluginId ?? null
  if (pluginId === null || pluginId === '') return null
  const nickname = message.authorNickname?.trim() ?? ''
  return {
    pluginId,
    nickname: nickname === '' ? null : nickname,
    automatic: message.authorType === String(AuthorType.SYSTEM)
  }
}

// A plugin that wrote AS a person (`authorType: agent`): the person stays the author and the thread says the plugin wrote it for them.
// A plugin that wrote as itself has its nickname and is `automatic`.
export const isOnBehalfOfPerson = (authorship: PluginAuthorship): boolean =>
  !authorship.automatic && authorship.nickname === null

// The plugin that last edited the message, or the one that deleted it; null when a person or the channel did
export function editorPluginOf(message: Pick<MessageView, 'editedByPluginId'>): string | null {
  const id = message.editedByPluginId ?? null
  return id === null || id === '' ? null : id
}

export function deleterPluginOf(message: Pick<MessageView, 'deletedByPluginId'>): string | null {
  const id = message.deletedByPluginId ?? null
  return id === null || id === '' ? null : id
}

// Two messages of the same plugin and nickname are one block; another plugin, or a person, starts one. Without a plugin
// the nickname says nothing.
export const sameAuthorship = (
  a: Pick<MessageView, 'authorPluginId' | 'authorNickname'>,
  b: Pick<MessageView, 'authorPluginId' | 'authorNickname'>
): boolean => {
  const plugin = a.authorPluginId ?? null
  if (plugin !== (b.authorPluginId ?? null)) return false
  // The nickname is a plugin's: no other author is told apart by it
  return plugin === null || (a.authorNickname ?? null) === (b.authorNickname ?? null)
}
