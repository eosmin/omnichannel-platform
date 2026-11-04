import { AuthorType } from '@platform/core/domain'

import { quoteSideOf } from './quote-side'

describe('quoteSideOf', () => {
  it('says the customer quoted something the customer wrote', () => {
    expect(quoteSideOf(AuthorType.CUSTOMER)).toBe('customer')
  })

  it.each([AuthorType.AGENT, AuthorType.EXTERNAL, AuthorType.SYSTEM])(
    'says %s is the team: it is on the right of the thread',
    type => {
      expect(quoteSideOf(type)).toBe('team')
    }
  )

  it('reads a type of a newer server as the team', () => {
    expect(quoteSideOf('SOMETHING_NEW')).toBe('team')
  })
})
