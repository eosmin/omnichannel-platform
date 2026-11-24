import { Inject, Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  DsrResourceTypes
} from '@platform/core/compliance'
import { hashToken } from '@platform/core/crypto'
import { contextOf, PrismaService, resolveDsrExportDownload } from '@platform/core/database'
import { DsrStatus, DsrType, VerificationTokenType } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { ExportContentTypes } from '@platform/core/exports'
import { StorageService } from '@platform/core/storage-module'

import type { DsrExportDownloadBody } from './compliance.schemas'

export interface DsrExportDownloadAnswer {
  url: string
  filename: string
  expiresInSeconds: number
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
    @Inject(DSR_CONFIG) private readonly config: DsrConfig
  ) {}

  async download(body: DsrExportDownloadBody): Promise<DsrExportDownloadAnswer> {
    if (!this.config.enabled) throw invalidLink()
    const tokenHash = hashToken(body.token)
    // The request is found by the hash of the token, before there is a context; its rows are touched only inside the context it opens
    const found = await resolveDsrExportDownload(this.prisma.client, tokenHash)
    if (found === null) throw invalidLink()

    const answer = await this.prisma.tenantTransaction(contextOf(found), async () => {
      // The claim: exactly one caller flips an unused, unexpired token. A second click, or a scanner racing the person, finds nothing.
      const claimed = await this.prisma.client.verificationToken.updateMany({
        where: {
          tokenHash,
          type: VerificationTokenType.DSR_EXPORT_DOWNLOAD,
          subject: found.id,
          usedAt: null,
          expiresAt: { gt: new Date() }
        },
        data: { usedAt: new Date() }
      })
      if (claimed.count !== 1) return null
      const request = await this.prisma.client.dataSubjectRequest.findFirst({
        where: {
          id: found.id,
          storeId: found.storeId,
          type: { in: [...EXPORT_TYPES] },
          status: DsrStatus.COMPLETED,
          resultKey: { not: null },
          resultExpiresAt: { gt: new Date() }
        },
        select: { resultKey: true, type: true }
      })
      // The file went between the lookup and the claim: the token is not spent for a file that is not there (the throw rolls the claim back)
      if (request?.resultKey == null) throw invalidLink()
      const url = await this.storage.downloadUrl({
        key: request.resultKey,
        contentType: ExportContentTypes.ZIP,
        filename: ComplianceConfig.DSR_EXPORT_FILENAME,
        expiresInSeconds: ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS
      })
      return { url, type: request.type }
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
      metadata: { type: answer.type, via: 'person_link' }
    })
    return {
      url: answer.url,
      filename: ComplianceConfig.DSR_EXPORT_FILENAME,
      expiresInSeconds: ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS
    }
  }
}
