import type { AccountMembership } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

export interface TransferAccess {
  // The store the requests go through: the api reads the organization and the permission from it
  storeId: string
  manage: boolean
  receive: boolean
  // The stores where the person makes transfers: the ones whose products they may put in a draft
  makingStores: { id: string; name: string }[]
}

// Which store the transfer pages talk to the api through, from the memberships of the person: where they hold both
// permissions comes first, then where they hold one (the api decides for each request by the store it is sent
// through, so a person who only receives in one store and only makes in another sees what the first one allows).
// Null when they hold neither anywhere.
export function transferAccessOf(memberships: readonly AccountMembership[]): TransferAccess | null {
  const holds = (membership: AccountMembership, permission: string): boolean =>
    membership.permissions.includes(permission)
  const manage = ClientPermissions.INVENTORY_MANAGE_TRANSFERS
  const receive = ClientPermissions.INVENTORY_RECEIVE_TRANSFERS
  const chosen =
    memberships.find(item => holds(item, manage) && holds(item, receive)) ??
    memberships.find(item => holds(item, manage)) ??
    memberships.find(item => holds(item, receive))
  if (chosen === undefined) return null
  return {
    storeId: chosen.storeId,
    manage: holds(chosen, manage),
    receive: holds(chosen, receive),
    makingStores: memberships
      .filter(item => holds(item, manage))
      .map(item => ({ id: item.storeId, name: item.storeName }))
  }
}
