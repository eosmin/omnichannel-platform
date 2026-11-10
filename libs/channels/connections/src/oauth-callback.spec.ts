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
})
