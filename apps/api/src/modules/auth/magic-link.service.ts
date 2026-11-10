import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  MAGIC_LINK_EMAIL_THROTTLER,
  MagicLinkThrottle,
  RETRY_AFTER_METADATA_KEY
} from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import { VerificationTokenType } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { MAGIC_LINK_EMAIL_LIMIT } from '@platform/core/http'
import { JobNames, QueueNames, type RequestMagicLinkJob } from '@platform/core/queues'

import { type IssuedSession, type SessionContext, SessionService } from './session.service'

export interface ConsumedMagicLink {
  session: IssuedSession
  user: { id: string; email: string; name: string }
}

// Login without a password: a single-use link sent to the email of an account that exists.
// Signup is closed (users come from the seed or from an invitation), so an unknown email gets
// no link; the answer is the same either way, and the same limit counts it, so the endpoint tells
// nothing about who has an account.
@Injectable()
export class MagicLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<RequestMagicLinkJob>,
    @Inject(getStorageToken()) private readonly throttleStorage: ThrottlerStorage,
    @Inject(MAGIC_LINK_EMAIL_LIMIT) private readonly emailLimit: number,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MagicLinkService.name)
  }

  // Asking again is the resend: the new link replaces the ones not used yet. This does the same
  // work for any address, known or not (count the limit, queue one job), and never looks the
  // address up: the worker does, so how long this takes tells nothing about who has an account.
  async request(rawEmail: string, correlationId?: string): Promise<void> {
    const email = normalizeEmail(rawEmail)
    await this.limitByEmail(email)
    await this.emailQueue.add(
      JobNames.REQUEST_MAGIC_LINK,
      { email, ...(correlationId === undefined ? {} : { correlationId }) },
      // The job holds an address anybody can type, account or not: it stays in Redis for no longer
      // than the work takes, failed or not
      { removeOnComplete: true, removeOnFail: true }
    )
  }

  // Uses the link: marks it used, verifies the email and opens the session, all or nothing
  async consume(token: string, context: SessionContext = {}): Promise<ConsumedMagicLink> {
    const stored = await this.prisma.client.verificationToken.findFirst({
      // The type is part of the question: the secret of a DSR verification opens nothing here
      where: { tokenHash: hashToken(token), type: VerificationTokenType.MAGIC_LINK },
      include: { user: { select: { id: true, email: true, name: true } } }
    })
    // Unknown, not a login link, already used: the same answer, so nothing tells them apart
    if (stored === null || stored.usedAt !== null || stored.user === null) {
      throw invalidLink()
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new PlatformException(
        ErrorCodes.AUTH_TOKEN_EXPIRED,
        'magic link expired',
        HttpStatusCodes.UNAUTHORIZED
      )
    }
    const { user } = stored

    return this.prisma.transaction(async tx => {
      // The one atomic step: of two requests with the same link, only one gets count 1
      const claim = await tx.verificationToken.updateMany({
        where: { id: stored.id, usedAt: null },
        data: { usedAt: new Date() }
      })
      if (claim.count === 0) throw invalidLink()
      // Reaching this inbox proves the address; the links not used yet are void
      await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } })
      await tx.verificationToken.deleteMany({
        where: { userId: user.id, type: VerificationTokenType.MAGIC_LINK, usedAt: null }
      })
      const session = await this.sessions.issue(user, context, tx)
      this.logger.info({ userId: user.id }, 'magic link consumed')
      return { session, user }
    })
  }

  // The same limit as the IP one, but per address: many IPs cannot mail-bomb one inbox
  private async limitByEmail(email: string): Promise<void> {
    const record = await this.throttleStorage.increment(
      emailLimitKey(email),
      MagicLinkThrottle.ttlMs,
      this.emailLimit,
      0,
      MAGIC_LINK_EMAIL_THROTTLER
    )
    if (record.isBlocked) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'too many magic links requested for this address',
        HttpStatusCodes.TOO_MANY_REQUESTS,
        { [RETRY_AFTER_METADATA_KEY]: record.timeToBlockExpire }
      )
    }
  }
}

// The key under which the per-address limit is counted. Exported so that the tests clear the very
// same key instead of rebuilding it.
export function emailLimitKey(email: string): string {
  return `magic-link:${hashToken(email)}`
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function invalidLink(): PlatformException {
  return new PlatformException(
    ErrorCodes.AUTH_TOKEN_INVALID,
    'invalid magic link',
    HttpStatusCodes.UNAUTHORIZED
  )
}
