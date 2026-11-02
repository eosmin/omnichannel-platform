import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import { RoutingActionTypes } from '@platform/core/domain'

// Settings → Routing: what the api answers about the rules of a store. Kept with the page and not in
// `@platform/api-client`, whose barrel the inbox loads whole.

const conditionsSchema = z.object({
  channelTypes: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  outsideBusinessHours: z.literal(true).optional()
})
export type RuleConditions = z.output<typeof conditionsSchema>

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(RoutingActionTypes.ASSIGN_USER), userIds: z.array(z.string()) }),
  z.object({ type: z.literal(RoutingActionTypes.ROUND_ROBIN), userIds: z.array(z.string()) }),
  z.object({ type: z.literal(RoutingActionTypes.UNASSIGNED) })
])
export type RuleAction = z.output<typeof actionSchema>

const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  conditions: conditionsSchema,
  action: actionSchema
})
export type RuleView = z.output<typeof ruleSchema>

// What a rule is made with. The priority is not sent: a new rule goes last, and the order is changed
// with the reorder route.
export interface RuleInput {
  name: string
  enabled: boolean
  conditions: RuleConditions
  action: RuleAction
}

const enc = encodeURIComponent

export function fetchRules(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<RuleView[]> {
  return client.request(ApiRoutes.settings.routing, {
    schema: z.array(ruleSchema),
    storeId,
    signal
  })
}

export function createRule(
  client: ApiClient,
  storeId: string,
  input: RuleInput
): Promise<RuleView> {
  return client.request(ApiRoutes.settings.routing, {
    method: 'POST',
    body: input,
    schema: ruleSchema,
    storeId
  })
}

export function updateRule(
  client: ApiClient,
  storeId: string,
  ruleId: string,
  input: Partial<RuleInput>
): Promise<RuleView> {
  return client.request(ApiRoutes.settings.routingRuleById(enc(ruleId)), {
    method: 'PATCH',
    body: input,
    schema: ruleSchema,
    storeId
  })
}

export function deleteRule(client: ApiClient, storeId: string, ruleId: string): Promise<undefined> {
  return client.request(ApiRoutes.settings.routingRuleById(enc(ruleId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// Every rule of the store, in the order they should have: the api refuses a list that leaves one out
export function reorderRules(
  client: ApiClient,
  storeId: string,
  ruleIds: string[]
): Promise<RuleView[]> {
  return client.request(ApiRoutes.settings.routingOrder, {
    method: 'PATCH',
    body: { ruleIds },
    schema: z.array(ruleSchema),
    storeId
  })
}
