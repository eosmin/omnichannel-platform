import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import {
  FiscalAnnexLimits,
  FiscalConflictReasons,
  FiscalDocumentStatus,
  FiscalLimits,
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
  type FiscalAnnexPeriod
} from '@platform/fiscal/sdk'

import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { record, toJson } from './json'
import { openSealed } from './sealed-open'

export type { FiscalAnnexFile } from '@platform/fiscal/sdk'

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
  ): Promise<FiscalAnnexFile> {
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
  ): Promise<FiscalAnnexFile> {
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
    const documents = await this.documentsAround(organizationId, issuer.providerId, period)
    try {
      const file = exporter.build(annexId, period, documents)
      if (file === null) throw resourceNotFound('fiscal annex')
      return file
    } catch (error) {
      if (error instanceof FiscalAnnexError) {
        throw resourceConflict('the annex cannot be made from the documents of the month', {
          reason: FiscalConflictReasons.ANNEX_REFUSED,
          code: error.code
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
