import { randomBytes } from 'node:crypto'

import { CredentialCipher, DecryptionError } from '@platform/core/crypto'
import { InvitationEmailStatus } from '@platform/core/domain'
import { EmailTemplates } from '@platform/core/queues'

import {
  type InvitationEmail,
  invitationEmailStatusOf,
  openInvitationEmail,
  sealInvitationEmail
} from './invitation-outbox'

const email = {
  template: EmailTemplates.INVITATION,
  to: 'a@example.com',
  locale: 'en',
  data: { url: 'https://app.example.com/invitations/T' },
  tags: { storeId: 's1', template: EmailTemplates.INVITATION }
} satisfies InvitationEmail

describe('the outbox of an invitation email', () => {
  const cipher = new CredentialCipher(randomBytes(32))
  const here = { storeId: 's1', invitationId: 'i1' }

  it('opens only for the store and the invitation it was sealed for', () => {
    const sealed = sealInvitationEmail(cipher, email, here)
    expect(openInvitationEmail(cipher, sealed, here)).toEqual(email)
    expect(() => openInvitationEmail(cipher, sealed, { ...here, invitationId: 'i2' })).toThrow(
      DecryptionError
    )
    expect(() => openInvitationEmail(cipher, sealed, { ...here, storeId: 's2' })).toThrow(
      DecryptionError
    )
  })

  it('still opens what was sealed before the seal was bound', () => {
    const legacy = cipher.seal({ ...email })
    expect(openInvitationEmail(cipher, legacy, here)).toEqual(email)
  })

  it('reads the status from the outbox and the sent time', () => {
    expect(invitationEmailStatusOf({ waiting: true, emailSentAt: null })).toBe(
      InvitationEmailStatus.PENDING
    )
    expect(invitationEmailStatusOf({ waiting: false, emailSentAt: new Date() })).toBe(
      InvitationEmailStatus.SENT
    )
    expect(invitationEmailStatusOf({ waiting: false, emailSentAt: null })).toBe(
      InvitationEmailStatus.FAILED
    )
  })
})
