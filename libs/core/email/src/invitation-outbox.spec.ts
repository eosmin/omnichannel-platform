import { randomBytes } from 'node:crypto'

import { CredentialCipher, DecryptionError } from '@platform/core/crypto'
import { InvitationEmailStatus } from '@platform/core/domain'
import { EmailTemplates } from '@platform/core/queues'

import {
  type InvitationEmail,
  invitationEmailStatusOf,
  InvitationOutbox,
  invitationRetryDelayMs,
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

  it('does not open a bound email whose format byte was lowered to 1, with or without the data', () => {
    const sealed = sealInvitationEmail(cipher, email, here)
    const downgraded = Buffer.from(sealed)
    downgraded[0] = 1
    expect(() => openInvitationEmail(cipher, downgraded, here)).toThrow(DecryptionError)
    // A reader that has no data (the generic open) fails too: the tag was computed over the data
    expect(() => cipher.open(downgraded)).toThrow(DecryptionError)
  })

  it('does not open a bound email at all without its data', () => {
    expect(() => cipher.open(sealInvitationEmail(cipher, email, here))).toThrow(DecryptionError)
  })

  it('still opens what was sealed before the seal was bound', () => {
    const legacy = cipher.seal({ ...email })
    expect(openInvitationEmail(cipher, legacy, here)).toEqual(email)
  })

  it('waits at most ten minutes between attempts, so an invitation is delivered soon after the provider is back', () => {
    expect(invitationRetryDelayMs(1)).toBe(InvitationOutbox.RETRY_BASE_MS)
    for (let made = 1; made <= InvitationOutbox.MAX_ATTEMPTS; made += 1)
      expect(invitationRetryDelayMs(made)).toBeLessThanOrEqual(10 * 60_000)
    let span = 0
    for (let made = 1; made < InvitationOutbox.MAX_ATTEMPTS; made += 1)
      span += invitationRetryDelayMs(made)
    // The token stays sealed for hours, not days: the cap on the wait must not lengthen what the attempts cover
    expect(span).toBeGreaterThanOrEqual(5 * 3_600_000)
    expect(span).toBeLessThanOrEqual(6 * 3_600_000)
  })

  it('still calls failed a row that gave up under the old limit of twelve attempts', () => {
    expect(InvitationOutbox.FAILED_FROM_ATTEMPTS).toBe(12)
    expect(invitationEmailStatusOf({ waiting: false, emailSentAt: null, emailAttempts: 12 })).toBe(
      InvitationEmailStatus.FAILED
    )
    expect(invitationEmailStatusOf({ waiting: false, emailSentAt: null, emailAttempts: 11 })).toBe(
      InvitationEmailStatus.NOT_SENT
    )
  })

  it('calls failed only an email that used up its attempts, and never one that is still held', () => {
    const none = { emailSentAt: null, emailAttempts: 0 }
    expect(invitationEmailStatusOf({ ...none, waiting: true })).toBe(InvitationEmailStatus.PENDING)
    expect(
      invitationEmailStatusOf({
        waiting: true,
        emailSentAt: null,
        emailAttempts: InvitationOutbox.MAX_ATTEMPTS
      })
    ).toBe(InvitationEmailStatus.PENDING)
    expect(
      invitationEmailStatusOf({ waiting: false, emailSentAt: new Date(), emailAttempts: 3 })
    ).toBe(InvitationEmailStatus.SENT)
    expect(
      invitationEmailStatusOf({
        waiting: false,
        emailSentAt: null,
        emailAttempts: InvitationOutbox.MAX_ATTEMPTS
      })
    ).toBe(InvitationEmailStatus.FAILED)
    // An invitation from before the outbox, or one cleared by its expiry: not a failure, and not "sent" either
    expect(invitationEmailStatusOf({ ...none, waiting: false })).toBe(
      InvitationEmailStatus.NOT_SENT
    )
    expect(invitationEmailStatusOf({ waiting: false, emailSentAt: null, emailAttempts: 5 })).toBe(
      InvitationEmailStatus.NOT_SENT
    )
  })

  it('opens an email sealed with the previous key while a rotation is on, bound to its row', () => {
    const oldKey = randomBytes(32)
    const before = new CredentialCipher(oldKey)
    const rotated = new CredentialCipher(randomBytes(32), oldKey)
    const sealed = sealInvitationEmail(before, email, here)
    expect(openInvitationEmail(rotated, sealed, here)).toEqual(email)
    expect(() => openInvitationEmail(rotated, sealed, { ...here, storeId: 's2' })).toThrow(
      DecryptionError
    )
  })
})
