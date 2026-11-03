import { MembershipStatus } from './status-enums'

describe('MembershipStatus', () => {
  it('has the three states of a membership, and the suspended one is its own', () => {
    expect(Object.values(MembershipStatus).sort()).toEqual(['ACTIVE', 'REVOKED', 'SUSPENDED'])
    expect(MembershipStatus.SUSPENDED).toBe('SUSPENDED')
    // Nothing stored under another spelling: the column is plain text and a typo would be a new state
    expect(new Set(Object.values(MembershipStatus)).size).toBe(3)
  })
})
