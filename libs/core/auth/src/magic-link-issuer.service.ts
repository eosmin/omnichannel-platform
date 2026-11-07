import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  MAGIC_LINK_FRAGMENT_KEY,
  MAGIC_LINK_TTL_MINUTES,
  MAGIC_LINK_WEB_PATH
} from '@platform/core/auth'
import { generateToken, hashToken } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import { VerificationTokenType } from '@platform/core/domain'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { DIGEST_LINKS, type DigestLinks } from '@platform/core/notifications'
import { EmailTemplates, JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'

const MS_PER_MINUTE = 60_000

// The other half of a magic link request. The api counts the limit and queues a job for any
// address; this looks the address up, so that the request takes the same time whether or not there
// is an account. An unknown address, or one the provider reported as dead, gets nothing.
@Injectable()
export class MagicLinkIssuer {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(DIGEST_LINKS) private readonly links: DigestLinks,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MagicLinkIssuer.name)
  }

  // Asking again is the resend: the new link replaces the ones not used yet
  async issue(email: string, correlationId?: string): Promise<void> {
    const user = await this.findUserByEmail(email)
    if (user === null || !user.emailValid) {
      // emailValid is false after the provider reported a hard bounce or a complaint: writing to
      // that address again would hurt the sender reputation of everyone.
      this.logger.info({ known: user !== null }, 'magic link requested: nothing to send')
      return
    }

    const token = generateToken()
    await this.prisma.transaction(async tx => {
      // Two requests for one user (a double click on "resend", or a retried job) take turns here, so
      // the second one voids the link of the first and exactly one stays live
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`magic-link:${user.id}`}, 0))`
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

  // The token goes in the fragment, which the browser never sends to a server
  private linkFor(token: string): string {
    const url = new URL(MAGIC_LINK_WEB_PATH, this.links.frontendUrl)
    url.hash = `${MAGIC_LINK_FRAGMENT_KEY}=${token}`
    return url.toString()
  }
}

function localeOrDefault(value: string): Locale {
  return SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE
}
