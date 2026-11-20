import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import { readOAuthReturn } from './settings/oauth-return'
import { storeLandingPath } from './store-landing'

// Where "/" goes (TDD_09 §12): the store the person used last if they still belong to it, else the
// first one, else the screen that says they have no access. Never onboarding: signup is closed.
// A provider login that could not say which store it was for comes back here with a reason
// (`oauth_error`): then the person lands on the channels of that store, where the reason is told. The reason
// is read by the table of the page, so a value that is not one of the list travels as `generic`.
export function chooseStartPath(
  memberships: readonly { storeId: string; permissions: readonly string[] }[],
  lastStoreId: string | null,
  search = ''
): string {
  const remembered = memberships.find(membership => membership.storeId === lastStoreId)
  const { failure } = readOAuthReturn(search)
  // The store the person used last, then the others in order: the first where there is a screen they may open (a role with nothing to
  // open in one store is not sent to a screen that says so while another store has one)
  const candidates = remembered === undefined ? memberships : [remembered, ...memberships]
  for (const membership of candidates) {
    const landing = storeLandingPath(membership.storeId, permission =>
      membership.permissions.includes(permission)
    )
    if (landing === null) continue
    if (failure === null) return landing
    const channels = AppPaths.store.settings(membership.storeId, StoreSettingsSections.CHANNELS)
    return `${channels}?${new URLSearchParams({ oauth_error: failure }).toString()}`
  }
  return AppPaths.noAccess
}
