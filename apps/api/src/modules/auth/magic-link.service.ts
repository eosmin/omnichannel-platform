import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  MAGIC_LINK_EMAIL_THROTTLER,
  MAGIC_LINK_FRAGMENT_KEY,
  MAGIC_LINK_TTL_MINUTES,
  MAGIC_LINK_WEB_PATH,
  MagicLinkThrottle
} from '@platform/core/auth'
import { AUTH_SETTINGS, type AuthSettings } from '@platform/core/auth-module'
import { generateToken, hashToken } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import { VerificationTokenType } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { EmailTemplates, JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'

import { type IssuedSession, type SessionContext, SessionService } from './session.service'

const MS_PER_MINUTE = 60_000
const UNAUTHORIZED = 401
const TOO_MANY_REQUESTS = 429

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
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(getStorageToken()) private readonly throttleStorage: ThrottlerStorage,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MagicLinkService.name)
  }

  // Asking again is the resend: the new link replaces the ones not used yet
  async request(rawEmail: string, correlationId?: string): Promise<void> {
    const email = normalizeEmail(rawEmail)
    await this.limitByEmail(email)

    const user = await this.findUserByEmail(email)
    if (user === null || !user.emailValid) {
      // Nothing is sent. emailValid is false after the provider reported a hard bounce or a
      // complaint: writing to that address again would hurt the sender reputation of everyone.
      this.logger.info({ known: user !== null }, 'magic link requested: nothing to send')
      return
    }

    const token = generateToken()
    await this.prisma.transaction(async tx => {
      await tx.verificationToken.deleteMany({
        where: { userId: user.id, type: VerificationTokenType.MAGIC_LINK, usedAt: null }
      })
      await tx.verificationToken.create({
        data: {
          type: VerificationTokenType.MAGIC_LINK,
          tokenHash: hashToken(token),
          userId: user.id,
          subject: user.email,
          expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * MS_PER_MINUTE)
        }
      })
    })
    // After the commit: a mail must never go out for a token that was not saved
    await this.emailQueue.add(
      JobNames.SEND_EMAIL,
      {
        template: EmailTemplates.MAGIC_LINK,
        to: user.email,
        locale: localeOrDefault(user.locale),
        data: { url: this.linkFor(token), expiresInMinutes: MAGIC_LINK_TTL_MINUTES },
        tags: { template: EmailTemplates.MAGIC_LINK },
        ...(correlationId === undefined ? {} : { correlationId })
      },
      // The job holds the raw token: once sent it has no reason to stay for the 24 hours that the
      // queue keeps completed jobs. (A failed job keeps it, and the token expires in minutes.)
      { removeOnComplete: true }
    )
    this.logger.info({ userId: user.id }, 'magic link sent')
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
      throw new PlatformException(ErrorCodes.AUTH_TOKEN_EXPIRED, 'magic link expired', UNAUTHORIZED)
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

  // An exact comparison of lower-cased addresses, because the seed stores the address as it was
  // written. Not `equals` with mode 'insensitive': Prisma turns that into ILIKE, where "%" and "_"
  // are wildcards, and a request for "_____@example.com" would reach a real account whose address
  // it does not know and escape the per-address limit.
  private async findUserByEmail(
    email: string
  ): Promise<{ id: string; email: string; locale: string; emailValid: boolean } | null> {
    const rows = await this.prisma.client.$queryRaw<
      { id: string; email: string; locale: string; email_valid: boolean }[]
    >`SELECT id, email, locale, email_valid FROM users WHERE lower(email) = ${email} LIMIT 1` // The shape of this SELECT
    const row = rows[0]
    return row === undefined
      ? null
      : { id: row.id, email: row.email, locale: row.locale, emailValid: row.email_valid }
  }

  // The same limit as the IP one, but per address: many IPs cannot mail-bomb one inbox
  private async limitByEmail(email: string): Promise<void> {
    const record = await this.throttleStorage.increment(
      emailLimitKey(email),
      MagicLinkThrottle.ttlMs,
      MagicLinkThrottle.limit,
      0,
      MAGIC_LINK_EMAIL_THROTTLER
    )
    if (record.isBlocked) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'too many magic links requested for this address',
        TOO_MANY_REQUESTS,
        { retryAfterSeconds: record.timeToBlockExpire }
      )
    }
  }

  // The token goes in the fragment, which the browser never sends to a server
  private linkFor(token: string): string {
    const url = new URL(MAGIC_LINK_WEB_PATH, this.settings.frontendUrl)
    url.hash = `${MAGIC_LINK_FRAGMENT_KEY}=${token}`
    return url.toString()
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

function localeOrDefault(value: string): Locale {
  return SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE
}

function invalidLink(): PlatformException {
  return new PlatformException(ErrorCodes.AUTH_TOKEN_INVALID, 'invalid magic link', UNAUTHORIZED)
}
