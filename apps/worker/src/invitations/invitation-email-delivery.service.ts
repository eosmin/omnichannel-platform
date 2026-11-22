import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { InvitationStatus } from '@platform/core/domain'
import { EmailService, InvitationOutbox, openInvitationEmail } from '@platform/core/email'
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
      await this.email.send(openInvitationEmail(this.cipher, claimed))
    } catch (error) {
      await this.jobContext.forStore(storeId, () => this.release(storeId, invitationId, now))
      this.logger.warn(
        { invitationId, storeId, errorName: errorName(error) },
        'an invitation email could not be delivered; the sweep tries again'
      )
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
            createdAt: { lte: new Date(now.getTime() - InvitationOutbox.SWEEP_GRACE_MS) }
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
        if ((await this.deliver(storeId, id, now)) === 'sent') sent += 1
      } catch (error) {
        this.logger.error(
          { invitationId: id, storeId, errorName: errorName(error) },
          'an invitation email failed in the sweep'
        )
      }
    }
    return sent
  }

  // One UPDATE decides who delivers: it wins only for a row of THIS store that still waits, is not claimed (or whose claim expired) and has
  // attempts left. A row whose invitation is no longer pending, or expired, is cleared instead of delivered: an accepted or revoked link
  // must never be mailed. Returns the sealed email to send, or null.
  private async claim(
    storeId: string,
    invitationId: string,
    now: Date
  ): Promise<Uint8Array | null> {
    const row = await this.prisma.client.invitation.findFirst({
      where: { id: invitationId, storeId, emailOutbox: { not: null } },
      select: { status: true, expiresAt: true, emailAttempts: true }
    })
    if (row === null) return null
    const stale =
      row.status !== String(InvitationStatus.PENDING) ||
      row.expiresAt.getTime() <= now.getTime() ||
      row.emailAttempts >= InvitationOutbox.MAX_ATTEMPTS
    if (stale) {
      await this.prisma.client.invitation.updateMany({
        where: { id: invitationId, storeId },
        data: { emailOutbox: null, emailClaimedAt: null }
      })
      if (
        row.emailAttempts >= InvitationOutbox.MAX_ATTEMPTS &&
        row.status === String(InvitationStatus.PENDING)
      ) {
        this.logger.error(
          { invitationId, storeId },
          'an invitation email was given up after its last attempt; the invitee needs a resend'
        )
      }
      return null
    }
    const won = await this.prisma.client.invitation.updateMany({
      where: {
        id: invitationId,
        storeId,
        status: InvitationStatus.PENDING,
        emailOutbox: { not: null },
        OR: [
          { emailClaimedAt: null },
          { emailClaimedAt: { lt: new Date(now.getTime() - InvitationOutbox.CLAIM_TTL_MS) } }
        ]
      },
      data: { emailClaimedAt: now, emailAttempts: { increment: 1 } }
    })
    if (won.count === 0) return null
    const claimed = await this.prisma.client.invitation.findFirst({
      where: { id: invitationId, storeId },
      select: { emailOutbox: true }
    })
    return claimed?.emailOutbox ?? null
  }

  private async release(storeId: string, invitationId: string, now: Date): Promise<void> {
    await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, storeId, emailClaimedAt: now },
      data: { emailClaimedAt: null }
    })
  }

  private async markSent(storeId: string, invitationId: string, now: Date): Promise<void> {
    await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, storeId },
      data: { emailOutbox: null, emailClaimedAt: null, emailSentAt: now }
    })
  }
}
