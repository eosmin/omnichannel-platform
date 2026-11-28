import { Injectable } from '@nestjs/common'

import { JobContext, PrismaService } from '@platform/core/database'
import { FiscalAnnexLocks, FiscalConflictReasons, FiscalLimits } from '@platform/core/domain'
import { resourceConflict } from '@platform/core/errors'
import type { FiscalAnnexResult } from '@platform/fiscal/runtime'

import { movedSince } from './fiscal-annex-constancy'

export interface AnnexConstancy {
  // The id of the constancia that was written
  readonly exportId: string
  // What moved since the last export of the same month, counted (never named): empty on the first export of a month
  readonly notices: Record<string, number>
}

// The constancia of an exported annex of purchases (D4b-2): which receipts of the month the file held, with the digest of what decided the
// place of each one (ids and digests, never a row, a name or a figure). It makes the document of a receipt that an export held a thing that
// cannot change quietly (the purchases refuse it, see `PurchaseReceivingService`) and it tells the accountant, on exporting the month again,
// how many receipts changed, came in or went out of the file since the last time. It is written in the same unit as the lock that the change
// of a document takes, so a change cannot pass the check between the read of the file and the write of its constancia.
@Injectable()
export class FiscalAnnexConstancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext
  ) {}

  // Nothing is kept for an annex that is not made from receipts: it returns null
  async record(
    organizationId: string,
    annexId: string,
    period: { year: number; month: number },
    userId: string,
    file: FiscalAnnexResult,
    contentSha256: string
  ): Promise<AnnexConstancy | null> {
    const digests = file.sourceDigests
    const sourcesSha256 = file.sourcesSha256
    if (digests === undefined || sourcesSha256 === undefined) return null
    return this.jobContext.inOrganization(
      organizationId,
      async () => {
        const client = this.prisma.client
        // The same named lock as lockScope (finance.support) takes, written here on the client of the unit
        const scope = FiscalAnnexLocks.constancy(organizationId)
        await client.$queryRaw`
          SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))) AS lock`
        // The file was read before this lock: a document written since (it was not held yet, so nothing refused it) would make a file that does
        // not match the books, and a constancia that says it does. The stamps of the read are checked again and the file is not handed over
        const from = new Date(Date.UTC(period.year, period.month - 1, 1))
        const until = new Date(Date.UTC(period.year, period.month, 1))
        const written = await client.purchaseReceiptDocument.findMany({
          where: { organizationId, receipt: { receivedOn: { gte: from, lt: until } } },
          select: { receiptId: true, updatedAt: true }
        })
        const stamps = new Map(written.map(row => [row.receiptId, row.updatedAt.toISOString()]))
        if (
          digests.some(digest => (stamps.get(digest.receiptId) ?? '-') !== digest.documentStamp)
        ) {
          throw resourceConflict('the receipts of the month changed while the file was made', {
            reason: FiscalConflictReasons.ANNEX_SOURCE_CHANGED
          })
        }
        const last = await client.fiscalAnnexExport.findFirst({
          where: { organizationId, annexId, year: period.year, month: period.month },
          orderBy: [{ exportedAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            contentSha256: true,
            sourcesSha256: true,
            items: { select: { receiptId: true, sourceSha256: true } }
          }
        })
        const notices = last === null ? {} : movedSince(last.items, digests)
        // The same file made from the same documents as the last export of the month: that constancia already says it. Nothing is written (the
        // rows are append-only and have no bound, so exporting again and again would only grow them) and its id is the one handed back
        if (
          last !== null &&
          last.contentSha256 === contentSha256 &&
          last.sourcesSha256 === sourcesSha256
        ) {
          return { exportId: last.id, notices }
        }
        const created = await client.fiscalAnnexExport.create({
          data: {
            organizationId,
            annexId,
            year: period.year,
            month: period.month,
            rowCount: file.rows,
            contentSha256,
            sourcesSha256,
            exportedBy: userId
          },
          select: { id: true }
        })
        if (digests.length > 0) {
          await client.fiscalAnnexExportItem.createMany({
            data: digests.map(digest => ({
              organizationId,
              exportId: created.id,
              receiptId: digest.receiptId,
              sourceSha256: digest.sha256,
              included: digest.included
            }))
          })
        }
        return { exportId: created.id, notices }
      },
      { maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS, timeout: FiscalLimits.CONTEXT_TIMEOUT_MS }
    )
  }
}
