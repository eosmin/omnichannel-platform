import { chooseStartPath } from './start-path'

const stores = [{ storeId: 'a' }, { storeId: 'b' }]

describe('chooseStartPath', () => {
  it('goes to the store used last', () => {
    expect(chooseStartPath(stores, 'b')).toBe('/s/b/inbox')
  })

  it('goes to the first store when the last one is unknown or no longer theirs', () => {
    expect(chooseStartPath(stores, null)).toBe('/s/a/inbox')
    expect(chooseStartPath(stores, 'removed')).toBe('/s/a/inbox')
  })

  it('goes to the no-access screen with no membership', () => {
    expect(chooseStartPath([], 'a')).toBe('/no-access')
  })

  describe('after a login with Facebook that could not name its store', () => {
    it('goes to the channels of the store with the reason, so that it is told there', () => {
      expect(chooseStartPath(stores, 'b', '?oauth_error=oauth_expired')).toBe(
        '/s/b/settings/channels?oauth_error=oauth_expired'
      )
    })

    it('carries a value that is not of the list as the generic one, never as it came', () => {
      expect(chooseStartPath(stores, null, '?oauth_error=%3Cscript%3E')).toBe(
        '/s/a/settings/channels?oauth_error=generic'
      )
    })

    it('goes to the inbox when no reason comes, or to no-access with no store', () => {
      expect(chooseStartPath(stores, 'b', '?page=2')).toBe('/s/b/inbox')
      expect(chooseStartPath([], 'b', '?oauth_error=oauth_expired')).toBe('/no-access')
    })
  })
})
