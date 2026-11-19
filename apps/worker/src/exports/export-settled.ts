// rls-context: every database access of this file runs inside the JobContext that its caller opens (the generator, the expired-exports cleaner)
import type { PrismaService } from '@platform/core/database'
import type { DomainEvents } from '@platform/core/event-bus'
import type { Events } from '@platform/core/events'

import { isPluginRequester } from './export-requester'

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
  // A plugin has no screen to refresh and no inbox for a notification (the event names a person): it reads the state of its export
  if (isPluginRequester(row.requestedBy)) return
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
