import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import { readOAuthReturn } from './settings/oauth-return'

// Where "/" goes (TDD_09 §12): the store the person used last if they still belong to it, else the
// first one, else the screen that says they have no access. Never onboarding: signup is closed.
// A provider login that could not say which store it was for comes back here with a reason
// (`oauth_error`): then the person lands on the channels of that store, where the reason is told. The reason
// is read by the table of the page, so a value that is not one of the list travels as `generic`.
export function chooseStartPath(
  memberships: readonly { storeId: string }[],
  lastStoreId: string | null,
  search = ''
): string {
  const remembered = memberships.find(membership => membership.storeId === lastStoreId)
  const target = remembered ?? memberships[0]
  if (target === undefined) return AppPaths.noAccess
  const { failure } = readOAuthReturn(search)
  if (failure === null) return AppPaths.store.inbox(target.storeId)
  const channels = AppPaths.store.settings(target.storeId, StoreSettingsSections.CHANNELS)
  return `${channels}?${new URLSearchParams({ oauth_error: failure }).toString()}`
}
