import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { lockStoreForWrite, PrismaService, type PrismaTransaction } from '@platform/core/database'
import { MembershipStatus, RoutingLimits } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import { lockStoreScope } from '../settings/settings.support'
import type { Actor } from '../tenancy'

import {
  actionSchema,
  type CreateRuleBody,
  conditionsSchema,
  type ReorderBody,
  type RoutingAction,
  type RoutingConditions,
  type UpdateRuleBody
} from './routing.schemas'

export interface RoutingRuleView {
  id: string
  name: string
  priority: number
  enabled: boolean
  conditions: RoutingConditions
  action: RoutingAction
  createdAt: Date
  updatedAt: Date
}

const RULE_SELECT = {
  id: true,
  name: true,
  priority: true,
  enabled: true,
  conditions: true,
  action: true,
  createdAt: true,
  updatedAt: true
} as const

// The two Json columns are parsed again on the way out: the database is a boundary like any other
function view(row: {
  id: string
  name: string
  priority: number
  enabled: boolean
  conditions: unknown
  action: unknown
  createdAt: Date
  updatedAt: Date
}): RoutingRuleView {
  return {
    ...row,
    conditions: conditionsSchema.parse(row.conditions),
    action: actionSchema.parse(row.action)
  }
}

// Who a rule sends conversations to is what an audit of it has to be able to read
function describe(rule: { name: string; enabled: boolean; conditions: unknown; action: unknown }) {
  return {
    name: rule.name,
    enabled: rule.enabled,
    conditions: rule.conditions,
    action: rule.action
  }
}

// Moves every priority out of the way of the new ones: (storeId, priority) is unique, and the
// database checks it row by row, so two rules cannot swap places in one pass
const PRIORITY_OFFSET = 1_000_000

const SCOPE = 'routing'

function invalidReferences(what: string, ids: readonly string[]): PlatformException {
  return new PlatformException(
    ErrorCodes.VALIDATION_FAILED,
    `${what} that do not belong to this store`,
    HttpStatusCodes.BAD_REQUEST,
    { ids }
  )
}

