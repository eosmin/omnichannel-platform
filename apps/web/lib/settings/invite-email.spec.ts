import { isInvitableEmail } from './invite-email'

describe('isInvitableEmail', () => {
  it.each(['ana@test.com', '  ana.perez+qa@test.com  ', 'a@b.co'])('takes %s', value => {
    expect(isInvitableEmail(value)).toBe(true)
  })

  it.each(['ñandú.pérez@test.com', 'ana@', 'ana', '@test.com', 'ana perez@test.com', ''])(
    'refuses %s',
    value => {
      expect(isInvitableEmail(value)).toBe(false)
    }
  )
})
