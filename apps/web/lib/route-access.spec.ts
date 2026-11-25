import { accessFor, RouteAccess } from './route-access'

describe('accessFor', () => {
  it('sends a visitor with no session to the login page', () => {
    expect(accessFor('/', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/s/abc/inbox', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/org/stores', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/no-access', false)).toBe(RouteAccess.TO_LOGIN)
  })

  it('lets a visitor with no session reach the login, the link, the invitations and the handlers', () => {
    expect(accessFor('/login', false)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/login/verify', false)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/invitations/tok', false)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/auth/refresh', false)).toBe(RouteAccess.ALLOW)
  })

  it('lets a visitor with no session open the page that confirms a data request, and no page under it', () => {
    expect(accessFor('/compliance/dsr/verify', false)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/compliance/dsr/verify', true)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/compliance/dsr/verify/other', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/compliance/dsr', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/compliance', false)).toBe(RouteAccess.TO_LOGIN)
  })

  it('lets a visitor with no session open the page that hands over a data export, and no page under it', () => {
    expect(accessFor('/compliance/dsr/export', false)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/compliance/dsr/export', true)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/compliance/dsr/export/other', false)).toBe(RouteAccess.TO_LOGIN)
  })

  it('lets a visitor with no session open the public form of data requests, and no page under it', () => {
    expect(accessFor('/compliance/dsr/request', false)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/compliance/dsr/request', true)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/compliance/dsr/request/other', false)).toBe(RouteAccess.TO_LOGIN)
  })

  it('lets a visitor with no session open the page of the one-click unsubscribe, and no page under it', () => {
    expect(accessFor('/unsubscribe', false)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/unsubscribe', true)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/unsubscribe/other', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/unsubscribed', false)).toBe(RouteAccess.TO_LOGIN)
  })

  it('does not treat a look-alike path as public', () => {
    expect(accessFor('/login-admin', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/authors', false)).toBe(RouteAccess.TO_LOGIN)
    expect(accessFor('/invitations', false)).toBe(RouteAccess.TO_LOGIN)
  })

  it('sends a person with a session away from the login page only', () => {
    expect(accessFor('/login', true)).toBe(RouteAccess.TO_START)
    expect(accessFor('/login/verify', true)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/s/abc/inbox', true)).toBe(RouteAccess.ALLOW)
    expect(accessFor('/invitations/tok', true)).toBe(RouteAccess.ALLOW)
  })
})
