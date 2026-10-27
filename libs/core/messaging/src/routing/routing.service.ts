import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { Permissions } from '@platform/core/auth'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  ConversationStatus,
  isWithinSchedule,
  MembershipStatus,
  plainText,
  RoutingActionTypes,
  RoutingLimits,
  weekScheduleSchema
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import { ConversationsService } from '../conversations/conversations.service'

import {
  actionSchema,
  conditionsSchema,
  type RoutingAction,
  type RoutingConditions
} from './routing.schemas'

// What the pipeline knows that the conversation does not: what was said, and when. The channel and
// the customer are read from the conversation, which is the one that says where it sits (after a
// merge its customer is the survivor, not the one the message was matched to).
export interface RoutingContext {
  // The first message of the conversation, when it has text
  text: string | null
  receivedAt: Date
}

export interface RoutingOutcome {
  // The rule that decided, or null when none did (or the conversation already had an owner)
  ruleId: string | null
  assignedTo: string | null
}

interface Arriving {
  channelType: string
  customerId: string
}

// Decides who gets a new conversation. It is called by the inbound pipeline (Step 2.6), once per
// conversation, right after it is created: the first enabled rule, by priority, that matches and
// can be carried out decides.
@Injectable()
export class RoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(RoutingService.name)
  }

  async apply(
    storeId: string,
    conversationId: string,
    context: RoutingContext
  ): Promise<RoutingOutcome> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // One routing at a time per store: a round robin reads how loaded each person is, and two
      // routings that read together would hand both conversations to the same one (a person who
      // takes conversations by hand meanwhile is not held back: the load is a guide, not a promise)
      await lockStoreScope(tx, storeId, 'routing-assign')
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, storeId },
        select: { assignedTo: true, channelType: true, customerId: true }
      })
      if (conversation === null) throw resourceNotFound('conversation')
      // Someone has it already (a person took it, or the pipeline ran twice): rules do not take it back
      if (conversation.assignedTo !== null) {
        return { ruleId: null, assignedTo: conversation.assignedTo }
      }

      const facts = new Facts(tx, storeId, conversation.customerId, context, this.logger)
      const rules = await tx.routingRule.findMany({
        where: { storeId, enabled: true },
        select: { id: true, conditions: true, action: true },
        orderBy: { priority: 'asc' }
      })
      for (const rule of rules) {
        const conditions = conditionsSchema.safeParse(rule.conditions)
        const action = actionSchema.safeParse(rule.action)
        if (!conditions.success || !action.success) {
          // A row the api did not write: it is skipped and said, never a reason to lose a message
          this.logger.warn(
            { storeId, ruleId: rule.id },
            'routing rule with an invalid shape skipped'
          )
          continue
        }
        if (!(await matches(conditions.data, context, conversation, facts))) continue
        // A rule that leaves it to the team says so and stops here
        if (action.data.type === RoutingActionTypes.UNASSIGNED) {
          return { ruleId: rule.id, assignedTo: null }
        }
        const userId = await this.chooseUser(tx, storeId, action.data)
        // Nobody of the rule can take it now (they left): the rules below still have a say
        if (userId === null) continue
        if (await this.conversations.assignIfFree(tx, storeId, conversationId, userId)) {
          return { ruleId: rule.id, assignedTo: userId }
        }
        // A person took it between the read and the write: it is theirs, and that is what is reported
        const taken = await tx.conversation.findFirst({
          where: { id: conversationId, storeId },
          select: { assignedTo: true }
        })
        return { ruleId: null, assignedTo: taken?.assignedTo ?? null }
      }
      return { ruleId: null, assignedTo: null }
    })
  }

  // The people of the action are looked at now, not when the rule was written: someone who left, or
  // who lost the permission, is skipped. The memberships are held shared until the commit, so a
  // member removed meanwhile waits for this or is waited for (the same order as assigning by hand:
  // membership first, conversation after).
  private async chooseUser(
    tx: PrismaTransaction,
    storeId: string,
    action: Exclude<RoutingAction, { type: typeof RoutingActionTypes.UNASSIGNED }>
  ): Promise<string | null> {
    const eligible = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT m.user_id FROM memberships m
      WHERE m.store_id = ${storeId}
        AND m.user_id = ANY(${action.userIds}::text[])
        AND m.status = ${MembershipStatus.ACTIVE}
        AND m.revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM permissions p
          WHERE p.role_id = m.role_id AND p.name = ${Permissions.CONVERSATIONS_VIEW})
      ORDER BY m.user_id
      FOR SHARE OF m`
    const candidates = eligible.map(row => row.user_id)
    const [first] = candidates
    if (first === undefined) return null
    if (action.type === RoutingActionTypes.ASSIGN_USER) return first

    // Round robin: the one with the fewest conversations to work, the lowest id among equals
    const loads = await tx.conversation.groupBy({
      by: ['assignedTo'],
      where: {
        storeId,
        assignedTo: { in: candidates },
        status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] }
      },
      _count: { _all: true }
    })
    const load = new Map(loads.map(row => [row.assignedTo, row._count._all]))
    return candidates.reduce((best, candidate) =>
      (load.get(candidate) ?? 0) < (load.get(best) ?? 0) ? candidate : best
    )
  }
}

// What the conditions ask about, read once and only if a rule asks
class Facts {
  private tags: Promise<ReadonlySet<string>> | undefined
  private insideHours: Promise<boolean | null> | undefined

  constructor(
    private readonly tx: PrismaTransaction,
    private readonly storeId: string,
    private readonly customerId: string,
    private readonly context: RoutingContext,
    private readonly logger: PinoLogger
  ) {}

  customerTags(): Promise<ReadonlySet<string>> {
    this.tags ??= this.tx.customer
      .findFirst({
        where: { id: this.customerId, storeId: this.storeId },
        select: { tags: { select: { id: true } } }
      })
      .then(customer => new Set(customer?.tags.map(tag => tag.id) ?? []))
    return this.tags
  }

  // null: the store has no schedule we can read, so there is no "outside" of it
  isInsideHours(): Promise<boolean | null> {
    this.insideHours ??= this.tx.businessHours
      .findUnique({
        where: { storeId: this.storeId },
        select: { timezone: true, schedule: true }
      })
      .then(row => {
        if (row === null) return null
        const schedule = weekScheduleSchema.safeParse(row.schedule)
        try {
          if (schedule.success) {
            return isWithinSchedule(schedule.data, row.timezone, this.context.receivedAt)
          }
        } catch {
          // A timezone the runtime does not know: said below, like a schedule that does not parse
        }
        // Not written by the api: a store whose hours cannot be read must not stop its messages
        this.logger.warn({ storeId: this.storeId }, 'business hours that cannot be read ignored')
        return null
      })
    return this.insideHours
  }
}

async function matches(
  conditions: RoutingConditions,
  context: RoutingContext,
  conversation: Arriving,
  facts: Facts
): Promise<boolean> {
  if (
    conditions.channelTypes !== undefined &&
    !conditions.channelTypes.some(channel => channel === conversation.channelType)
  ) {
    return false
  }
  if (conditions.keywords !== undefined) {
    // Cut after it is plain: the characters that are taken out do not use up the part searched
    const text = plainText(context.text ?? '').slice(0, RoutingLimits.KEYWORD_SEARCH_MAX_LENGTH)
    // A keyword that is empty once plain would be found everywhere: the schema refuses it, and a
    // row that has one anyway never matches
    const words = conditions.keywords.map(plainText).filter(word => word !== '')
    if (!words.some(word => text.includes(word))) return false
  }
  if (conditions.tagIds !== undefined) {
    const held = await facts.customerTags()
    if (!conditions.tagIds.some(id => held.has(id))) return false
  }
  if (conditions.outsideBusinessHours === true && (await facts.isInsideHours()) !== false) {
    return false
  }
  return true
}
