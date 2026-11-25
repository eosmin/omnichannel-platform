import { Inject, Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  DsrExportDownloadVia,
  DsrResourceTypes,
  openDsrExportPassword
} from '@platform/core/compliance'
import { CredentialCipher, hashToken } from '@platform/core/crypto'
import { contextOf, PrismaService, resolveDsrExportDownload } from '@platform/core/database'
import { DsrStatus, DsrType, VerificationTokenType } from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  isTransactionConflictError,
  PlatformException
} from '@platform/core/errors'
import { ExportContentTypes } from '@platform/core/exports'
import { StorageService } from '@platform/core/storage-module'

import type { DsrExportDownloadBody } from './compliance.schemas'

export interface DsrExportDownloadAnswer {
  url: string
  filename: string
  expiresInSeconds: number
  // The password of the encrypted ZIP: it leaves ONCE, in the answer of the call that spends the link, and is never logged or audited
  password: string
}

// The kinds of request whose answer is a file
const EXPORT_TYPES: readonly string[] = [DsrType.ACCESS, DsrType.PORTABILITY]

// One answer for a token that is unknown, used, expired, of a request that is not a finished export, whose file is gone, or for the flow being off
function invalidLink(): PlatformException {
  return new PlatformException(
    ErrorCodes.DSR_EXPORT_LINK_INVALID,
    'the link to the data export is not valid',
    HttpStatusCodes.BAD_REQUEST
  )
}

// The person trades the link of the closing mail for the file of their access or portability request (Step 7.2-H2b-3). The token is spent by the
// FIRST caller, in the same transaction that signs the link, so a failure to sign gives it back; what comes out is a signed link of a few minutes
// to the object in the bucket (the bytes never pass through the api). The link names the store's file by an opaque key and carries no address.
@Injectable()
export class DsrExportDownloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly cipher: CredentialCipher,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrExportDownloadService.name)
  }

  async download(body: DsrExportDownloadBody): Promise<DsrExportDownloadAnswer> {
    try {
      return await this.run(body)
    } catch (error) {
      // Two calls of the same request that collided: the database rolled this one back and nothing was spent by it. It is the same answer as
      // any other link that does not open, never a different error (that would tell a live link from a dead one)
      if (isTransactionConflictError(error)) throw invalidLink()
      throw error
    }
  }

  private async run(body: DsrExportDownloadBody): Promise<DsrExportDownloadAnswer> {
    if (!this.config.enabled) throw invalidLink()
    const tokenHash = hashToken(body.token)
    // The request is found by the hash of the token, before there is a context; its rows are touched only inside the context it opens
    const found = await resolveDsrExportDownload(this.prisma.client, tokenHash)
    if (found === null) throw invalidLink()

    const context = contextOf(found)
    const readRequest = () =>
      this.prisma.client.dataSubjectRequest.findFirst({
        where: {
          id: found.id,
          storeId: found.storeId,
          type: { in: [...EXPORT_TYPES] },
          status: DsrStatus.COMPLETED,
          resultKey: { not: null },
          resultExpiresAt: { gt: new Date() }
        },
        select: { resultKey: true, resultPasswordSealed: true, type: true }
      })
    // The bucket is asked BEFORE anything is spent and outside the transaction (no network call while a lock is held): a file the bucket no
    // longer holds (a lifecycle rule, a purge race) costs the person nothing and the same link works once it is back. The claim below reads
    // the request again and refuses a file that changed in between.
    const before = await this.prisma.tenantTransaction(context, readRequest)
    // An export with no sealed password was made before the ZIP was encrypted: its object is readable by anyone who holds the bucket, so it is
    // not handed over (it expires with its date, and a reviewer asks for the export again)
    if (before?.resultKey == null || before.resultPasswordSealed == null) throw invalidLink()
    if ((await this.storage.head(before.resultKey).catch(() => null)) === null) throw invalidLink()

    const answer = await this.prisma.tenantTransaction(context, async () => {
      // One caller at a time per request: the claim below spends EVERY live link of the request, and two callers that each held one row and
      // waited for the other's would deadlock (one of them would answer an error that is not the uniform one)
      await this.prisma.client.$queryRaw`
        SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`dsr-export-download:${found.id}`}, 0))) AS lock`
      // The claim, in ONE statement: if this token is live, the first caller spends it and every other live link of the request (the tokens of
      // earlier mails of a notice asked for again can not hand the file over a second time); a second click, a scanner racing the person or a
      // sibling link finds nothing left. A token that is not live spends nothing, so a dead link never burns a live one. NOTE: the lookup of `resolve_dsr_export_download` already needs a live token, so the `own` condition is defense in depth: it is reached only by a token that died between the lookup and this statement (a window of milliseconds, with a sibling of a later date still live), and no test of the route can drive it.
      const spent = await this.prisma.client.$queryRaw<{ token_hash: string }[]>`
        UPDATE verification_tokens SET used_at = now()
        WHERE type = ${VerificationTokenType.DSR_EXPORT_DOWNLOAD} AND subject = ${found.id}
          AND used_at IS NULL AND expires_at > now()
          AND EXISTS (
            SELECT 1 FROM verification_tokens own
            WHERE own.token_hash = ${tokenHash} AND own.type = ${VerificationTokenType.DSR_EXPORT_DOWNLOAD}
              AND own.subject = ${found.id} AND own.used_at IS NULL AND own.expires_at > now())
        RETURNING token_hash`
      if (!spent.some(row => row.token_hash === tokenHash)) return null
      const request = await readRequest()
      // The file went or changed between the check and the claim: the token is not spent for a file that is not the one checked (the throw
      // rolls the claim back)
      if (request?.resultKey == null || request.resultKey !== before.resultKey) throw invalidLink()
      // The password is opened INSIDE the claim: it can be read only by the call that spent the link. A value that does not open (a key that is
      // not the one that sealed it, an altered row) gives back the token with the same uniform answer; the log names the kind of error only
      if (request.resultPasswordSealed == null) throw invalidLink()
      let password: string
      try {
        password = openDsrExportPassword(this.cipher, found.id, request.resultPasswordSealed)
      } catch (error) {
        this.logger.error(
          { requestId: found.id, errorName: errorName(error) },
          'the password of a data export could not be opened'
        )
        throw invalidLink()
      }
      const url = await this.storage.downloadUrl({
        key: request.resultKey,
        contentType: ExportContentTypes.ZIP,
        filename: ComplianceConfig.DSR_EXPORT_FILENAME,
        expiresInSeconds: ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS
      })
      return { url, type: request.type, password }
    })
    if (answer === null) throw invalidLink()

    // Ids and the kind only: no address, no token, no link (the audit log outlives the file)
    this.audit.log({
      action: AuditAction.DSR_EXPORT_DOWNLOADED,
      actor: { system: true },
      storeId: found.storeId,
      organizationId: found.organizationId,
      resourceType: DsrResourceTypes.REQUEST,
      resourceId: found.id,
      metadata: { type: answer.type, via: DsrExportDownloadVia.PERSON_LINK }
    })
    return {
      url: answer.url,
      filename: ComplianceConfig.DSR_EXPORT_FILENAME,
      expiresInSeconds: ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS,
      password: answer.password
    }
  }
}
