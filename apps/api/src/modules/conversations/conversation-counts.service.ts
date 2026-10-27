import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { ConversationHiddenStatuses } from '@platform/core/domain'
import { statusOf, type Viewer, visibleTo, type ConversationCounts } from '@platform/core/messaging'

// The numbers beside the filters of the inbox (TDD_09 section 2): what the viewer may see, without
// spam and archived. One grouped query over the index of the store; they are measured with the
// list (MVP_TRIM_CHECKLIST item 31) before anything is cached.
@Injectable()
export class ConversationCountsService {
  constructor(private readonly prisma: PrismaService) {}

  async counts(storeId: string, viewer: Viewer): Promise<ConversationCounts> {
    const where = {
      storeId,
      status: { notIn: [...ConversationHiddenStatuses] },
      ...visibleTo(viewer)
    }
    // One query, so that the numbers agree with each other: every figure is a sum of its groups
    const groups = await this.prisma.client.conversation.groupBy({
      by: ['status', 'channelType', 'assignedTo'],
      where,
      _count: { _all: true }
    })
    const byStatus: ConversationCounts['byStatus'] = {}
    const byChannel: ConversationCounts['byChannel'] = {}
    const perAgent = new Map<string, number>()
    let all = 0
    let unassigned = 0
    for (const group of groups) {
      const count = group._count._all
      all += count
      const status = statusOf(group.status)
      byStatus[status] = (byStatus[status] ?? 0) + count
      byChannel[group.channelType] = (byChannel[group.channelType] ?? 0) + count
      if (group.assignedTo === null) unassigned += count
      else perAgent.set(group.assignedTo, (perAgent.get(group.assignedTo) ?? 0) + count)
    }
    const byAgent: ConversationCounts['byAgent'] = [...perAgent].map(([userId, count]) => ({
      userId,
      count
    }))
    const mine = byAgent.find(agent => agent.userId === viewer.userId)?.count ?? 0
    return { all, mine, unassigned, byStatus, byChannel, byAgent }
  }
}
