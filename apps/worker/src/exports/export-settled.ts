import type { PrismaService } from '@platform/core/database'
import type { DomainEvents } from '@platform/core/event-bus'
import type { Events } from '@platform/core/events'

export interface SettledExportRow {
  id: string
  storeId: string
  requestedBy: string
  type: string
}

// Tells the api that an export settled: ids and the kind only. After the commit, like any domain event.
export async function publishExportSettled(
  prisma: PrismaService,
  events: DomainEvents,
  event: typeof Events.EXPORT_READY | typeof Events.EXPORT_FAILED,
  row: SettledExportRow
): Promise<void> {
  await prisma.transaction(tx =>
    Promise.resolve(
      events.publish(tx, event, {
        storeId: row.storeId,
        exportId: row.id,
        requestedBy: row.requestedBy,
        exportType: row.type
      })
    )
  )
}
