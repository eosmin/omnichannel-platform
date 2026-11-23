import { z } from 'zod'

import type { CredentialCipher } from '@platform/core/crypto'
import { InvitationEmailStatus } from '@platform/core/domain'
import { SUPPORTED_LOCALES } from '@platform/core/i18n'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

// The outbox of the email of an invitation (Step 7.1-H). The row of the invitation keeps the email still to send, sealed with the key of the
// credentials: it carries the link, which holds the only copy of the token, and the address. The api writes it in the transaction that writes
// the invitation; a job of the worker opens it, sends it and clears it. Nothing here logs, and what is sealed is never put in a job or a log.
export const InvitationOutbox = {
  // A delivery that fails this many times is given up (the outbox is cleared and the invitee needs a resend), so a dead provider
  // does not keep a token sealed for ever. With the backoff below the twelve attempts span about six hours
  MAX_ATTEMPTS: 12,
  // After a failed attempt the next one waits RETRY_BASE_MS doubled for each attempt already made, up to RETRY_MAX_MS
  RETRY_BASE_MS: 60_000,
  RETRY_MAX_MS: 3_600_000,
  // A claim older than this is a worker that died after sending or before releasing: the email is delivered again (at least once)
  CLAIM_TTL_MS: 300_000,
  // The sweep leaves a fresh row to the job the api queued after the commit; only a row older than this is taken by the sweep
  SWEEP_GRACE_MS: 30_000,
  // Deliveries per store and per run of the sweep
  BATCH: 50
} as const

const sealedEmailSchema = z.object({
  template: z.literal(EmailTemplates.INVITATION),
  to: z.string().min(1),
  locale: z.enum(SUPPORTED_LOCALES),
  data: z.record(z.string(), z.unknown()),
  tags: z.object({ storeId: z.string().optional(), template: z.literal(EmailTemplates.INVITATION) })
})

export type InvitationEmail = Omit<SendEmailJob, 'to' | 'template' | 'tags'> & {
  template: typeof EmailTemplates.INVITATION
  to: string
  tags: { storeId?: string; template: typeof EmailTemplates.INVITATION }
}

// The seal is bound to the store and the invitation it belongs to (AES-GCM associated data): a sealed email copied to the row of another
// invitation, or of another store, does not open. Rows sealed before this (format 1, no data) still open: they are a few hours old at most
// (MAX_ATTEMPTS), so no migration is needed.
export function invitationOutboxAad(storeId: string, invitationId: string): string {
  return `invitation-outbox:${storeId}:${invitationId}`
}

export function sealInvitationEmail(
  cipher: CredentialCipher,
  email: InvitationEmail,
  aad: { storeId: string; invitationId: string }
): Uint8Array<ArrayBuffer> {
  return cipher.seal({ ...email }, invitationOutboxAad(aad.storeId, aad.invitationId))
}

// The database is a boundary: what comes out is checked again. A row that no longer parses (a key that changed, a template that was
// renamed) throws, and the delivery counts it as a failed attempt.
export function openInvitationEmail(
  cipher: CredentialCipher,
  sealed: Uint8Array,
  aad: { storeId: string; invitationId: string }
): InvitationEmail {
  return sealedEmailSchema.parse(
    cipher.openRotating(sealed, invitationOutboxAad(aad.storeId, aad.invitationId)).credentials
  )
}

// What the inviter sees. `waiting` is whether the outbox still holds the email. `sent` only when a sent time exists. An email that used up its
// attempts with no sent time (the worker gave it up and cleared the outbox) is `failed`. Any other empty outbox (an invitation older than the
// outbox, or one cleared because it expired) is `not_sent`: the web says nothing about it, as the row already says it expired.
export function invitationEmailStatusOf(row: {
  waiting: boolean
  emailSentAt: Date | null
  emailAttempts: number
}): InvitationEmailStatus {
  if (row.waiting) return InvitationEmailStatus.PENDING
  if (row.emailSentAt !== null) return InvitationEmailStatus.SENT
  return row.emailAttempts >= InvitationOutbox.MAX_ATTEMPTS
    ? InvitationEmailStatus.FAILED
    : InvitationEmailStatus.NOT_SENT
}

// How long after a failed attempt the next one may start (`attemptsMade` counts the one that just failed)
export function invitationRetryDelayMs(attemptsMade: number): number {
  return Math.min(
    InvitationOutbox.RETRY_BASE_MS * 2 ** Math.max(attemptsMade - 1, 0),
    InvitationOutbox.RETRY_MAX_MS
  )
}
