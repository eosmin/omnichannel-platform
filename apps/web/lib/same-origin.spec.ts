import { isSameOrigin } from './same-origin'

describe('isSameOrigin', () => {
  it('accepts the origin whose host is the host of the request', () => {
    expect(isSameOrigin('https://app.example.com', 'app.example.com')).toBe(true)
    expect(isSameOrigin('http://localhost:3000', 'localhost:3000')).toBe(true)
  })

  it('refuses another host, a look-alike and a different port', () => {
    expect(isSameOrigin('https://evil.example.com', 'app.example.com')).toBe(false)
    expect(isSameOrigin('https://app.example.com.evil.io', 'app.example.com')).toBe(false)
    expect(isSameOrigin('http://localhost:4000', 'localhost:3000')).toBe(false)
  })

  it('compares with the host the proxy was asked for when it rewrote Host', () => {
    expect(isSameOrigin('https://app.example.com', 'web.internal:3000', 'app.example.com')).toBe(
      true
    )
    expect(isSameOrigin('https://web.internal:3000', 'web.internal:3000', 'app.example.com')).toBe(
      false
    )
  })

  it('refuses a missing or malformed header', () => {
    expect(isSameOrigin(null, 'app.example.com')).toBe(false)
    expect(isSameOrigin('https://app.example.com', null)).toBe(false)
    expect(isSameOrigin('not a url', 'app.example.com')).toBe(false)
    expect(isSameOrigin('null', 'app.example.com')).toBe(false)
  })
})
