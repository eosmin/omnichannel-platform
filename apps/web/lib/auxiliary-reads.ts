import { type Permission, ClientPermissions } from '@platform/core/auth'

// The reads a screen makes BESIDE its own (the names of the people and channels, the tags, the preferences of the store) are made only
// by a person who may read them: each is what the permission of its route asks for (`GET /members/directory`, `/channels/directory`,
// `/settings/tags` and the counts need `conversations:view`; `GET /settings/preferences` needs `settings:view`). Without it the screen
// still loads, but the console fills with 403s and the screen waits for an answer that never comes (QA VERIF-31 and VERIF-cd).
export const AuxiliaryReads = {
  INBOX_DIRECTORY: [ClientPermissions.CONVERSATIONS_VIEW],
  STORE_PREFERENCES: [ClientPermissions.SETTINGS_VIEW]
} as const

export function mayRead(
  can: (permission: Permission) => boolean,
  read: readonly Permission[]
): boolean {
  return read.every(permission => can(permission))
}
