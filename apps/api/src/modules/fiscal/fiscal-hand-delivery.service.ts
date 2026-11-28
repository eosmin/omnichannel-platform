import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { JobContext, PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  FiscalConflictReasons,
  FiscalDeliveryPending,
  FiscalDeliveryRoute,
  FiscalDeliveryStatus,
  FiscalDocumentStatus,
  FiscalEvidenceKind,
  FiscalHandMeans,
  FiscalLimits,
  FiscalResourceTypes,
  FiscalSweepLimits,
  MediaStatus,
  type HandOverFiscalDeliveryBody
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import { FiscalReachService } from './fiscal-reach.service'

// The files a receiver is given, in the order the delivery lists them
const DELIVERY_KINDS = [FiscalEvidenceKind.REPRESENTATION, FiscalEvidenceKind.DTE_FILE] as const
// What the panel is told exists: those, and the two files of the invalidation of a voided document (given by their own delivery, D13b-2b-2 B)
const LISTED_KINDS = [
  ...DELIVERY_KINDS,
  FiscalEvidenceKind.VOID_REPRESENTATION,
  FiscalEvidenceKind.VOID_DTE_FILE
] as const

// How the files of a document reached its receiver, for the panel. `pending` is a document with no row (the delivery has not run yet, or the
// event was lost: the daily check publishes it again). Never an address, never the receiver's data.
export type FiscalDeliveryState = typeof FiscalDeliveryPending | FiscalDeliveryStatus

export interface FiscalDeliveryView {
  documentId: string
  state: FiscalDeliveryState
  route: FiscalDeliveryRoute | null
  // Why the system did not send (kept when a person then gave the files by hand)
  reason: string | null
  means: FiscalHandMeans | null
  handedOverAt: string | null
  // Which files of the receiver exist: the two of the document (made while it was accepted) and the two of its invalidation (made when it is voided)
  files: FiscalEvidenceKind[]
}

const options = {
  maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
  timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
}

// The delivery of the files of a fiscal document by a person of the store: the receiver with no channel and no
// email, or who asks for the paper. The download of the files is the route of the evidence (a signed link, the permission to read the
// documents, audited); this service says which files exist and records, with the permission to manage the documents, that a person gave
// them, which closes the duty that a row NOT_SENT leaves open. There is no public link: whoever records it is a person of the store.
@Injectable()
export class FiscalHandDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly reach: FiscalReachService,
    private readonly audit: AuditService
  ) {}

  async read(
    organizationId: string,
    documentId: string,
    actor: Actor
  ): Promise<FiscalDeliveryView> {
    return this.jobContext.inOrganization(
      organizationId,
      async () => {
        await this.reach.assertDocuments(
          organizationId,
          [documentId],
          await this.reach.stores(organizationId, actor.userId, Permissions.FISCAL_VIEW)
        )
        return this.viewOf(organizationId, documentId)
      },
      options
    )
  }

  async handOver(
    organizationId: string,
    documentId: string,
    body: HandOverFiscalDeliveryBody,
    actor: Actor
  ): Promise<FiscalDeliveryView> {
    const recorded = await this.jobContext.inOrganization(
      organizationId,
      async () => {
        await this.reach.assertDocuments(
          organizationId,
          [documentId],
          await this.reach.stores(organizationId, actor.userId, Permissions.FISCAL_MANAGE)
        )
        return this.prisma.transaction(tx =>
          this.record(tx, organizationId, documentId, body, actor)
        )
      },
      options
    )
    if (recorded !== null) {
      this.audit.log({
        action: AuditAction.FISCAL_DELIVERY_HANDED_OVER,
        actor: { userId: actor.userId },
        organizationId,
        // The store of the document, which may not be the one of the header
        storeId: recorded.storeId,
        resourceType: FiscalResourceTypes.DOCUMENT,
        resourceId: documentId,
        metadata: { means: body.means },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.jobContext.inOrganization(
      organizationId,
      () => this.viewOf(organizationId, documentId),
      options
    )
  }

  // The store of the document when this call wrote the record; null for a repeat of one already recorded (the same answer, no second audit entry)
  private async record(
    tx: PrismaTransaction,
    organizationId: string,
    documentId: string,
    body: HandOverFiscalDeliveryBody,
    actor: Actor
  ): Promise<{ storeId: string } | null> {
    // The document row is locked: two people recording at once are serialized (the system delivering takes no lock: its row is written with the
    // unique key of the document, which the write below answers)
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM fiscal_documents WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`
    if (locked.length === 0) throw resourceNotFound('fiscal document')
    const document = await tx.fiscalDocument.findFirst({
      where: { id: documentId, organizationId },
      select: {
        status: true,
        storeId: true,
        orderId: true,
        updatedAt: true,
        delivery: { select: { id: true, status: true, route: true } }
      }
    })
    if (document === null) throw resourceNotFound('fiscal document')
    const { delivery } = document
    // A repeat is the same record, whatever became of the document since (the answer to a request that was lost)
    if (delivery !== null && delivery.route === String(FiscalDeliveryRoute.MANUAL)) return null
    if (document.status !== String(FiscalDocumentStatus.ACCEPTED)) {
      throw resourceConflict('the files of this document are not owed to a receiver', {
        reason: FiscalConflictReasons.DELIVERY_NOT_OWED
      })
    }
    if (delivery !== null && delivery.status === String(FiscalDeliveryStatus.SENT)) {
      throw resourceConflict('the files of this document were given to its receiver already', {
        reason: FiscalConflictReasons.ALREADY_DELIVERED
      })
    }
    // The delivery of a document accepted a moment ago is still running (its email is queued before its row is written): a person who records
    // now would give the customer the files twice. The daily check publishes the event again after the same grace.
    const graceMs = FiscalSweepLimits.DELIVERY_GRACE_MINUTES * 60_000
    if (delivery === null && Date.now() - document.updatedAt.getTime() < graceMs) {
      throw resourceConflict('the delivery of this document is still running', {
        reason: FiscalConflictReasons.DELIVERY_RUNNING
      })
    }
    const kinds = await this.kindsOf(tx, document.storeId, documentId)
    // The paper is the representation alone; handing the files over needs both
    const needed =
      body.means === FiscalHandMeans.PAPER
        ? [FiscalEvidenceKind.REPRESENTATION]
        : [...DELIVERY_KINDS]
    if (!needed.every(kind => kinds.includes(kind))) {
      throw resourceConflict('the files of this document are not there to be handed over', {
        reason: FiscalConflictReasons.DELIVERY_FILES_MISSING
      })
    }
    const now = new Date()
    const data = {
      status: FiscalDeliveryStatus.SENT,
      route: FiscalDeliveryRoute.MANUAL,
      handMeans: body.means,
      handedOverBy: actor.userId,
      handedOverAt: now
    }
    if (delivery === null) {
      // The system never delivered it (the event was lost): the person's record is the first and only one. The system writes its row without
      // this lock, so the write is the one that decides: a row that appeared in between is a delivery that happened.
      const { count } = await tx.fiscalDelivery.createMany({
        data: [
          {
            ...data,
            organizationId,
            storeId: document.storeId,
            documentId,
            orderId: document.orderId
          }
        ],
        skipDuplicates: true
      })
      if (count === 0) {
        throw resourceConflict('the files of this document were given to its receiver already', {
          reason: FiscalConflictReasons.ALREADY_DELIVERED
        })
      }
    } else {
      await tx.fiscalDelivery.update({ where: { id: delivery.id }, data })
    }
    return { storeId: document.storeId }
  }

  // The files that can be given: made, and not refused by the scan (an infected or unscannable file is never given, and the evidence route
  // serves only a clean one; one still waiting for its scan cannot be downloaded yet, so a person is not told it is there)
  private async kindsOf(
    tx: Pick<PrismaTransaction, 'media'>,
    storeId: string,
    documentId: string,
    listed: readonly FiscalEvidenceKind[] = DELIVERY_KINDS
  ): Promise<FiscalEvidenceKind[]> {
    const rows = await tx.media.findMany({
      where: {
        storeId,
        fiscalDocumentId: documentId,
        fiscalEvidenceKind: { in: [...listed] },
        status: MediaStatus.CLEAN
      },
      select: { fiscalEvidenceKind: true }
    })
    return listed.filter(kind => rows.some(row => row.fiscalEvidenceKind === String(kind)))
  }

  private async viewOf(organizationId: string, documentId: string): Promise<FiscalDeliveryView> {
    const document = await this.prisma.client.fiscalDocument.findFirst({
      where: { id: documentId, organizationId },
      select: {
        storeId: true,
        delivery: {
          select: { status: true, route: true, reason: true, handMeans: true, handedOverAt: true }
        }
      }
    })
    if (document === null) throw resourceNotFound('fiscal document')
    const { delivery } = document
    return {
      documentId,
      state: delivery === null ? FiscalDeliveryPending : (delivery.status as FiscalDeliveryStatus),
      route: delivery === null ? null : (delivery.route as FiscalDeliveryRoute),
      reason: delivery?.reason ?? null,
      means: (delivery?.handMeans as FiscalHandMeans | null | undefined) ?? null,
      handedOverAt: delivery?.handedOverAt?.toISOString() ?? null,
      files: await this.kindsOf(this.prisma.client, document.storeId, documentId, LISTED_KINDS)
    }
  }
}
