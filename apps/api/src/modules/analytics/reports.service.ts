import { Injectable } from '@nestjs/common'

import type { CreateReportBody, UpdateReportBody } from '@platform/core/analytics'
import { ReportLimits } from '@platform/core/analytics'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'

export interface ReportView {
  id: string
  name: string
  metrics: string[]
  frequency: string
  format: string
  recipients: string[]
  timezone: string
  sendAtHour: number
  enabled: boolean
  lastSentAt: string | null
  createdAt: string
}

const REPORT_COLUMNS = {
  id: true,
  name: true,
  metrics: true,
  frequency: true,
  format: true,
  recipients: true,
  timezone: true,
  sendAtHour: true,
  enabled: true,
  lastSentAt: true,
  createdAt: true
} as const

interface ReportRow {
  id: string
  name: string
  metrics: string[]
  frequency: string
  format: string
  recipients: string[]
  timezone: string
  sendAtHour: number
  enabled: boolean
  lastSentAt: Date | null
  createdAt: Date
}

function viewOf(row: ReportRow): ReportView {
  return {
    ...row,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  }
}

// The scheduled reports of a store (TDD_11 §7.4). A report goes out by email to the addresses it names, with the figures of the
// store, so each one runs as a person: the last who saved it, who holds the right to take the figures out (the route asks for it).
// The worker checks that again every time it runs one. Every statement filters by the store of TenantGuard.
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string): Promise<ReportView[]> {
    const rows = await this.prisma.client.scheduledReport.findMany({
      where: { storeId },
      select: REPORT_COLUMNS,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ReportLimits.MAX_PER_STORE
    })
    return rows.map(viewOf)
  }

  async create(storeId: string, userId: string, body: CreateReportBody): Promise<ReportView> {
    const created = await this.prisma.transaction(async tx => {
      // Taking turns per store: two requests at once cannot both pass the limit
      await lockStoreForWrite(tx, storeId)
      const count = await tx.scheduledReport.count({ where: { storeId } })
      if (count >= ReportLimits.MAX_PER_STORE) {
        throw new PlatformException(
          ErrorCodes.REPORT_LIMIT_REACHED,
          'the store has the most reports it may have',
          HttpStatusCodes.CONFLICT
        )
      }
      return tx.scheduledReport.create({
        data: { ...body, storeId, createdBy: userId },
        select: REPORT_COLUMNS
      })
    })
    this.record(AuditAction.REPORT_CREATED, storeId, userId, created.id, body)
    return viewOf(created)
  }

  async update(
    storeId: string,
    userId: string,
    reportId: string,
    body: UpdateReportBody
  ): Promise<ReportView> {
    const result = await this.prisma.client.scheduledReport.updateMany({
      where: { id: reportId, storeId },
      // Whoever saves a report makes it theirs: the rights that count are the ones of the last person who vouched for it
      data: { ...body, createdBy: userId }
    })
    if (result.count === 0) throw resourceNotFound('report')
    const row = await this.prisma.client.scheduledReport.findFirst({
      where: { id: reportId, storeId },
      select: REPORT_COLUMNS
    })
    if (row === null) throw resourceNotFound('report')
    this.record(AuditAction.REPORT_UPDATED, storeId, userId, reportId, body)
    return viewOf(row)
  }

  async remove(storeId: string, userId: string, reportId: string): Promise<void> {
    const result = await this.prisma.client.scheduledReport.deleteMany({
      where: { id: reportId, storeId }
    })
    if (result.count === 0) throw resourceNotFound('report')
    this.record(AuditAction.REPORT_DELETED, storeId, userId, reportId, {})
  }

  // The addresses are not kept in the log (a log outlives the report); how many there are is
  private record(
    action: (typeof AuditAction)[keyof typeof AuditAction],
    storeId: string,
    userId: string,
    reportId: string,
    body: Partial<CreateReportBody>
  ): void {
    this.audit.log({
      action,
      actor: { userId },
      storeId,
      resourceType: 'scheduled_report',
      resourceId: reportId,
      metadata: {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.recipients === undefined ? {} : { recipients: body.recipients.length }),
        ...(body.frequency === undefined ? {} : { frequency: body.frequency }),
        ...(body.format === undefined ? {} : { format: body.format }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled })
      }
    })
  }
}
