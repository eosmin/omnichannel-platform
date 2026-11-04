import { AppPaths } from '@platform/api-client'

import { accountInboxPath, accountRealtimeStoreId } from './account-realtime-store'

const profile = {
  memberships: [{ storeId: 'store-a' }, { storeId: 'store-b' }],
  suspendedStores: [{ storeId: 'store-s', storeName: 'Suspended' }]
}

describe('accountRealtimeStoreId', () => {
  it('opens the socket for the last store when the person belongs to it', () => {
    expect(accountRealtimeStoreId(profile, 'store-b')).toBe('store-b')
  })

  it('opens nothing when no store was remembered', () => {
    expect(accountRealtimeStoreId(profile, null)).toBeNull()
  })

  it('opens nothing for a remembered store the person no longer belongs to', () => {
    expect(accountRealtimeStoreId(profile, 'store-gone')).toBeNull()
  })

  it('opens nothing for a suspended store, which the profile lists apart from the memberships', () => {
    expect(accountRealtimeStoreId(profile, 'store-s')).toBeNull()
  })

  it('opens nothing for a person with no stores', () => {
    expect(accountRealtimeStoreId({ memberships: [] }, 'store-a')).toBeNull()
  })
})

describe('accountInboxPath', () => {
  it('leads to the inbox of the last store the person still belongs to', () => {
    expect(accountInboxPath(profile, 'store-b')).toBe(AppPaths.store.inbox('store-b'))
  })

  it('has no path when there is no store the person can enter', () => {
    expect(accountInboxPath(profile, null)).toBeNull()
    expect(accountInboxPath(profile, 'store-gone')).toBeNull()
    expect(accountInboxPath(profile, 'store-s')).toBeNull()
    expect(accountInboxPath({ memberships: [] }, 'store-a')).toBeNull()
  })
})
