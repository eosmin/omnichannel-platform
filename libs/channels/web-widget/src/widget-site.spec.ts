import { isAllowedOrigin, isSiteKey, newSiteKey, originOf, siteOriginsSchema } from './widget-site'

describe('site key', () => {
  it('makes keys that are recognized and never repeat', () => {
    const a = newSiteKey()
    expect(isSiteKey(a)).toBe(true)
    expect(a).not.toBe(newSiteKey())
  })

  it('does not recognize anything else', () => {
    for (const value of [undefined, 5, '', 'pk_widget_', 'pk_widget_short', `x${newSiteKey()}`]) {
      expect(isSiteKey(value)).toBe(false)
    }
  })
})

describe('origins', () => {
  it('reduces a site to its origin', () => {
    expect(originOf('https://Shop.test')).toBe('https://shop.test')
    expect(originOf('https://shop.test/')).toBe('https://shop.test')
    expect(originOf('http://localhost:3000')).toBe('http://localhost:3000')
    expect(originOf('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(originOf('https://shop.test:443')).toBe('https://shop.test')
  })

  it('refuses what is not an origin', () => {
    for (const value of [
      'shop.test',
      'ftp://shop.test',
      'javascript:alert(1)',
      'https://shop.test/page',
      'https://shop.test/?a=1',
      'https://user:pass@shop.test',
      'https://shop.test/?',
      'https://shop.test/#',
      'http://shop.test',
      ''
    ]) {
      expect(originOf(value)).toBeNull()
    }
  })

  it('takes a list, once each', () => {
    expect(
      siteOriginsSchema.parse(['https://a.test', 'https://a.test/', 'https://b.test'])
    ).toEqual(['https://a.test', 'https://b.test'])
    expect(siteOriginsSchema.safeParse([]).success).toBe(false)
    expect(siteOriginsSchema.safeParse(['https://a.test', 'nope']).success).toBe(false)
    expect(siteOriginsSchema.safeParse(Array(21).fill('https://a.test')).success).toBe(false)
  })

  it('allows only a listed origin, and never a missing one', () => {
    expect(isAllowedOrigin(['https://a.test'], 'https://a.test')).toBe(true)
    expect(isAllowedOrigin(['https://a.test'], 'https://b.test')).toBe(false)
    expect(isAllowedOrigin(['https://a.test'], undefined)).toBe(false)
    expect(isAllowedOrigin([], 'https://a.test')).toBe(false)
  })
})
