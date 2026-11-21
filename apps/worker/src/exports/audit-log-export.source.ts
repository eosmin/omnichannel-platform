// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one page or count; the file is written to the bucket outside of it
import type { JobContext, PrismaService } from '@platform/core/database'
import { ExportLimits } from '@platform/core/exports'
import { type AuditLogExportFilters, auditLogWhere } from '@platform/core/messaging'

import type { CsvSource } from './csv-export-writer'

// The audit log CSV (Step 7.2). One row per entry of the store, newest first. The columns are the ones of the viewer: ids,
// the action, the instant and the metadata as JSON text (counts and ids, the code writes no name or text of a person into it).
// The store and the organization stay out of the file: they are the requester's own.
export const AUDIT_LOG_COLUMNS = [
  'id',
  'timestamp',
  'action',
  'user_id',
  'resource_type',
  'resource_id',
  'ip_address',
  'user_agent',
  'metadata'
] as const

export function auditLogExportSource(
  prisma: PrismaService,
  jobContext: JobContext,
  storeId: string,
  filters: AuditLogExportFilters
): CsvSource {
  const where = auditLogWhere(storeId, {
    ...(filters.action === undefined ? {} : { action: filters.action }),
    ...(filters.userId === undefined ? {} : { userId: filters.userId }),
    ...(filters.resourceType === undefined ? {} : { resourceType: filters.resourceType }),
    ...(filters.resourceId === undefined ? {} : { resourceId: filters.resourceId }),
    ...(filters.from === undefined ? {} : { from: new Date(filters.from) }),
    ...(filters.before === undefined ? {} : { before: new Date(filters.before) })
  })
  return {
    columns: AUDIT_LOG_COLUMNS,
    count: () => jobContext.forStore(storeId, () => prisma.client.auditLog.count({ where })),
    rows: async function* () {
      // Keyset on the order of the viewer (newest first): a row can never be deleted from this table by the application, and the
      // cold export removes only rows older than the hot window, so the file is not cut short by a deletion meanwhile
      let after: { timestamp: Date; id: string } | undefined
      for (;;) {
        const entries = await jobContext.forStore(storeId, () =>
          prisma.client.auditLog.findMany({
            where: {
              ...where,
              ...(after === undefined
                ? {}
                : {
                    OR: [
                      { timestamp: { lt: after.timestamp } },
                      { timestamp: after.timestamp, id: { lt: after.id } }
                    ]
                  })
            },
            orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
            take: ExportLimits.ROW_PAGE_SIZE,
            select: {
              id: true,
              timestamp: true,
              action: true,
              userId: true,
              resourceType: true,
              resourceId: true,
              ipAddress: true,
              userAgent: true,
              metadata: true
            }
          })
        )
        const last = entries.at(-1)
        if (last === undefined) return
        after = { timestamp: last.timestamp, id: last.id }
        for (const entry of entries) {
          yield [
            entry.id,
            entry.timestamp,
            entry.action,
            entry.userId,
            entry.resourceType,
            entry.resourceId,
            entry.ipAddress,
            entry.userAgent,
            entry.metadata === null ? null : JSON.stringify(entry.metadata)
          ]
        }
      }
    }
  }
}
