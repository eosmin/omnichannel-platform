import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { ageInDays, RemittableCodStatuses } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'
import { readRemittancePreferences } from '@platform/core/store-preferences'

const DAY_MS = 24 * 60 * 60 * 1000
// The warning of a connection is said at most once in this many days (TDD_17 §4.15)
const REPEAT_AFTER_DAYS = 7

// The daily check of the cash on delivery that the carriers of one store still owe (TDD_17 §4.15): a connection with shipments
// that were delivered longer ago than the store allows (`remittances.overdueAfterDays`) and are still waiting for a remittance,
// or whose last one differed, raises `remittance.overdue` through the event bus, and the api tells the team. A connection that
// was already warned about in the last week is left alone, so the team hears of it weekly and not every day.
@Injectable()
export class RemittanceChecker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(RemittanceChecker.name)
  }

  // Returns how many connections were announced
  async check(storeId: string, now: Date): Promise<number> {
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    const { overdueAfterDays } = readRemittancePreferences(settings?.preferences)
    const cutoff = new Date(now.getTime() - overdueAfterDays * DAY_MS)
    const shipments = await this.prisma.client.shipment.findMany({
      where: {
        storeId,
        codStatus: { in: [...RemittableCodStatuses] },
        deliveredAt: { lt: cutoff }
      },
      select: {
        connectionId: true,
        codExpectedCents: true,
        codRemittedCents: true,
        deliveredAt: true
      }
    })
    // What is owed is added shipment by shipment, each one never below zero: a carrier that overpaid one package does not
    // cancel what it still owes for another
    const groups = new Map<string, { count: number; owed: number; oldest: Date | null }>()
    for (const shipment of shipments) {
      const group = groups.get(shipment.connectionId) ?? { count: 0, owed: 0, oldest: null }
      group.count += 1
      group.owed += Math.max(0, (shipment.codExpectedCents ?? 0) - (shipment.codRemittedCents ?? 0))
      if (
        shipment.deliveredAt !== null &&
        (group.oldest === null || shipment.deliveredAt < group.oldest)
      ) {
        group.oldest = shipment.deliveredAt
      }
      groups.set(shipment.connectionId, group)
    }
    let announced = 0
    for (const [connectionId, group] of groups) {
      const oldest = group.oldest
      if (oldest === null) continue
      const warned = await this.prisma.client.notification.findFirst({
        where: {
          storeId,
          type: NotificationTypes.REMITTANCE_OVERDUE,
          resourceId: connectionId,
          createdAt: { gte: new Date(now.getTime() - REPEAT_AFTER_DAYS * DAY_MS) }
        },
        select: { id: true }
      })
      if (warned !== null) continue
      // Published inside a transaction: the bus announces it once it commits
      await this.prisma.transaction(tx => {
        this.events.publish(tx, Events.REMITTANCE_OVERDUE, {
          storeId,
          connectionId,
          count: group.count,
          overdueAfterDays,
          oldestAgeDays: ageInDays(oldest, now),
          totalOwedCents: group.owed
        })
        return Promise.resolve()
      })
      announced += 1
    }
    if (announced > 0) this.logger.info({ storeId, announced }, 'overdue remittances announced')
    return announced
  }
}
