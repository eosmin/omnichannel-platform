import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import type { Permission } from '@platform/core/auth'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  FinanceConflicts,
  FinanceResourceTypes,
  FinanceTransactionKind,
  MediaStatus
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { MediaPurpose, MediaRejectionReasons, type MediaUrls } from '@platform/core/storage'

import { MediaService } from '../media/media.service'
import type { Actor } from '../tenancy'

import type { AttachDocumentBody } from './finance.schemas'
import { requireTransactionPermission } from './finance.support'
import { type TransactionView, TRANSACTION_SELECT, transactionView } from './finance.views'

// The receipt of a transaction registered by hand (TDD_18 §2.6, §4.3). The file travels through the media pipeline like any other
// (a signed upload, the type and the bytes checked, the scan before it is served); this service ties it to the transaction. The
// file is made FOR a transaction (the parent check of the upload), and the transaction then points at it ONCE: the books are never
// edited, so another file is a new transaction. The organization is the guard's, never the body's, and a file of another
// organization is a file that does not exist.
// A row the scan ended as `unscannable` with one of the reasons of a refused PDF
function isRefusedPdf(status: string, scanResult: unknown): boolean {
  if (status !== String(MediaStatus.UNSCANNABLE)) return false
  const reason = (scanResult as { reason?: unknown } | null)?.reason
  return reason === MediaRejectionReasons.PDF_ACTIVE_CONTENT
}

