import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { AuthorType, ConversationStatus, MessageType } from '@platform/core/domain'

import { startOfDayIn } from './local-day'

export interface MyPerformance {
  // The instant the day of the store started: what "today" means for the figures
  dayStart: string
  resolved: number
  open: number
  // The median first response (as the rollup keeps it) of the conversations this person answered first today, in seconds; null with none
  medianFirstResponseSeconds: number | null
  answered: number
}

// The figures of the person for the widget of the inbox (TDD_09 §8). They are read live from the conversations of the person
// (the rollups are hourly, and "today" would lag behind by up to an hour), with the same dates as the rollup uses. The
// person is the one of the token, never a value of the request.
@Injectable()
export class MyPerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async of(storeId: string, userId: string, now: Date = new Date()): Promise<MyPerformance> {
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: { timezone: true }
    })
    const dayStart = startOfDayIn(store?.timezone, now)
    const [resolved, open, response] = await Promise.all([
      this.prisma.client.conversation.count({
        where: { storeId, assignedTo: userId, resolvedAt: { gte: dayStart, lte: now } }
      }),
      this.prisma.client.conversation.count({
        where: {
          storeId,
          assignedTo: userId,
          status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] }
        }
      }),
      this.firstResponse(storeId, userId, dayStart, now)
    ])
    return {
      dayStart: dayStart.toISOString(),
      resolved,
      open,
      medianFirstResponseSeconds: response.average,
      answered: response.count
    }
  }

  // The first reply of a conversation is the first message of an agent that is not a note; it is this person's when the
  // author is them. Only the conversations whose first response came today are looked at.
  private async firstResponse(
    storeId: string,
    userId: string,
    from: Date,
    to: Date
  ): Promise<{ average: number | null; count: number }> {
    const [row] = await this.prisma.client.$queryRaw<{ average: number | null; count: number }[]>`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.first_response_at - c.created_at)))::float8 AS average, COUNT(*)::int AS count
      FROM conversations c
      JOIN LATERAL (
        SELECT m.author_id FROM messages m
        WHERE m.conversation_id = c.id AND m.store_id = ${storeId}
          AND m.author_type = ${AuthorType.AGENT} AND m.type <> ${MessageType.INTERNAL_NOTE}
        ORDER BY m.created_at ASC LIMIT 1
      ) first ON TRUE
      WHERE c.store_id = ${storeId}
        AND c.first_response_at >= ${from.toISOString()}::timestamp AND c.first_response_at <= ${to.toISOString()}::timestamp
        AND first.author_id = ${userId}`
    return { average: row?.average ?? null, count: row?.count ?? 0 }
  }
}
