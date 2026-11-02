import { Injectable } from '@nestjs/common'

import { isUniqueViolation, PrismaService } from '@platform/core/database'
import { PushLimits } from '@platform/core/notifications'

import type { PushSubscriptionBody } from './notifications.schemas'

// The browsers of a person that can receive a push (TDD_06 §7.3). A subscription belongs to the
// person and not to a store: the device is theirs in every store, and what is pushed is decided by
// the notification, which does belong to a store.
@Injectable()
export class PushSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  // The endpoint is unique to a browser. When the same browser registers under another person (a
  // shared computer, another account) the subscription moves to them: the pushes of the first one
  // must stop arriving there.
  async register(userId: string, body: PushSubscriptionBody): Promise<void> {
    try {
      await this.save(userId, body)
    } catch (error) {
      // Two requests for a new endpoint at once: the second finds the row the first made
      if (!isUniqueViolation(error)) throw error
      await this.save(userId, body)
    }
    await this.dropOldest(userId)
  }

  private async save(userId: string, body: PushSubscriptionBody): Promise<void> {
    await this.prisma.client.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: {
        userId,
        endpoint: body.endpoint,
        p256dh: body.p256dh,
        auth: body.auth,
        userAgent: body.userAgent ?? null
      },
      update: {
        userId,
        p256dh: body.p256dh,
        auth: body.auth,
        userAgent: body.userAgent ?? null,
        lastUsed: new Date()
      }
    })
  }

  // Only the subscription of this person: an endpoint that is someone else's, or nobody's, is left as
  // it is and answers the same, so the call does not tell whether it exists
  async remove(userId: string, endpoint: string): Promise<void> {
    await this.prisma.client.pushSubscription.deleteMany({ where: { userId, endpoint } })
  }

  private async dropOldest(userId: string): Promise<void> {
    const excess = await this.prisma.client.pushSubscription.findMany({
      where: { userId },
      // By last use: a browser that registers again is the newest, whatever its first date
      orderBy: [{ lastUsed: 'desc' }, { id: 'desc' }],
      skip: PushLimits.MAX_SUBSCRIPTIONS_PER_USER,
      select: { id: true }
    })
    if (excess.length === 0) return
    await this.prisma.client.pushSubscription.deleteMany({
      where: { id: { in: excess.map(row => row.id) } }
    })
  }
}
