import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import { RoutingActionTypes } from '@platform/core/domain'

export interface RoutingRuleInput {
  storeId: string
  name?: string
  enabled?: boolean
  // Written as given, valid or not: a suite also needs the rows the api would not have written
  conditions?: unknown
  action?: unknown
  priority?: number
}

// A rule that matches every conversation and leaves it unassigned, unless the suite says otherwise.
// The priority goes after the last one of the store.
export async function createRoutingRule(
  owner: OwnerClient,
  input: RoutingRuleInput
): Promise<{ id: string; priority: number }> {
  const priority =
    input.priority ??
    ((
      await owner.routingRule.aggregate({
        where: { storeId: input.storeId },
        _max: { priority: true }
      })
    )._max.priority ?? 0) + 1
  return owner.routingRule.create({
    data: {
      storeId: input.storeId,
      name: input.name ?? `rule-${randomUUID().slice(0, 8)}`,
      priority,
      enabled: input.enabled ?? true,
      conditions: input.conditions ?? {},
      action: input.action ?? { type: RoutingActionTypes.UNASSIGNED },
      createdBy: randomUUID()
    },
    select: { id: true, priority: true }
  })
}
