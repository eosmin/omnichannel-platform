import { Injectable } from '@nestjs/common'

import type { WebhookSource } from '@platform/core/domain'

import { PrismaService } from './prisma.service'

// Providers retry a webhook until they get a 2xx, so each event must take effect once. The marker
// row and the handler share one transaction: a handler that throws rolls the marker back, and the
// provider's retry is processed instead of being taken for a duplicate.
@Injectable()
export class ProcessedWebhookEventsService {
  constructor(private readonly prisma: PrismaService) {}

  // Runs the handler unless (source, eventId) was already processed. Returns whether it ran.
  runOnce(
    source: WebhookSource,
    eventId: string,
    type: string,
    handler: () => Promise<void>
  ): Promise<boolean> {
    return this.prisma.transaction(async tx => {
      const marked = await tx.processedWebhookEvent.createMany({
        data: [{ source, eventId, type }],
        skipDuplicates: true // ON CONFLICT DO NOTHING: a concurrent duplicate waits, then skips
      })
      if (marked.count === 0) return false
      await handler()
      return true
    })
  }
}