// The rules of a store, in the order they are tried: the first one that matches decides
@Injectable()
export class RoutingRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string): Promise<RoutingRuleView[]> {
    const rows = await this.prisma.client.routingRule.findMany({
      where: { storeId },
      select: RULE_SELECT,
      orderBy: { priority: 'asc' }
    })
    return rows.map(view)
  }

  async get(storeId: string, ruleId: string): Promise<RoutingRuleView> {
    const row = await this.prisma.client.routingRule.findFirst({
      where: { id: ruleId, storeId },
      select: RULE_SELECT
    })
    if (row === null) throw resourceNotFound('routing rule')
    return view(row)
  }

  async create(storeId: string, body: CreateRuleBody, actor: Actor): Promise<RoutingRuleView> {
    const rule = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, SCOPE)
      const last = await tx.routingRule.aggregate({
        where: { storeId },
        _count: true,
        _max: { priority: true }
      })
      if (last._count >= RoutingLimits.MAX_RULES_PER_STORE) {
        throw resourceConflict(
          `a store holds at most ${RoutingLimits.MAX_RULES_PER_STORE} routing rules`,
          { limit: RoutingLimits.MAX_RULES_PER_STORE }
        )
      }
      await this.requireReferences(tx, storeId, body.conditions, body.action)
      return tx.routingRule.create({
        data: {
          storeId,
          name: body.name,
          priority: (last._max.priority ?? 0) + 1,
          enabled: body.enabled,
          conditions: body.conditions,
          action: body.action,
          createdBy: actor.userId
        },
        select: RULE_SELECT
      })
    })
    this.record(storeId, actor, 'routing_rule', rule.id, { change: 'created', ...describe(rule) })
    return view(rule)
  }

  async update(
    storeId: string,
    ruleId: string,
    body: UpdateRuleBody,
    actor: Actor
  ): Promise<RoutingRuleView> {
    const rule = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, SCOPE)
      const current = await tx.routingRule.findFirst({
        where: { id: ruleId, storeId },
        select: { id: true }
      })
      if (current === null) throw resourceNotFound('routing rule')
      await this.requireReferences(tx, storeId, body.conditions, body.action)
      return tx.routingRule.update({
        where: { id: ruleId, storeId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.conditions === undefined ? {} : { conditions: body.conditions }),
          ...(body.action === undefined ? {} : { action: body.action })
        },
        select: RULE_SELECT
      })
    })
    this.record(storeId, actor, 'routing_rule', ruleId, { change: 'updated', ...describe(rule) })
    return view(rule)
  }

  async remove(storeId: string, ruleId: string, actor: Actor): Promise<void> {
    const name = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, SCOPE)
      const rule = await tx.routingRule.findFirst({
        where: { id: ruleId, storeId },
        select: { name: true }
      })
      if (rule === null) throw resourceNotFound('routing rule')
      await tx.routingRule.delete({ where: { id: ruleId, storeId } })
      return rule.name
    })
    this.record(storeId, actor, 'routing_rule', ruleId, { change: 'deleted', name })
  }

  // The client sends the order it shows, with every rule in it. If the store has others by then (or
  // has lost one) the order is not applied: it was drawn from a list that is no longer the list.
  async reorder(storeId: string, body: ReorderBody, actor: Actor): Promise<RoutingRuleView[]> {
    const rows = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, SCOPE)
      const held = await tx.routingRule.findMany({ where: { storeId }, select: { id: true } })
      const sameRules =
        held.length === body.ruleIds.length && held.every(rule => body.ruleIds.includes(rule.id))
      if (!sameRules) {
        throw resourceConflict('the rules of the store changed: reload the list and order it again')
      }
      await tx.routingRule.updateMany({
        where: { storeId },
        data: { priority: { increment: PRIORITY_OFFSET } }
      })
      for (const [index, id] of body.ruleIds.entries()) {
        await tx.routingRule.update({ where: { id, storeId }, data: { priority: index + 1 } })
      }
      return tx.routingRule.findMany({
        where: { storeId },
        select: RULE_SELECT,
        orderBy: { priority: 'asc' }
      })
    })
    this.record(storeId, actor, 'store', storeId, { change: 'reordered', ruleIds: body.ruleIds })
    return rows.map(view)
  }

  // The tags and the people a rule names belong to this store, and the people can be given a
  // conversation. A rule that names someone who leaves later is skipped for them when it runs.
  private async requireReferences(
    tx: PrismaTransaction,
    storeId: string,
    conditions: RoutingConditions | undefined,
    action: RoutingAction | undefined
  ): Promise<void> {
    if (conditions?.tagIds !== undefined) {
      // Held until the commit: deleting a tag takes its row for update and then looks for the rules
      // that name it, so the two take turns and the tag is never deleted under a rule that is born
      const found = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM tags
        WHERE store_id = ${storeId} AND id = ANY(${conditions.tagIds}::text[])
        ORDER BY id
        FOR KEY SHARE`
      const known = new Set(found.map(tag => tag.id))
      const missing = conditions.tagIds.filter(id => !known.has(id))
      if (missing.length > 0) throw invalidReferences('tags', missing)
    }
    if (action !== undefined && 'userIds' in action) {
      const members = await tx.membership.findMany({
        where: {
          storeId,
          userId: { in: action.userIds },
          status: MembershipStatus.ACTIVE,
          revokedAt: null,
          role: { permissions: { some: { name: Permissions.CONVERSATIONS_VIEW } } }
        },
        select: { userId: true }
      })
      const known = new Set(members.map(member => member.userId))
      const missing = action.userIds.filter(id => !known.has(id))
      if (missing.length > 0) {
        throw invalidReferences('people who cannot be given conversations', missing)
      }
    }
  }

  private record(
    storeId: string,
    actor: Actor,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action: AuditAction.ROUTING_RULE_CHANGED,
      actor: { userId: actor.userId },
      storeId,
      resourceType,
      resourceId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
