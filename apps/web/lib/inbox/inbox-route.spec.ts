import { isInboxPath } from './inbox-route'

describe('isInboxPath', () => {
  it('is the list and a conversation of a store', () => {
    expect(isInboxPath('/s/abc/inbox')).toBe(true)
    expect(isInboxPath('/s/abc/inbox/def')).toBe(true)
  })

  it('is nothing else', () => {
    expect(isInboxPath('/s/abc/customers')).toBe(false)
    expect(isInboxPath('/s/abc/inboxes')).toBe(false)
    expect(isInboxPath('/s/abc/settings/inbox')).toBe(false)
    expect(isInboxPath('/account')).toBe(false)
    expect(isInboxPath(null)).toBe(false)
  })
})
