import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { InvitationStatus } from '@platform/core/domain'
import {
  EmailService,
  InvitationOutbox,
  invitationRetryDelayMs,
  openInvitationEmail
} from '@platform/core/email'
import { errorName } from '@platform/core/errors'

import { readInEachStore } from '../schedulers/store-sweep'

// rls-context: the stores are listed from a global table (readInEachStore); every read or write of a table of a store runs inside
// JobContext.forStore

export type DeliveryResult = 'sent' | 'skipped' | 'failed'

// Delivers the emails that wait in the outbox of the invitations (Step 7.1-H). Two paths reach it: the job the api queues after the commit
// of an invitation, and the sweep, which takes whatever that job did not (a queue that was down, a worker that died).
//
// At least once, never twice in the normal case: a row is CLAIMED (one UPDATE that wins or loses) before the email is sent, a second
// delivery of the same row finds the claim and does nothing, and a claim that outlives CLAIM_TTL_MS means a worker died, so the next
// run delivers again. The only way to send twice is a worker that dies between the provider accepting the email and the clear.
//
// Nothing here logs the sealed email, the link or the address: a log line holds the invitation id and the name of an error.
@Injectable()
export class InvitationEmailDelivery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly cipher: CredentialCipher,
    private readonly email: EmailService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(InvitationEmailDelivery.name)
  }

  // `now` is the clock of the delivery (a test fixes it); a run takes its own at the moment of each delivery, never the one at which a sweep
  // started: a claim stamped with a stale time would expire early and let a second worker send the same email
  async deliver(
    storeId: string,
    invitationId: string,
    now: Date = new Date()
  ): Promise<DeliveryResult> {
    const claimed = await this.jobContext.forStore(storeId, () =>
      this.claim(storeId, invitationId, now)
    )
    if (claimed === null) return 'skipped'
    try {
      // The invitation is never read from a different store than the one of the job, and a row that is no longer pending was cleared by the claim
      await this.email.send(openInvitationEmail(this.cipher, claimed.sealed))
    } catch (error) {
      // Log first: a release that fails (the database at the same moment) must not hide why the email failed
      this.logger.warn(
        { invitationId, storeId, errorName: errorName(error) },
        'an invitation email could not be delivered; it is tried again later'
      )
      try {
        await this.jobContext.forStore(storeId, () =>
          this.release(storeId, invitationId, now, claimed.attempts)
        )
      } catch (releaseError) {
        // The claim then expires by itself (CLAIM_TTL_MS) and the sweep tries again
        this.logger.error(
          { invitationId, storeId, errorName: errorName(releaseError) },
          'the claim of an invitation email could not be released'
        )
      }
      return 'failed'
    }
    await this.jobContext.forStore(storeId, () => this.markSent(storeId, invitationId, now))
    return 'sent'
  }

  // The sweep: one pass over every store, the oldest emails first. A store that cannot be read is reported and the others go on (the work
  // is additive: what it lacks is delivered by the next run). Returns how many emails it sent.
  async sweep(now: Date = new Date()): Promise<number> {
    const due = await readInEachStore(
      this.prisma,
      this.jobContext,
      storeId =>
        this.prisma.client.invitation.findMany({
          where: {
            storeId,
            emailOutbox: { not: null },
            createdAt: { lte: new Date(now.getTime() - InvitationOutbox.SWEEP_GRACE_MS) },
            OR: [{ emailRetryAt: null }, { emailRetryAt: { lte: now } }]
          },
          select: { id: true, storeId: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: InvitationOutbox.BATCH
        }),
      (storeId, error) =>
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'the invitation emails of a store could not be listed'
        )
    )
    let sent = 0
    for (const { id, storeId } of due) {
      try {
        // No `now` here: each delivery reads the clock when it starts
        if ((await this.deliver(storeId, id)) === 'sent') sent += 1
      } catch (error) {
        this.logger.error(
          { invitationId: id, storeId, errorName: errorName(error) },
          'an invitation email failed in the sweep'
        )
      }
    }
    return sent
  }

  // One UPDATE decides who delivers: it wins only for a row of THIS store that still waits, is pending and not expired, is not claimed (or
  // whose claim expired), has attempts left and is past its backoff. Before it, two guarded writes clear what must never be mailed: the
  // outbox of an invitation that is no longer pending or has expired (accepted and revoked links are never mailed), and the one that used
  // its last attempt with no live claim. Each write repeats its own condition, so a row another worker is sending is never cleared.
  // Returns the sealed email and the attempts made, or null.
  private async claim(
    storeId: string,
    invitationId: string,
    now: Date
  ): Promise<{ sealed: Uint8Array; attempts: number } | null> {
    const claimExpired = new Date(now.getTime() - InvitationOutbox.CLAIM_TTL_MS)
    const noLiveClaim = [{ emailClaimedAt: null }, { emailClaimedAt: { lt: claimExpired } }]
    const dead = await this.prisma.client.invitation.updateMany({
      where: {
        id: invitationId,
        storeId,
        emailOutbox: { not: null },
        OR: [{ status: { not: String(InvitationStatus.PENDING) } }, { expiresAt: { lte: now } }]
      },
      data: { emailOutbox: null, emailClaimedAt: null }
    })
    if (dead.count > 0) return null
    const exhausted = await this.prisma.client.invitation.updateMany({
      where: {
        id: invitationId,
        storeId,
        emailOutbox: { not: null },
        emailAttempts: { gte: InvitationOutbox.MAX_ATTEMPTS },
        OR: noLiveClaim
      },
      data: { emailOutbox: null, emailClaimedAt: null }
    })
    if (exhausted.count > 0) {
      this.logger.error(
        { invitationId, storeId },
        'an invitation email was given up after its last attempt; the invitee needs a resend'
      )
      return null
    }
    const won = await this.prisma.client.invitation.updateMany({
      where: {
        id: invitationId,
        storeId,
        status: String(InvitationStatus.PENDING),
        expiresAt: { gt: now },
        emailOutbox: { not: null },
        emailAttempts: { lt: InvitationOutbox.MAX_ATTEMPTS },
        AND: [{ OR: noLiveClaim }, { OR: [{ emailRetryAt: null }, { emailRetryAt: { lte: now } }] }]
      },
      data: { emailClaimedAt: now, emailAttempts: { increment: 1 } }
    })
    if (won.count === 0) return null
    const claimed = await this.prisma.client.invitation.findFirst({
      where: { id: invitationId, storeId, emailClaimedAt: now },
      select: { emailOutbox: true, emailAttempts: true }
    })
    if (claimed?.emailOutbox == null) return null
    return { sealed: claimed.emailOutbox, attempts: claimed.emailAttempts }
  }

  // Gives the claim back and sets the backoff of the next attempt
  private async release(
    storeId: string,
    invitationId: string,
    now: Date,
    attempts: number
  ): Promise<void> {
    await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, storeId, emailClaimedAt: now },
      data: {
        emailClaimedAt: null,
        emailRetryAt: new Date(now.getTime() + invitationRetryDelayMs(attempts))
      }
    })
  }

  private async markSent(storeId: string, invitationId: string, now: Date): Promise<void> {
    await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, storeId },
      data: { emailOutbox: null, emailClaimedAt: null, emailRetryAt: null, emailSentAt: now }
    })
  }
}