@Injectable()
export class FinanceTransactionDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService
  ) {}

  async attach(
    organizationId: string,
    transactionId: string,
    body: AttachDocumentBody,
    actor: Actor,
    granted: readonly Permission[]
  ): Promise<TransactionView> {
    // Three short units, because the books belong to the organization and a file to ONE store (the route is @NoTenantTransaction: the
    // request has no context of its own):
    //  1. the transaction and every check that needs only it, in the context of the organization of the guard;
    //  2. the file, found by its id in a context of the stores of the organization: ONE read by primary key that writes nothing;
    //  3. the write, in the context of the organization AND the one store that owns the file (the store of the ROW, never one the
    //     client names): the trigger of the link reads the file under the same row policy, so it cannot see a file of another store.
    const early = await this.inOrganization(organizationId, async () => {
      const transaction = await this.prisma.client.financeTransaction.findFirst({
        where: { id: transactionId, organizationId },
        select: { id: true, kind: true, documentMediaId: true, voidedByEntryId: true }
      })
      if (transaction === null) throw resourceNotFound('finance transaction')
      requireTransactionPermission(transaction.kind as FinanceTransactionKind, granted)
      // The same file again is the same request (a double click, a lost answer): it finds the receipt and writes nothing
      if (transaction.documentMediaId === body.mediaId) {
        return this.get(organizationId, transactionId)
      }
      if (transaction.documentMediaId !== null) throw this.alreadySet()
      if (transaction.voidedByEntryId !== null) {
        throw resourceConflict('the transaction was voided already', {
          conflict: FinanceConflicts.TRANSACTION_ALREADY_VOIDED
        })
      }
      return null
    })
    if (early !== null) return early
    // A file made for THIS transaction, as a receipt, in a store of this organization: anything else is a file that is not there
    const stores = await this.prisma.client.store.findMany({
      where: { organizationId },
      select: { id: true }
    })
    const file = await this.prisma.tenantTransaction(
      { storeIds: stores.map(store => store.id), organizationIds: [] },
      () =>
        this.prisma.client.media.findFirst({
          where: {
            id: body.mediaId,
            purpose: MediaPurpose.FINANCE_DOCUMENT,
            financeTransactionId: transactionId,
            store: { organizationId }
          },
          select: { id: true, status: true, storeId: true, scanResult: true }
        })
    )
    if (file === null || file.storeId === null) throw resourceNotFound('receipt')
    // Set once: only a file the scan found clean is worth being the receipt for ever
    if (file.status !== String(MediaStatus.CLEAN)) {
      // A PDF refused for what it carries will never be clean: say so, not "wait"
      if (isRefusedPdf(file.status, file.scanResult)) {
        throw resourceConflict('the file was refused: it carries active content', {
          conflict: FinanceConflicts.TRANSACTION_DOCUMENT_REFUSED
        })
      }
      throw resourceConflict('the file is not clean yet', {
        conflict: FinanceConflicts.TRANSACTION_DOCUMENT_NOT_CLEAN
      })
    }

    let view: TransactionView | null
    try {
      view = await this.prisma.tenantTransaction(
        { storeIds: [file.storeId], organizationIds: [organizationId] },
        async () => {
          const set = await this.prisma.client.financeTransaction.updateMany({
            where: {
              id: transactionId,
              organizationId,
              documentMediaId: null,
              voidedByEntryId: null
            },
            data: { documentMediaId: body.mediaId }
          })
          // Another request set it, or voided the transaction, between the read and the write: what is there now is read apart
          return set.count === 0 ? null : await this.get(organizationId, transactionId)
        }
      )
    } catch (error) {
      // The same file cannot be the receipt of two transactions (unique), and it was made for only one
      if (isUniqueViolation(error)) throw this.alreadySet()
      // A race the checks above lost: the file went away (foreign key) or the database refused it. The answers are the typed ones
      // the checks give, never a 500 a client would retry
      const text = error instanceof Error ? error.message : ''
      if (isForeignKeyViolation(error) || text.includes('FINANCE_TRANSACTION_DOCUMENT')) {
        throw resourceNotFound('receipt')
      }
      if (text.includes('FINANCE_TRANSACTION_IMMUTABLE')) throw this.alreadySet()
      throw error
    }
    if (view === null) {
      return this.inOrganization(organizationId, () =>
        this.settled(organizationId, transactionId, body.mediaId)
      )
    }
    // After the unit is closed: the entry is written once the link is
    this.audit.log({
      action: AuditAction.FINANCE_TRANSACTION_DOCUMENT_ATTACHED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.TRANSACTION,
      resourceId: transactionId,
      metadata: { mediaId: body.mediaId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return view
  }

  private inOrganization<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.prisma.tenantTransaction({ storeIds: [], organizationIds: [organizationId] }, work)
  }

  // The signed links of the receipt: short-lived, and only once the scan found the file clean (MediaService refuses an unscanned or an
  // infected one). The books belong to the organization and a file to a store, so the file is read in ITS store, whichever store the
  // request names (the route is @NoTenantTransaction: the request has no context of its own, and this opens three short ones):
  //  1. the transaction, in the context of the organization of the guard: only the id of its receipt is read;
  //  2. the store that owns the file, found by the id of the file alone, in a context of the stores of the organization (the only
  //     place that is wide, and it holds ONE read by primary key that signs nothing);
  //  3. the signed links, in a context of that one store (the one of the ROW, never one the client names).
  // A transaction that does not exist, one of another organization, one with no receipt and a file that is not there are one and the
  // same answer. Who may read the journal is decided by the guard before any of this opens.
  async urls(
    organizationId: string,
    transactionId: string,
    granted: readonly Permission[]
  ): Promise<MediaUrls> {
    const mediaId = await this.prisma.tenantTransaction(
      { storeIds: [], organizationIds: [organizationId] },
      async () => {
        const transaction = await this.prisma.client.financeTransaction.findFirst({
          where: { id: transactionId, organizationId },
          select: { documentMediaId: true }
        })
        return transaction?.documentMediaId ?? null
      }
    )
    if (mediaId === null) throw receiptNotFound()
    // `stores` has no row policy (the guards read it with no context): the stores are those of the organization of the guard
    const stores = await this.prisma.client.store.findMany({
      where: { organizationId },
      select: { id: true }
    })
    const file = await this.prisma.tenantTransaction(
      { storeIds: stores.map(store => store.id), organizationIds: [] },
      () =>
        this.prisma.client.media.findFirst({
          where: {
            id: mediaId,
            purpose: MediaPurpose.FINANCE_DOCUMENT,
            financeTransactionId: transactionId,
            store: { organizationId }
          },
          select: { id: true, storeId: true }
        })
    )
    const ownerStoreId = file?.storeId
    if (file === null || ownerStoreId === null || ownerStoreId === undefined) {
      throw receiptNotFound()
    }
    return this.prisma.inStoreContext(ownerStoreId, () =>
      this.media.urlsFor(ownerStoreId, file.id, granted)
    )
  }

  private async get(organizationId: string, id: string): Promise<TransactionView> {
    const row = await this.prisma.client.financeTransaction.findFirst({
      where: { id, organizationId },
      select: TRANSACTION_SELECT
    })
    if (row === null) throw resourceNotFound('finance transaction')
    return transactionView(row)
  }

  // After a write that found nothing to write: what is there now decides the answer
  private async settled(
    organizationId: string,
    transactionId: string,
    mediaId: string
  ): Promise<TransactionView> {
    const now = await this.get(organizationId, transactionId)
    if (now.documentMediaId === mediaId) return now
    if (now.documentMediaId !== null) throw this.alreadySet()
    // Voided is only what the row says it is: anything else that stopped the write is a change to read and try again
    if (now.voided) {
      throw resourceConflict('the transaction was voided already', {
        conflict: FinanceConflicts.TRANSACTION_ALREADY_VOIDED
      })
    }
    throw resourceConflict('the transaction changed, read it and try again', {
      conflict: FinanceConflicts.TRANSACTION_CHANGED
    })
  }

  private alreadySet() {
    return resourceConflict('the transaction has a receipt already', {
      conflict: FinanceConflicts.TRANSACTION_DOCUMENT_ALREADY_SET
    })
  }
}

const receiptNotFound = () => resourceNotFound('receipt')

const FOREIGN_KEY_CONSTRAINT_FAILED = 'P2003'
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === FOREIGN_KEY_CONSTRAINT_FAILED
  )
}
