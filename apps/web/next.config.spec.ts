import nextConfig from './next.config'

// Next.js adds `X-Powered-By: Next.js` to dynamic pages unless this is off (QA SEG-1)
describe('the Next.js config', () => {
  it('does not tell which framework serves the pages', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
