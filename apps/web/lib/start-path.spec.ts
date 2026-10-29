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
})
