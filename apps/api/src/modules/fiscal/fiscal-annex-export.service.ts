import { createHash } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { JobContext, PrismaService } from '@platform/core/database'
import { FiscalLimits, FiscalResourceTypes } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { type FiscalAnnexResult, FiscalAnnexService } from '@platform/fiscal/runtime'

import type { Actor } from '../tenancy'

import { FiscalAnnexConstancyService } from './fiscal-annex-constancy.service'
import { FiscalReachService } from './fiscal-reach.service'
import type { AnnexQuery } from './fiscal.schemas'

// The file of an annex of the periodic return (D4a), taken out of the platform: it holds the tax numbers and names of the customers of the
// whole organization, so it is only for who can read the fiscal documents of EVERY store of it (a declaration is the organization's: a
// file of the stores a person reaches would be a wrong one, and a 404 on a missing store would only hide that), it is made in the request
// and handed back to it (never kept, never cached, never logged), and each one leaves an audit row that names who, the month, the annex and
// the count of rows, never a row (and, for the purchases, what was left out of the file, and the digests that let a later change be traced).
@Injectable()
export class FiscalAnnexExportService {
  constructor(
    private readonly annexes: FiscalAnnexService,
    private readonly constancy: FiscalAnnexConstancyService,
    private readonly reach: FiscalReachService,
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly audit: AuditService
  ) {}

  async export(
    organizationId: string,
    annexId: string,
    query: AnnexQuery,
    actor: Actor
  ): Promise<FiscalAnnexResult> {
    await this.assertReachesEveryStore(organizationId, actor.userId)
    const built = await this.annexes.build(organizationId, annexId, query)
    const contentSha256 = createHash('sha256').update(built.content).digest('hex')
    // The constancia of what the file held is written before the file leaves: a file with no constancia is not handed over. A month that
    // was exported before adds what moved since (counted) to the notices
    const constancy = await this.constancy.record(
      organizationId,
      annexId,
      query,
      actor.userId,
      built,
      contentSha256
    )
    const file: FiscalAnnexResult =
      constancy === null || Object.keys(constancy.notices).length === 0
        ? built
        : { ...built, notices: { ...built.notices, ...constancy.notices } }
    this.audit.log({
      action: AuditAction.FISCAL_ANNEX_EXPORTED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.ANNEX,
      resourceId: organizationId,
      // What the audit keeps of a file: how many rows, what was left out and how many, and two digests (the bytes, and the documents it was
      // made from with the instant each was last written), never a row. A document changed after this row is found by the trail of its own change
      metadata: {
        annex: annexId,
        year: query.year,
        month: query.month,
        rows: file.rows,
        contentSha256,
        ...(constancy === null ? {} : { exportId: constancy.exportId }),
        ...(file.sourcesSha256 === undefined ? {} : { sourcesSha256: file.sourcesSha256 }),
        ...(file.notices === undefined ? {} : { notices: file.notices })
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return file
  }

  private async assertReachesEveryStore(organizationId: string, userId: string): Promise<void> {
    const [stores, reached] = await Promise.all([
      this.jobContext.inOrganization(
        organizationId,
        () =>
          this.prisma.client.store.findMany({ where: { organizationId }, select: { id: true } }),
        { maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS, timeout: FiscalLimits.CONTEXT_TIMEOUT_MS }
      ),
      this.reach.storesInUnit(organizationId, userId, Permissions.FISCAL_VIEW)
    ])
    const held = new Set(reached)
    if (stores.length === 0 || stores.some(store => !held.has(store.id))) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'the annexes of the return are for who reads the fiscal documents of every store',
        HttpStatusCodes.FORBIDDEN
      )
    }
  }
}
