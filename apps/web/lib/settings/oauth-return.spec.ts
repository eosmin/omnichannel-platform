import { ChannelConnectFailureReasons } from '@platform/core/errors'

import {
  isOAuthDialogUrl,
  missingPermissionsOf,
  readOAuthReturn,
  withoutOAuthParams
} from './oauth-return'

const SESSION = 'A'.repeat(43)

describe('readOAuthReturn', () => {
  it('reads the id of a session, and nothing else, from what the api sent', () => {
    expect(readOAuthReturn(`?oauth=${SESSION}`)).toEqual({ session: SESSION, failure: null })
  })

  it('reads a reason of the closed list', () => {
    for (const reason of [
      ChannelConnectFailureReasons.OAUTH_CANCELLED,
      ChannelConnectFailureReasons.OAUTH_EXPIRED,
      ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE,
      ChannelConnectFailureReasons.PROVIDER_BUSY,
      ChannelConnectFailureReasons.REQUEST_REJECTED,
      ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
    ]) {
      expect(readOAuthReturn(`?oauth_error=${reason}`)).toEqual({ session: null, failure: reason })
    }
  })

  it('never paints a value it does not know: it is the generic one', () => {
    for (const value of [
      'whatever',
      '<script>alert(1)</script>',
      'token_malformed',
      '',
      'a'.repeat(500)
    ]) {
      expect(readOAuthReturn(`?oauth_error=${encodeURIComponent(value)}`)).toEqual({
        session: null,
        failure: 'generic'
      })
    }
  })

  it('refuses a session id that is not the shape of one', () => {
    for (const value of [
      'short',
      'A'.repeat(44),
      `${'A'.repeat(42)}!`,
      '',
      `${SESSION}${SESSION}`
    ]) {
      expect(readOAuthReturn(`?oauth=${encodeURIComponent(value)}`).session).toBeNull()
    }
  })

  it('reads a repeated parameter as nothing, and says the return could not be read', () => {
    expect(readOAuthReturn(`?oauth=${SESSION}&oauth=${SESSION}`)).toEqual({
      session: null,
      failure: 'generic'
    })
    expect(readOAuthReturn('?oauth_error=oauth_expired&oauth_error=oauth_cancelled').failure).toBe(
      'generic'
    )
  })

  it('is empty for an address with neither', () => {
    expect(readOAuthReturn('')).toEqual({ session: null, failure: null })
    expect(readOAuthReturn('?page=2')).toEqual({ session: null, failure: null })
  })

  it('keeps the failure and drops the session when both come', () => {
    expect(readOAuthReturn(`?oauth=${SESSION}&oauth_error=oauth_expired`)).toEqual({
      session: null,
      failure: ChannelConnectFailureReasons.OAUTH_EXPIRED
    })
  })
})

describe('withoutOAuthParams', () => {
  it('removes the session and the reason, and keeps the rest of the address', () => {
    expect(withoutOAuthParams('/s/1/settings/channels', `?oauth=${SESSION}&tab=x`, '#top')).toBe(
      '/s/1/settings/channels?tab=x#top'
    )
    expect(withoutOAuthParams('/s/1/settings/channels', '?oauth_error=oauth_expired', '')).toBe(
      '/s/1/settings/channels'
    )
  })

  it('leaves an address with neither as it was', () => {
    expect(withoutOAuthParams('/x', '?a=1', '')).toBe('/x?a=1')
  })

  it('removes a repeated parameter every time', () => {
    expect(withoutOAuthParams('/x', `?oauth=${SESSION}&oauth=${SESSION}`, '')).toBe('/x')
  })
})

const ORIGIN = 'https://www.facebook.com'

describe('isOAuthDialogUrl', () => {
  it('accepts the dialog of Facebook, over https', () => {
    expect(
      isOAuthDialogUrl('https://www.facebook.com/v23.0/dialog/oauth?client_id=1&state=s', ORIGIN)
    ).toBe(true)
  })

  it('follows the origin the plugin declares, not a fixed one', () => {
    expect(
      isOAuthDialogUrl('https://login.acme.test/dialog?state=s', 'https://login.acme.test')
    ).toBe(true)
    expect(isOAuthDialogUrl('https://www.facebook.com/dialog', 'https://login.acme.test')).toBe(
      false
    )
  })

  it('refuses everything when there is no declared origin', () => {
    expect(isOAuthDialogUrl('https://www.facebook.com/dialog', null)).toBe(false)
  })

  it.each([
    'http://www.facebook.com/v23.0/dialog/oauth',
    'https://facebook.com/v23.0/dialog/oauth',
    'https://www.facebook.com.evil.example/dialog/oauth',
    'https://evil.example/https://www.facebook.com/',
    'https://www.facebook.com@evil.example/dialog/oauth',
    'https://user:pw@www.facebook.com/dialog/oauth',
    'https://user@www.facebook.com/dialog/oauth',
    'https://:pw@www.facebook.com/dialog/oauth',
    'https://www.facebook.com:8443/dialog/oauth',
    'javascript:alert(1)',
    'data:text/html,x',
    '//www.facebook.com/dialog/oauth',
    '/dialog/oauth',
    'not an address',
    ''
  ])('refuses %j', value => {
    expect(isOAuthDialogUrl(value, ORIGIN)).toBe(false)
  })
})

describe('missingPermissionsOf', () => {
  it('reads the names the api listed', () => {
    expect(
      missingPermissionsOf({ missingPermissions: ['pages_messaging', 'instagram_basic'] })
    ).toEqual(['pages_messaging', 'instagram_basic'])
  })

  it('drops what is not a permission name, so nothing but a name is ever painted', () => {
    expect(
      missingPermissionsOf({
        missingPermissions: ['pages_messaging', '<b>x</b>', 3, null, 'A_B', '']
      })
    ).toEqual(['pages_messaging'])
  })

  it('lists each name once', () => {
    expect(
      missingPermissionsOf({
        missingPermissions: ['pages_messaging', 'pages_messaging', 'instagram_basic']
      })
    ).toEqual(['pages_messaging', 'instagram_basic'])
  })

  it('is empty for anything that is not a list, and holds a few at most', () => {
    expect(missingPermissionsOf({})).toEqual([])
    expect(missingPermissionsOf({ missingPermissions: 'pages_messaging' })).toEqual([])
    const many = Array.from(
      { length: 50 },
      (_v, index) => `permission_${'a'.repeat(index % 5)}${index}`
    )
    expect(missingPermissionsOf({ missingPermissions: many }).length).toBeLessThanOrEqual(20)
  })
})
