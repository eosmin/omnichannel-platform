import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  DSR_VERIFY_FRAGMENT_KEY,
  DsrRejectionReasons,
  DsrResourceTypes,
  DsrSubjectTypes,
  DSR_VERIFY_WEB_PATH,
  type DsrConfig,
  type DsrIntake,
  dsrEmailHash,
  normalizeDsrEmail,
  openDsrIntake
} from '@platform/core/compliance'
import { generateToken, hashToken, encrypt, parseEncryptionKey } from '@platform/core/crypto'
import { JobContext, PrismaService, resolveDsrStore } from '@platform/core/database'
import { DAY_MS, DsrStatus, VerificationTokenType } from '@platform/core/domain'
import { DIGEST_LINKS, type DigestLinks } from '@platform/core/notifications'
import { EmailTemplates, JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'

// rls-context: the store is found by the SQL function of its public key; every other access runs inside JobContext.forStore of that store

export type DsrIntakeOutcome =
  | 'dropped' // off, a sealed payload that does not open, or a key no store has: nothing written
  | 'no_customer' // the address belongs to no customer of the store: nothing written, nothing sent
  | 'duplicate' // the same person already has this kind of request open: nothing written, nothing sent
  | 'created'

// The second half of a public data request (the first half only counted and sealed it). Here, and only here, the address meets the customers: a
// match writes the request (with the address hashed and sealed, never in the clear) and the mail with the link; any other case ends without a
// trace. The answer of the form was sent long before, so nothing here can tell the person which case it was.
@Injectable()
export class DsrIntakeWorker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly audit: AuditService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(DIGEST_LINKS) private readonly links: DigestLinks,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrIntakeWorker.name)
  }

  async handle(sealed: string): Promise<DsrIntakeOutcome> {
    if (!this.config.enabled) return 'dropped'
    const intake = openDsrIntake(
      sealed,
      this.config.encryptionKeyHex,
      this.config.previousEncryptionKeyHex
    )
    if (intake === null) return 'dropped'
    const store = await resolveDsrStore(this.prisma.client, intake.storeKey)
    if (store === null) return 'dropped'

    const email = normalizeDsrEmail(intake.email)
    const emailHash = dsrEmailHash(email, this.config.hashKey)
    const token = generateToken()
    const outcome = await this.jobContext.forStore(store.storeId, () =>
      this.prisma.transaction(async tx => {
        // One writer per person and kind at a time: two jobs for the same address wait for each other, so only one request is made
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dsr-intake:${store.storeId}:${emailHash}:${intake.type}`}, 0))`
        // An exact comparison of the trimmed, lower-cased addresses (never ILIKE: "%" and "_" would be wildcards), customers not erased
        const customers = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM customers
          WHERE store_id = ${store.storeId} AND erased_at IS NULL
            AND lower(regexp_replace(email, '^\\s+|\\s+$', '', 'g')) = ${email}
          ORDER BY id`
        if (customers.length === 0) return { kind: 'no_customer' as const }
        const open = await tx.dataSubjectRequest.count({
          where: {
            storeId: store.storeId,
            subjectEmailHash: emailHash,
            type: intake.type,
            status: {
              in: [DsrStatus.PENDING_VERIFICATION, DsrStatus.MANUAL_REVIEW, DsrStatus.IN_PROGRESS]
            }
          }
        })
        if (open > 0) return { kind: 'duplicate' as const }
        const now = Date.now()
        const request = await tx.dataSubjectRequest.create({
          data: {
            organizationId: store.organizationId,
            storeId: store.storeId,
            type: intake.type,
            status: DsrStatus.PENDING_VERIFICATION,
            subjectType: DsrSubjectTypes.CUSTOMER,
            subjectEmailHash: emailHash,
            subjectCustomerIds: customers.map(customer => customer.id),
            // Where the closing notice goes: sealed, and set to NULL when the request ends (the address is never kept in the clear)
            notifyToEncrypted: encrypt(email, parseEncryptionKey(this.config.encryptionKeyHex)),
            // The language of the form: the closing mail goes in it, as the verification mail does
            noticeLocale: intake.locale,
            deadlineAt: new Date(now + ComplianceConfig.DSR_RESPONSE_DEADLINE_DAYS * DAY_MS)
          },
          select: { id: true }
        })
        await tx.verificationToken.create({
          data: {
            type: VerificationTokenType.DSR_VERIFICATION,
            tokenHash: hashToken(token),
            subject: request.id,
            expiresAt: new Date(now + ComplianceConfig.DSR_VERIFICATION_TOKEN_DAYS * DAY_MS)
          }
        })
        return { kind: 'created' as const, requestId: request.id }
      })
    )
    if (outcome.kind !== 'created') return outcome.kind

    // Ids only in the audit log; the mail is queued once the request is saved
    this.audit.log({
      action: AuditAction.DSR_CREATED,
      actor: { system: true },
      storeId: store.storeId,
      organizationId: store.organizationId,
      resourceType: DsrResourceTypes.REQUEST,
      resourceId: outcome.requestId,
      metadata: { type: intake.type }
    })
    try {
      await this.queueMail(email, token, intake)
    } catch (error) {
      // The request is saved but its link was never queued: a retry of this job would find it open and call it a duplicate, and the person
      // could never ask again. It is closed (and the address and its hash cleared) and the failure goes up, so the retry makes a new one.
      await this.abandon(store.storeId, outcome.requestId)
      throw error
    }
    this.logger.info(
      { requestId: outcome.requestId },
      'data request created, verification mail queued'
    )
    return 'created'
  }

  private async abandon(storeId: string, requestId: string): Promise<void> {
    await this.jobContext.forStore(storeId, async () => {
      await this.prisma.client.dataSubjectRequest.updateMany({
        where: { id: requestId, storeId, status: DsrStatus.PENDING_VERIFICATION },
        data: {
          status: DsrStatus.REJECTED,
          rejectionReason: DsrRejectionReasons.VERIFICATION_MAIL_NOT_QUEUED,
          notifyToEncrypted: null,
          subjectEmailHash: null
        }
      })
    })
  }

  private async queueMail(email: string, token: string, intake: DsrIntake): Promise<void> {
    await this.emailQueue.add(
      JobNames.SEND_EMAIL,
      {
        template: EmailTemplates.DSR_VERIFICATION,
        to: email,
        locale: intake.locale,
        data: {
          url: this.linkFor(token),
          expiresInDays: ComplianceConfig.DSR_VERIFICATION_TOKEN_DAYS,
          requestType: intake.type
        },
        tags: { template: EmailTemplates.DSR_VERIFICATION }
      },
      // The job holds the raw token and the address: gone as soon as it is sent, and an hour after a failure
      {
        removeOnComplete: true,
        removeOnFail: { age: ComplianceConfig.DSR_INTAKE_JOB_TTL_MS / 1000 }
      }
    )
  }

  // The token goes in the fragment, which the browser never sends to a server
  private linkFor(token: string): string {
    const url = new URL(DSR_VERIFY_WEB_PATH, this.links.frontendUrl)
    url.hash = `${DSR_VERIFY_FRAGMENT_KEY}=${token}`
    return url.toString()
  }
}
