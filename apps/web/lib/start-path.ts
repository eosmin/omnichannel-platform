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
  // The store used last, then the others in order
  const ordered =
    remembered === undefined
      ? memberships
      : [remembered, ...memberships.filter(membership => membership !== remembered)]
  // The reason of a provider login that could not name its store is told where the channels are, in the store the person was in
  // (the reason does not depend on having another screen: the settings tell it)
  const target = ordered[0]
  if (failure !== null && target !== undefined) {
    const channels = AppPaths.store.settings(target.storeId, StoreSettingsSections.CHANNELS)
    return `${channels}?${new URLSearchParams({ oauth_error: failure }).toString()}`
  }
  // The first store where there is a screen the person may open (a role with nothing to open in one store is not sent to a screen
  // that says so while another store has one)
  for (const membership of ordered) {
    const landing = storeLandingPath(membership.storeId, permission =>
      membership.permissions.includes(permission)
    )
    if (landing !== null) return landing
  }
  return AppPaths.noAccess
}

// Where the address of a store (`/s/<id>`) goes: the landing of that store, else the landing of another store of the person (a store with
// nothing to open is not a dead end while another has a screen), else the screen that says there is nothing. Never back to this store.
export function storeRootTarget(
  storeId: string,
  memberships: readonly { storeId: string; permissions: readonly string[] }[]
): string {
  const own = memberships.find(membership => membership.storeId === storeId)
  const landing =
    own === undefined
      ? null
      : storeLandingPath(storeId, permission => own.permissions.includes(permission))
  if (landing !== null) return landing
  return chooseStartPath(
    memberships.filter(membership => membership.storeId !== storeId),
    null
  )
}
