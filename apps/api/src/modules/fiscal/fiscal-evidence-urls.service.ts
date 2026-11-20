import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { JobContext, PrismaService } from '@platform/core/database'
import { type FiscalEvidenceKind, FiscalLimits, FiscalResourceTypes } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { MediaPurpose, type MediaUrls } from '@platform/core/storage'
import { FiscalEvidenceService } from '@platform/fiscal/runtime'

import { MediaService } from '../media/media.service'
import type { Actor } from '../tenancy'

import { FiscalReachService } from './fiscal-reach.service'

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
    private readonly audit: AuditService,
    private readonly reach: FiscalReachService,
    private readonly jobContext: JobContext
  ) {}

  async urls(
    organizationId: string,
    documentId: string,
    kind: FiscalEvidenceKind,
    actor: Actor,
    granted: readonly Permission[]
  ): Promise<MediaUrls> {
    // The route is @NoTenantTransaction: the request is not one transaction. Making the file is committed by `keep` in units of its own
    // BEFORE the answer is decided, so the 409 of a file that is still pending its scan (a rollback of the request) can never erase it.
    const options = {
      maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
      timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
    }
    // The document is the caller's only in a store where they read the fiscal documents (another store's is a document that does not exist)
    await this.jobContext.inOrganization(
      organizationId,
      async () =>
        this.reach.assertDocuments(
          organizationId,
          [documentId],
          await this.reach.stores(organizationId, actor.userId, Permissions.FISCAL_VIEW)
        ),
      options
    )
    // A file that was never made (the bucket or the queue was down when the document was decided) is made now, from the row: the same
    // file every time. Null: the document has no such evidence, or is not the organization's.
    const kept = await this.evidence.keep(organizationId, documentId, kind)
    if (kept === null) throw resourceNotFound('fiscal evidence')
    const urls = await this.jobContext.inOrganization(
      organizationId,
      async () => {
        const file = await this.prisma.client.media.findFirst({
          where: {
            id: kept.mediaId,
            purpose: MediaPurpose.FISCAL_EVIDENCE,
            fiscalDocumentId: documentId,
            fiscalEvidenceKind: kind,
            store: { organizationId }
          },
          select: { id: true, storeId: true }
        })
        if (file === null || file.storeId === null) throw resourceNotFound('fiscal evidence')
        return this.media.urlsFor(file.storeId, file.id, granted)
      },
      options
    )
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
