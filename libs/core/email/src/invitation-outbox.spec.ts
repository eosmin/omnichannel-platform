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

  it('calls failed only an email that used up its attempts, and never one that is still held', () => {
    const none = { emailSentAt: null, emailAttempts: 0 }
    expect(invitationEmailStatusOf({ ...none, waiting: true })).toBe(InvitationEmailStatus.PENDING)
    expect(invitationEmailStatusOf({ waiting: true, emailSentAt: null, emailAttempts: 12 })).toBe(
      InvitationEmailStatus.PENDING
    )
    expect(
      invitationEmailStatusOf({ waiting: false, emailSentAt: new Date(), emailAttempts: 3 })
    ).toBe(InvitationEmailStatus.SENT)
    expect(invitationEmailStatusOf({ waiting: false, emailSentAt: null, emailAttempts: 12 })).toBe(
      InvitationEmailStatus.FAILED
    )
    // An invitation from before the outbox, or one cleared by its expiry: not a failure
    expect(invitationEmailStatusOf({ ...none, waiting: false })).toBe(InvitationEmailStatus.SENT)
  })
})
