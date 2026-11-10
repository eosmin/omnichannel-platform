import { parseMetaEnv } from '@platform/channels/meta'

import { oauthCallbackUrlOf } from './oauth-callback'

describe('the callback address of the login of this platform', () => {
  it('is the public origin of the api, its prefix and the callback route', () => {
    expect(oauthCallbackUrlOf('https://api.example.com')).toBe(
      'https://api.example.com/api/v1/channels/oauth/callback'
    )
  })

  it('keeps a port and takes only the origin: a path, a query or a login in API_URL are not part of it', () => {
    expect(oauthCallbackUrlOf('http://localhost:4000/anything?x=1#y')).toBe(
      'http://localhost:4000/api/v1/channels/oauth/callback'
    )
    expect(oauthCallbackUrlOf('https://user:secret@api.example.com/')).toBe(
      'https://api.example.com/api/v1/channels/oauth/callback'
    )
  })

  it.each([undefined, '', 'not an address', 'ftp://api.example.com', 'javascript:alert(1)'])(
    'is nothing for %p, so no login can be held to it',
    value => {
      expect(oauthCallbackUrlOf(value)).toBeUndefined()
    }
  )

  // The registry holds a login to this address and the Meta block of the environment checks its own variable
  // by shape: the address this platform composes must be one the Meta block accepts, or a valid environment
  // would turn the login off
  it.each([
    'https://api.example.com',
    'https://api.example.com/',
    'http://localhost:4000',
    'http://127.0.0.1:8080/',
    'https://api.example.com:8443'
  ])('is accepted by the Meta block of the environment for API_URL %s', apiUrl => {
    const callback = oauthCallbackUrlOf(apiUrl)
    const source = {
      NODE_ENV: apiUrl.startsWith('https') ? 'production' : 'development',
      META_APP_ID: '950161111253304',
      META_APP_SECRET: 's'.repeat(32),
      META_WEBHOOK_VERIFY_TOKEN: 'v'.repeat(32),
      META_OAUTH_REDIRECT_URI: callback
    }
    expect(parseMetaEnv(source).META_OAUTH_REDIRECT_URI).toBe(callback)
  })
})
