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
  // An empty list asks for nothing, which would open the read to every role: it is refused instead
  return read.length > 0 && read.every(permission => can(permission))
}

// Whether a screen has to WAIT for a read: it is on its way (or paused offline). A read that is not made (no permission) is `idle`, and
// stays `isPending` forever because it has no data, so a screen must never wait on `isPending` alone
export function isAwaiting(query: { isPending: boolean; fetchStatus: string }): boolean {
  return query.isPending && query.fetchStatus !== 'idle'
}
