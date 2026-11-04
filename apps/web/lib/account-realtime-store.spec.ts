import { accountRealtimeStoreId } from './account-realtime-store'

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
