import { z } from 'zod'

import {
  ChannelType,
  plainText,
  RoutingActionTypes,
  RoutingLimits,
  singleLineText,
  uuidSchema
} from '@platform/core/domain'

export const idSchema = uuidSchema

const unique = (items: readonly unknown[]): boolean => new Set(items).size === items.length

// An id has one spelling in the row: the same tag in capitals is the same tag
const lowerUuid = uuidSchema.transform(id => id.toLowerCase())

// All the conditions that are present must hold (AND); each list holds when any of its items does.
// A rule with no condition matches every conversation, which is how a "catch-all" is written.
export const conditionsSchema = z.strictObject({
  channelTypes: z
    .array(z.enum(ChannelType))
    .min(1)
    .max(RoutingLimits.MAX_CHANNEL_TYPES)
    .refine(unique, { message: 'a channel is listed once' })
    .optional(),
  // The tags of the customer: a conversation has none when it arrives
  tagIds: z
    .array(lowerUuid)
    .min(1)
    .max(RoutingLimits.MAX_TAGS)
    .refine(unique, { message: 'a tag is listed once' })
    .optional(),
  keywords: z
    .array(
      singleLineText(RoutingLimits.KEYWORD_MAX_LENGTH, 1).refine(
        keyword => plainText(keyword) !== '',
        // Compared as plain text it would be empty, and an empty word is found in every message
        { message: 'has no letter, digit or symbol to look for' }
      )
    )
    .min(1)
    .max(RoutingLimits.MAX_KEYWORDS)
    .optional(),
  // Only "true" is a condition: a rule that must match inside the hours is a rule with no condition
  outsideBusinessHours: z.literal(true).optional()
})

export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal(RoutingActionTypes.ASSIGN_USER),
    userIds: z.array(lowerUuid).length(1)
  }),
  z.strictObject({
    type: z.literal(RoutingActionTypes.ROUND_ROBIN),
    userIds: z
      .array(lowerUuid)
      .min(RoutingLimits.MIN_USERS_FOR_ROUND_ROBIN)
      .max(RoutingLimits.MAX_USERS_PER_ACTION)
      .refine(unique, { message: 'a person is listed once' })
  }),
  z.strictObject({ type: z.literal(RoutingActionTypes.UNASSIGNED) })
])

const ruleName = singleLineText(RoutingLimits.NAME_MAX_LENGTH, 1)

// The priority is not sent: a new rule goes last and the order is changed with the reorder route
export const createRuleSchema = z.strictObject({
  name: ruleName,
  enabled: z.boolean().default(true),
  conditions: conditionsSchema,
  action: actionSchema
})

export const updateRuleSchema = z
  .strictObject({
    name: ruleName.optional(),
    enabled: z.boolean().optional(),
    conditions: conditionsSchema.optional(),
    action: actionSchema.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

// Every rule of the store, in the new order
export const reorderSchema = z.strictObject({
  ruleIds: z
    .array(lowerUuid)
    .min(1)
    .max(RoutingLimits.MAX_RULES_PER_STORE)
    .refine(unique, { message: 'a rule is listed once' })
})

export type RoutingConditions = z.output<typeof conditionsSchema>
export type RoutingAction = z.output<typeof actionSchema>
export type CreateRuleBody = z.output<typeof createRuleSchema>
export type UpdateRuleBody = z.output<typeof updateRuleSchema>
export type ReorderBody = z.output<typeof reorderSchema>
