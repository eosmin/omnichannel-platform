import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import type { Permission } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { type FiscalEvidenceKind, FiscalResourceTypes } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { MediaPurpose, type MediaUrls } from '@platform/core/storage'
import { FiscalEvidenceService } from '@platform/fiscal/runtime'

import { MediaService } from '../media/media.service'
import type { Actor } from '../tenancy'

// The signed link of a file of evidence of a fiscal document (TDD_18 §8.3, Step 4B.7b-2). The file holds the receiver's data, so it is
// served only to who reads the fiscal documents (the route's permission, and `MediaService` asks for it again by the purpose of the file),
// only once the scan found it clean, short-lived, and only for a document of the caller's ORGANIZATION: a document or a file of another
// organization is a file that does not exist. The file is read in ITS store, whichever store the request names: the documents belong to
// the organization. Every link given is audited (who read what).
@Injectable()
export class FiscalEvidenceUrlsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: FiscalEvidenceService,
    private readonly media: MediaService,
    private readonly audit: AuditService
  ) {}

  async urls(
    organizationId: string,
    documentId: string,
    kind: FiscalEvidenceKind,
    actor: Actor,
    granted: readonly Permission[]
  ): Promise<MediaUrls> {
    // A file that was never made (the bucket or the queue was down when the document was decided) is made now, from the row: the same
    // file every time. Null: the document has no such evidence, or is not the organization's.
    const kept = await this.evidence.keep(organizationId, documentId, kind)
    if (kept === null) throw resourceNotFound('fiscal evidence')
    const file = await this.prisma.client.media.findFirst({
      where: {
        id: kept.mediaId,
        purpose: MediaPurpose.FISCAL_EVIDENCE,
        fiscalDocumentId: documentId,
        store: { organizationId }
      },
      select: { id: true, storeId: true }
    })
    if (file === null || file.storeId === null) throw resourceNotFound('fiscal evidence')
    const urls = await this.media.urlsFor(file.storeId, file.id, granted)
    this.audit.log({
      action: AuditAction.FISCAL_EVIDENCE_READ,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: documentId,
      metadata: { kind },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return urls
  }
}
