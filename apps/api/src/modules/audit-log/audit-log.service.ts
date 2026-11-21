import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { AuditLogResourceTypes, type CursorPage } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { ExportLimits } from '@platform/core/exports'
import { type AuditLogFilters, auditLogWhere } from '@platform/core/messaging'
import { ExportFormats, ExportTypes } from '@platform/core/queues'

import { encodeCursor } from '../customers/list-cursor'
import { type ExportView, ExportsService } from '../exports'
import { type Actor, auditActorOf } from '../tenancy'

import type { ExportAuditLogQuery, ListAuditLogQuery } from './audit-log.schemas'
import { AUDIT_LOG_COLUMNS, auditLogEntryView, type AuditLogEntryView } from './audit-log.views'

// The audit log of a store, for the members who hold `org:view_audit_log`. Every query is filtered by the store of the request;
// the table is append-only and nothing here writes to it but the entry that says it was read.
@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly exports: ExportsService
  ) {}

  async list(
    storeId: string,
    actor: Actor,
    query: ListAuditLogQuery
  ): Promise<CursorPage<AuditLogEntryView>> {
    const { cursor, limit, ...filters } = query
    const rows = await this.prisma.client.auditLog.findMany({
      where: {
        ...auditLogWhere(storeId, readFilters(filters)),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { timestamp: { lt: cursor.createdAt } },
                { timestamp: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: AUDIT_LOG_COLUMNS,
      take: limit + 1,
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    // Reading the log is itself audited (TDD_05 §9.3): the first page of a reading, not every page of it, so that scrolling does not
    // fill the log with the reads of the log. The filters are ids, names of actions and instants: no text of a person.
    if (cursor === undefined) {
      this.audit.log({
        action: AuditAction.AUDIT_LOG_VIEWED,
        actor: auditActorOf(actor),
        storeId,
        resourceType: AuditLogResourceTypes.AUDIT_LOG,
        metadata: { filters },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return {
      data: page.map(row => auditLogEntryView(row)),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.timestamp, id: last.id })
          : null,
      hasMore
    }
  }

  // One entry of the store. An entry of another store, one with no store and one that does not exist are the same 404.
  async get(storeId: string, actor: Actor, id: string): Promise<AuditLogEntryView> {
    const row = await this.prisma.client.auditLog.findFirst({
      where: { id, storeId },
      select: AUDIT_LOG_COLUMNS
    })
    if (row === null) throw resourceNotFound('audit log entry')
    this.audit.log({
      action: AuditAction.AUDIT_LOG_VIEWED,
      actor: auditActorOf(actor),
      storeId,
      resourceType: AuditLogResourceTypes.AUDIT_LOG,
      resourceId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return auditLogEntryView(row)
  }

  // The file is made in the background by the worker, which writes `audit_log.exported` when it is ready
  async requestExport(
    storeId: string,
    userId: string,
    query: ExportAuditLogQuery
  ): Promise<ExportView> {
    // The file holds the log as it was when it was asked for: with no end, the end is now, or the rows written while the job
    // waits in the queue (the reads of the log among them) would be in it
    const filters = { ...query, before: query.before ?? new Date().toISOString() }
    const rows = await this.prisma.client.auditLog.count({
      where: auditLogWhere(storeId, readFilters(filters))
    })
    if (rows > ExportLimits.AUDIT_LOG_MAX_ROWS) {
      throw new PlatformException(
        ErrorCodes.EXPORT_TOO_LARGE,
        'the audit log of that range is larger than one file: narrow the dates',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    return this.exports.request({
      storeId,
      userId,
      type: ExportTypes.AUDIT_LOG,
      format: ExportFormats.CSV,
      filters
    })
  }
}

// The days arrive as ISO text and the rule of the database reads dates
function readFilters(query: ExportAuditLogQuery): AuditLogFilters {
  return {
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.userId === undefined ? {} : { userId: query.userId }),
    ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
    ...(query.resourceId === undefined ? {} : { resourceId: query.resourceId }),
    ...(query.from === undefined ? {} : { from: new Date(query.from) }),
    ...(query.before === undefined ? {} : { before: new Date(query.before) })
  }
}
