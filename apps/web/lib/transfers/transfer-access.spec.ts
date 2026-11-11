import type { AccountMembership } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { transferAccessOf } from './transfer-access'

const membership = (storeId: string, permissions: string[]): AccountMembership => ({
  storeId,
  storeName: `Store ${storeId}`,
  role: 'Role',
  permissions
})

const MANAGE = ClientPermissions.INVENTORY_MANAGE_TRANSFERS
const RECEIVE = ClientPermissions.INVENTORY_RECEIVE_TRANSFERS

describe('transferAccessOf', () => {
  it('is null where the person holds neither permission', () => {
    expect(transferAccessOf([membership('a', [ClientPermissions.INVENTORY_VIEW])])).toBeNull()
    expect(transferAccessOf([])).toBeNull()
  })

  it('prefers the store where the person makes and receives', () => {
    const access = transferAccessOf([
      membership('a', [RECEIVE]),
      membership('b', [MANAGE]),
      membership('c', [MANAGE, RECEIVE])
    ])
    expect(access).toMatchObject({ storeId: 'c', manage: true, receive: true })
  })

  it('then the store where they make, then the one where they only receive', () => {
    expect(transferAccessOf([membership('a', [RECEIVE]), membership('b', [MANAGE])])).toMatchObject(
      {
        storeId: 'b',
        manage: true,
        receive: false
      }
    )
    expect(transferAccessOf([membership('a', [RECEIVE])])).toMatchObject({
      storeId: 'a',
      manage: false,
      receive: true
    })
  })

  it('lists every store where they make transfers, for the item picker', () => {
    const access = transferAccessOf([
      membership('a', [MANAGE]),
      membership('b', [RECEIVE]),
      membership('c', [MANAGE])
    ])
    expect(access?.makingStores).toEqual([
      { id: 'a', name: 'Store a' },
      { id: 'c', name: 'Store c' }
    ])
  })
})
