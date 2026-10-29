import { AppPaths, StoreSettingsSections } from './app-paths'
import { QueryKeys } from './query-keys'

describe('QueryKeys', () => {
  it('scopes store keys by storeId so switching store never serves stale data', () => {
    expect(QueryKeys.conversations.all('s1')).toEqual(['conversations', 's1'])
    expect(QueryKeys.orders.byId('s1', 'o1')).toEqual(['orders', 's1', 'o1'])
    expect(QueryKeys.shipments.byOrder('s1', 'o1')).toEqual(['shipments', 's1', 'order', 'o1'])
  })

  it('scopes warehouse, transfer and count keys by organization', () => {
    expect(QueryKeys.warehouses.all('org1')).toEqual(['warehouses', 'org1'])
    expect(QueryKeys.transfers.all('org1')).toEqual(['transfers', 'org1'])
    expect(QueryKeys.counts.all('org1')).toEqual(['counts', 'org1'])
  })

  it('nests the detail keys under their list key so one invalidation reaches both', () => {
    const [list] = QueryKeys.conversations.all('s1')
    expect(QueryKeys.conversations.byId('s1', 'c1')[0]).toBe(list)
  })

  it('keys the invitation by its token and the organization stores by the store that asks', () => {
    expect(QueryKeys.invitations.byToken('t1')).toEqual(['invitations', 't1'])
    expect(QueryKeys.organizations.stores('s1')).toEqual(['organizations', 's1', 'stores'])
  })

  it('has no billing keys', () => {
    expect(Object.keys(QueryKeys)).not.toContain('billing')
  })
})

describe('AppPaths', () => {
  it('builds store paths under /s/:storeId', () => {
    expect(AppPaths.store.inbox('s1')).toBe('/s/s1/inbox')
    expect(AppPaths.store.conversation('s1', 'c1')).toBe('/s/s1/inbox/c1')
    expect(AppPaths.store.returnsReception('s1')).toBe('/s/s1/returns/receive')
  })

  it('defaults the settings section to general', () => {
    expect(AppPaths.store.settings('s1')).toBe('/s/s1/settings/general')
    expect(AppPaths.store.settings('s1', StoreSettingsSections.CARRIERS)).toBe(
      '/s/s1/settings/carriers'
    )
  })

  it('has the invitation and no-access paths and no onboarding, billing or referral pages', () => {
    expect(AppPaths.invitation('tok')).toBe('/invitations/tok')
    expect(AppPaths.noAccess).toBe('/no-access')
    expect(Object.keys(AppPaths)).not.toContain('onboarding')
    expect(Object.keys(AppPaths.org)).not.toEqual(
      expect.arrayContaining(['billing', 'usage', 'referrals'])
    )
  })
})
