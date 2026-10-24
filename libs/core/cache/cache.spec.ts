import { CacheKeys, CacheTTL } from './cache-keys'

describe('CacheKeys', () => {
  it('puts the storeId in every tenant key', () => {
    const keys = [
      CacheKeys.store.settings('s1'),
      CacheKeys.store.agents('s1'),
      CacheKeys.conversation.byId('s1', 'c1'),
      CacheKeys.conversation.counts('s1'),
      CacheKeys.customer.profile('s1', 'u1'),
      CacheKeys.customer.byIdentity('s1', 'whatsapp', '+50370000000'),
      CacheKeys.agent.convCount('s1', 'a1'),
      CacheKeys.product.byId('s1', 'p1'),
      CacheKeys.product.search('s1', 'abc'),
      CacheKeys.product.inventory('s1', 'p1'),
      CacheKeys.plugin.installation('s1', 'pl1'),
      CacheKeys.presence.store('s1')
    ]
    for (const key of keys) {
      expect(key).toContain('s1')
    }
  })

  it('builds the bulk invalidation patterns from the same prefix', () => {
    expect(CacheKeys.patterns.storeAll('s1')).toBe('store:s1:*')
    expect(CacheKeys.store.settings('s1').startsWith('store:s1:')).toBe(true)
    expect(
      CacheKeys.product
        .search('s1', 'h')
        .startsWith(CacheKeys.patterns.productSearchAll('s1').slice(0, -1))
    ).toBe(true)
  })

  it('has no billing, AI or platform groups', () => {
    expect(Object.keys(CacheKeys)).not.toEqual(expect.arrayContaining(['billing']))
    expect(Object.keys(CacheKeys)).not.toEqual(expect.arrayContaining(['ai']))
    expect(Object.keys(CacheKeys)).not.toEqual(expect.arrayContaining(['platform']))
  })

  it('orders the TTLs from shortest to longest', () => {
    const ttls = Object.values(CacheTTL)
    expect([...ttls].sort((a, b) => a - b)).toEqual(ttls)
  })
})
