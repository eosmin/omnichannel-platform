import { createHash } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import {
  FiscalAnnexLimits,
  FiscalAnnexNotices,
  FiscalAnnexRefusals,
  FiscalConflictReasons,
  FiscalDocumentStatus,
  FiscalLimits,
  PurchaseLimits,
  SealedValueKind
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import {
  FiscalAnnexError,
  type FiscalAnnexDocument,
  type FiscalAnnexFile,
  type FiscalAnnexPeriod,
  type FiscalAnnexPurchase
} from '@platform/fiscal/sdk'

import { splitReceiptLines } from './fiscal-annex-purchase-lines'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { record, toJson } from './json'
import { openSealed } from './sealed-open'

export type { FiscalAnnexFile } from '@platform/fiscal/sdk'

// What the service gives back: the file and, for an annex made from the receipts of purchases, a digest of the documents it was made from
// (their ids and the instant each was last written), so the audit row can say later whether a document changed after the file was taken
export interface FiscalAnnexResult extends FiscalAnnexFile {
  readonly sourcesSha256?: string
  // The same digests receipt by receipt (the constancia of an export keeps them: ids and digests, never a row)
  readonly sourceDigests?: readonly FiscalAnnexSourceDigest[]
}

export interface FiscalAnnexSourceDigest {
  readonly receiptId: string
  readonly sha256: string
  // Whether the receipt went into the file (false: left out on purpose, or with no document and no credit)
  readonly included: boolean
  // When its document was last written (an ISO instant), or '-' when it has none: the export checks it again under its lock
  readonly documentStamp: string
}

// The organizations making an annex in this process: one at a time each
const making = new Set<string>()

const DAY_MS = 24 * 60 * 60 * 1000

// The annexes of the periodic return of the country of the issuer's provider (D4a): the file of a month made from the documents the
// provider accepted for the ORGANIZATION (every store: a declaration is the organization's, never a store's). Core only reads the documents
// and opens their sealed copy; which month a document belongs to, which column holds what and how the file is written are the provider's
// (`FiscalAnnexExporter`). The file holds customer data (tax numbers and names), so it is made in the request that asked for it and
// handed back to it: nothing of it is stored, cached or logged, and a document that cannot be read refuses the file, never leaves a hole.
@Injectable()
export class FiscalAnnexService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext,
    private readonly registry: FiscalProviderRegistry
  ) {
    this.logger.setContext(FiscalAnnexService.name)
  }

  // Each read is one short unit in the context of the whole organization (RLS reads the rows of every store of it)
  private unit<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.jobContext.inOrganizationOrRequest(organizationId, work, {
      maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
      timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
    })
  }

  // The file of one annex of a month, or a 404 when the issuer's provider has no such annex (or the organization has no issuer)
  async build(
    organizationId: string,
    annexId: string,
    period: FiscalAnnexPeriod
  ): Promise<FiscalAnnexResult> {
    if (making.has(organizationId)) {
      throw resourceConflict('an annex of the organization is being made', {
        reason: FiscalConflictReasons.ANNEX_IN_PROGRESS
      })
    }
    making.add(organizationId)
    try {
      return await this.buildOnce(organizationId, annexId, period)
    } finally {
      making.delete(organizationId)
    }
  }

  private async buildOnce(
    organizationId: string,
    annexId: string,
    period: FiscalAnnexPeriod
  ): Promise<FiscalAnnexResult> {
    const issuer = await this.unit(organizationId, () =>
      this.prisma.client.fiscalIssuer.findUnique({
        where: { organizationId },
        select: { providerId: true }
      })
    )
    if (issuer === null) throw resourceNotFound('fiscal annex')
    const provider = this.registry.find(issuer.providerId)
    const exporter = provider?.annexes
    if (exporter === undefined || !exporter.ids.includes(annexId)) {
      throw resourceNotFound('fiscal annex')
    }
    const purchaseAnnex = exporter.purchaseIds?.includes(annexId) === true
    const documents = purchaseAnnex
      ? []
      : await this.documentsAround(organizationId, issuer.providerId, period)
    const read = purchaseAnnex ? await this.purchasesOf(organizationId, period) : null
    try {
      const file = purchaseAnnex
        ? (exporter.buildPurchases?.(annexId, period, read?.purchases ?? []) ?? null)
        : exporter.build(annexId, period, documents)
      if (file === null) throw resourceNotFound('fiscal annex')
      if (read === null) return file
      return {
        ...file,
        notices: read.notices,
        sourcesSha256: read.sourcesSha256,
        sourceDigests: read.sourceDigests
      }
    } catch (error) {
      if (error instanceof FiscalAnnexError) {
        throw resourceConflict('the annex cannot be made from the documents of the month', {
          reason: FiscalConflictReasons.ANNEX_REFUSED,
          code: error.code,
          ...(error.refs.length === 0 ? {} : refsOf(error.refs))
        })
      }
      throw error
    }
  }

  // The accepted and the voided documents issued or voided around the month, opened, in order of id, a page at a time. The window is wider
  // than the month because the month is the provider's (its civil time): the provider keeps what belongs to it.
  private async documentsAround(
    organizationId: string,
    providerId: string,
    period: FiscalAnnexPeriod
  ): Promise<FiscalAnnexDocument[]> {
    // A month that has not started is no declaration (an empty file that looks like one): the current month may be asked for, partial
    if (Date.UTC(period.year, period.month - 1, 1) - DAY_MS > Date.now()) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'the month has not started',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const pad = FiscalAnnexLimits.WINDOW_PAD_DAYS * DAY_MS
    const window = {
      gte: new Date(Date.UTC(period.year, period.month - 1, 1) - pad),
      lt: new Date(Date.UTC(period.year, period.month, 1) + pad)
    }
    const documents: FiscalAnnexDocument[] = []
    let after: string | undefined
    for (;;) {
      const page = await this.unit(organizationId, () =>
        this.prisma.client.fiscalDocument.findMany({
          where: {
            organizationId,
            providerId,
            status: { in: [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.VOIDED] },
            // An accepted row with no issue instant is read by the day it was made
            OR: [{ issuedAt: window }, { voidedAt: window }, { issuedAt: null, createdAt: window }]
          },
          orderBy: { id: 'asc' },
          take: FiscalAnnexLimits.PAGE_SIZE,
          ...(after === undefined ? {} : { cursor: { id: after }, skip: 1 }),
          select: {
            id: true,
            documentType: true,
            externalNumber: true,
            providerData: true,
            builtPayloadEncrypted: true,
            issuedAt: true,
            voidedAt: true,
            createdAt: true
          }
        })
      )
      // Before the pages are opened: the memory the file takes never goes past the cap
      if (documents.length + page.length > FiscalAnnexLimits.MAX_DOCUMENTS) {
        throw new PlatformException(
          ErrorCodes.EXPORT_TOO_LARGE,
          'the annex would be made from more documents than one file: narrow the month',
          HttpStatusCodes.BAD_REQUEST
        )
      }
      for (const row of page) {
        // A document accepted always has its sealed copy: one that cannot be opened refuses the file (a declaration with a hole is wrong)
        const payload = this.opened(row.id, row.builtPayloadEncrypted)
        documents.push({
          documentType: row.documentType,
          externalNumber: row.externalNumber,
          providerData: row.providerData === null ? null : record(toJson(row.providerData)),
          payload,
          issuedAt: row.issuedAt ?? row.createdAt,
          voidedAt: row.voidedAt
        })
      }
      const last = page.at(-1)
      if (page.length < FiscalAnnexLimits.PAGE_SIZE || last === undefined) return documents
      after = last.id
    }
  }

  // The receipts of the purchases that arrived in the month, in the organization (every store: a return is the organization's), read a page
  // at a time and never past the cap. A receipt is declared when the supplier's document was written for it; one marked as left out, or one with no
  // document that credits no tax, is only counted; any other is a refusal that lists how many and the first ones, so the staff completes them.
  private async purchasesOf(
    organizationId: string,
    period: FiscalAnnexPeriod
  ): Promise<{
    purchases: FiscalAnnexPurchase[]
    notices: Record<string, number>
    sourcesSha256: string
    sourceDigests: FiscalAnnexSourceDigest[]
  }> {
    const from = new Date(Date.UTC(period.year, period.month - 1, 1))
    const until = new Date(Date.UTC(period.year, period.month, 1))
    // A month that has not started is no declaration: the same rule as for the documents
    if (from.getTime() - DAY_MS > Date.now()) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'the month has not started',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const purchases: FiscalAnnexPurchase[] = []
    const sources: string[] = []
    const sourceDigests: FiscalAnnexSourceDigest[] = []
    const missing: string[] = []
    const inconsistent: string[] = []
    const notices: Record<string, number> = {}
    const count = (code: string): void => {
      notices[code] = (notices[code] ?? 0) + 1
    }
    let read = 0
    let after: string | undefined
    for (;;) {
      const page = await this.unit(organizationId, () =>
        this.prisma.client.purchaseReceipt.findMany({
          where: { organizationId, receivedOn: { gte: from, lt: until } },
          orderBy: { id: 'asc' },
          take: FiscalAnnexLimits.PAGE_SIZE,
          ...(after === undefined ? {} : { cursor: { id: after }, skip: 1 }),
          select: {
            id: true,
            receivedOn: true,
            supplierDocumentNumber: true,
            taxCreditable: true,
            subtotalCents: true,
            taxCents: true,
            supplier: { select: { name: true, taxId: true } },
            lines: { select: { subtotalCents: true, taxCents: true } },
            document: {
              select: {
                issuedOn: true,
                documentClass: true,
                documentType: true,
                generationCode: true,
                purchaseOrigin: true,
                expenseClass: true,
                sector: true,
                costType: true,
                annexExclusion: true,
                updatedAt: true
              }
            }
          }
        })
      )
      // Before the page is used: the memory the file takes never goes past the cap
      read += page.length
      if (read > FiscalAnnexLimits.MAX_DOCUMENTS) {
        throw new PlatformException(
          ErrorCodes.EXPORT_TOO_LARGE,
          'the annex would be made from more documents than one file: narrow the month',
          HttpStatusCodes.BAD_REQUEST
        )
      }
      for (const row of page) {
        const doc = row.document
        // The digest covers every receipt of the month with what decides its place in the file (the document and when it was written, the
        // mark, the money, the supplier), the ones left out too, so any change after a file was taken makes another digest
        const source = [
          row.id,
          doc?.updatedAt.toISOString() ?? '-',
          doc?.annexExclusion ?? '-',
          row.subtotalCents,
          row.taxCents,
          row.supplier.name,
          row.supplier.taxId ?? '-'
        ].join('|')
        sources.push(source)
        const digest: FiscalAnnexSourceDigest = {
          receiptId: row.id,
          sha256: createHash('sha256').update(source).digest('hex'),
          included: false,
          documentStamp: doc?.updatedAt.toISOString() ?? '-'
        }
        sourceDigests.push(digest)
        if (doc?.annexExclusion != null) {
          count(FiscalAnnexNotices.LEFT_OUT)
          if (row.supplierDocumentNumber !== null) count(FiscalAnnexNotices.LEFT_OUT_WITH_DOCUMENT)
          continue
        }
        if (doc === null) {
          if (row.supplierDocumentNumber === null && !row.taxCreditable && row.taxCents === 0) {
            count(FiscalAnnexNotices.NO_DOCUMENT_NO_CREDIT)
          } else {
            missing.push(row.id)
          }
          continue
        }
        if (doc.issuedOn === null || doc.documentClass === null || doc.documentType === null) {
          missing.push(row.id)
          continue
        }
        // The lines are what the ledger posted: they add up to the receipt, or the receipt is not read
        const split = splitReceiptLines(row.lines, row)
        if (split === null) {
          inconsistent.push(row.id)
          continue
        }
        const day = (date: Date): string => date.toISOString().slice(0, 10)
        sourceDigests[sourceDigests.length - 1] = { ...digest, included: true }
        purchases.push({
          receiptId: row.id,
          receivedOn: day(row.receivedOn),
          supplierName: row.supplier.name,
          supplierTaxId: row.supplier.taxId,
          documentNumber: row.supplierDocumentNumber,
          taxCreditable: row.taxCreditable,
          taxedBaseCents: split.taxedBaseCents,
          taxedLines: split.taxedLines,
          taxCents: split.taxCents,
          exemptBaseCents: split.exemptBaseCents,
          document: {
            issuedOn: day(doc.issuedOn),
            receivedOn: day(row.receivedOn),
            documentClass: doc.documentClass,
            documentType: doc.documentType,
            generationCode: doc.generationCode,
            documentNumber: row.supplierDocumentNumber,
            origin: doc.purchaseOrigin ?? '',
            expenseClass: doc.expenseClass ?? '',
            sector: doc.sector ?? '',
            costType: doc.costType ?? ''
          }
        })
      }
      const last = page.at(-1)
      if (page.length < FiscalAnnexLimits.PAGE_SIZE || last === undefined) break
      after = last.id
    }
    for (const [code, ids] of [
      [FiscalAnnexRefusals.PURCHASE_DOCUMENT_MISSING, missing],
      [FiscalAnnexRefusals.PURCHASE_LINES_INCONSISTENT, inconsistent]
    ] as const) {
      if (ids.length > 0) {
        throw resourceConflict('the annex cannot be made from the receipts of the month', {
          reason: FiscalConflictReasons.ANNEX_REFUSED,
          code,
          ...refsOf(ids)
        })
      }
    }
    sources.sort()
    return {
      purchases,
      notices,
      sourcesSha256: createHash('sha256').update(sources.join('\n')).digest('hex'),
      sourceDigests
    }
  }

  private opened(documentId: string, sealed: Uint8Array | null): Record<string, unknown> {
    // A copy that cannot be opened is handed over as an empty one: the provider refuses the month if the document belongs to it (a
    // declaration with a hole is wrong) and ignores it if it belongs to a neighbouring month the window read
    if (sealed === null) return {}
    let payload: Record<string, unknown>
    try {
      payload = openSealed(this.cipher, this.logger, sealed, SealedValueKind.BUILT_PAYLOAD, {
        documentId
      })
    } catch {
      return {}
    }
    return payload['unreadable'] === true ? {} : record(toJson(payload))
  }
}

// How many receipts a refusal names and the first ones by id: an id is no personal data, so the staff can find them, and the list is
// bounded so an answer never carries a month
const refsOf = (ids: readonly string[]): { count: number; ids: string[] } => ({
  count: ids.length,
  ids: [...ids].sort().slice(0, PurchaseLimits.ANNEX_MISSING_LISTED)
})
