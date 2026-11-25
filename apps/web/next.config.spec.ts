import nextConfig from './next.config'

// Next.js adds `X-Powered-By: Next.js` to dynamic pages unless this is off (QA SEG-1)
describe('the Next.js config', () => {
  it('sends no Referer and keeps nothing in a cache for the page of the one-click unsubscribe', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const rule = rules.find(candidate => candidate.source === '/unsubscribe')
    expect(rule?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' }
      ])
    )
    // It comes AFTER the rule for every page, which it overrides key by key
    expect(rules.indexOf(rule as (typeof rules)[number])).toBeGreaterThan(0)
  })

  it('sends no Referer and keeps nothing in a cache for the public form of data requests (the key of the store is in the fragment)', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const rule = rules.find(candidate => candidate.source === '/compliance/dsr/request')
    expect(rule?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' }
      ])
    )
    expect(rules.indexOf(rule as (typeof rules)[number])).toBeGreaterThan(0)
  })

  it('sends no Referer and keeps nothing in a cache for the page that confirms a data request (its token is in the fragment)', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const rule = rules.find(candidate => candidate.source === '/compliance/dsr/verify')
    expect(rule?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' }
      ])
    )
    expect(rules.indexOf(rule as (typeof rules)[number])).toBeGreaterThan(0)
  })

  it('sends no Referer and keeps nothing in a cache for the page that hands over a data export (its token is in the fragment)', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const rule = rules.find(candidate => candidate.source === '/compliance/dsr/export')
    expect(rule?.headers).toEqual(
      expect.arrayContaining([
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' }
      ])
    )
    expect(rules.indexOf(rule as (typeof rules)[number])).toBeGreaterThan(0)
  })

  it('does not tell which framework serves the pages', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
