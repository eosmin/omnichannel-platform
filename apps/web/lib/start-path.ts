import { AppPaths } from '@platform/api-client'

// Where "/" goes (TDD_09 §12): the store the person used last if they still belong to it, else the
// first one, else the screen that says they have no access. Never onboarding: signup is closed.
export function chooseStartPath(
  memberships: readonly { storeId: string }[],
  lastStoreId: string | null
): string {
  const remembered = memberships.find(membership => membership.storeId === lastStoreId)
  const target = remembered ?? memberships[0]
  return target === undefined ? AppPaths.noAccess : AppPaths.store.inbox(target.storeId)
}
