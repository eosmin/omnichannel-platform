import { refreshCookie, refreshCookieName } from './refresh-cookie'

describe('refreshCookie', () => {
  it('takes the __Host- prefix only where the cookie is Secure', () => {
    expect(refreshCookieName(true)).toBe('__Host-platform_refresh')
    expect(refreshCookieName(false)).toBe('platform_refresh')
  })

  it('is httpOnly, Lax and for the whole site, with no Domain', () => {
    const expires = new Date('2026-11-28T10:00:00.000Z')
    expect(refreshCookie('t', expires, true)).toEqual({
      name: '__Host-platform_refresh',
      value: 't',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires
    })
  })
})
