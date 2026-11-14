import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { AuditService } from '@platform/core/audit-module'
import { CacheKeys, CacheNamespaces, CacheScopes, CacheTTL } from '@platform/core/cache'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { DEFAULT_TAG_COLOR, SettingsLimits } from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { CacheService } from '@platform/core/redis'

import type { Actor } from '../tenancy'

import type { CreateTagBody, UpdateTagBody } from './settings.schemas'
import {
  alreadyExists,
  auditSettingsChange,
  lockTag,
  requireRoom,
  uniqueTransaction
} from './settings.support'

const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable()
})

export type TagView = z.output<typeof tagSchema>

const tagListSchema = z.array(tagSchema)

const TAG_SELECT = { id: true, name: true, color: true, description: true } as const

// The tags of a store, shared by its customers and its conversations. Deleting one takes it off
// everything it was on.
@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly cache: CacheService
  ) {}

  // Read on every screen that offers tags, and changed rarely: cached for CacheTTL.MEDIUM and dropped by
  // the cache invalidation listener when a tag is created, renamed or deleted
  list(storeId: string): Promise<TagView[]> {
    return this.cache.getOrSet({
      namespace: CacheNamespaces.STORE_TAGS,
      key: CacheKeys.store.tags(storeId),
      ttlSeconds: CacheTTL.MEDIUM,
      schema: tagListSchema,
      scopes: [CacheScopes.storeTags(storeId)],
      load: () =>
        this.prisma.client.tag.findMany({
          where: { storeId },
          select: TAG_SELECT,
          orderBy: [{ name: 'asc' }, { id: 'asc' }]
        })
    })
  }

  async get(storeId: string, tagId: string): Promise<TagView> {
    const tag = await this.prisma.client.tag.findFirst({
      where: { id: tagId, storeId },
      select: TAG_SELECT
    })
    if (tag === null) throw resourceNotFound('tag')
    return tag
  }

  async create(storeId: string, body: CreateTagBody, actor: Actor): Promise<TagView> {
    const tag = await uniqueTransaction(this.prisma, alreadyExists('tag', 'name'), async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, 'tag')
      await this.requireFreeName(tx, storeId, body.name)
      await requireRoom(tx, storeId, 'tag', SettingsLimits.MAX_TAGS_PER_STORE)
      const created = await tx.tag.create({
        data: {
          storeId,
          name: body.name,
          color: body.color ?? DEFAULT_TAG_COLOR,
          description: body.description ?? null
        },
        select: TAG_SELECT
      })
      this.events.publish(tx, Events.TAG_CREATED, { storeId, tagId: created.id })
      return created
    })
    auditSettingsChange(this.audit, storeId, actor, 'tag', tag.id, {
      change: 'created',
      name: tag.name
    })
    return tag
  }

  async update(
    storeId: string,
    tagId: string,
    body: UpdateTagBody,
    actor: Actor
  ): Promise<TagView> {
    const tag = await uniqueTransaction(this.prisma, alreadyExists('tag', 'name'), async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockTag(tx, storeId, tagId, 'change')
      if (body.name !== undefined) await this.requireFreeName(tx, storeId, body.name, tagId)
      const updated = await tx.tag.update({
        where: { id: tagId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.color === undefined ? {} : { color: body.color }),
          ...(body.description === undefined ? {} : { description: body.description })
        },
        select: TAG_SELECT
      })
      this.events.publish(tx, Events.TAG_UPDATED, { storeId, tagId })
      return updated
    })
    auditSettingsChange(this.audit, storeId, actor, 'tag', tagId, {
      change: 'updated',
      name: tag.name
    })
    return tag
  }

  async remove(storeId: string, tagId: string, actor: Actor): Promise<void> {
    const name = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockTag(tx, storeId, tagId, 'delete')
      await this.requireNoRoutingRule(tx, storeId, tagId)
      const tag = await tx.tag.delete({ where: { id: tagId }, select: { name: true } })
      this.events.publish(tx, Events.TAG_DELETED, { storeId, tagId })
      return tag.name
    })
    auditSettingsChange(this.audit, storeId, actor, 'tag', tagId, { change: 'deleted', name })
  }

  // A routing rule names tags in a Json column, with no foreign key to hold it: the rule that names a
  // tag has to be changed first, or it would keep a condition that can never hold. Creating or
  // changing a rule holds the tag shared (FOR KEY SHARE) until it commits, so the two take turns.
  private async requireNoRoutingRule(
    tx: PrismaTransaction,
    storeId: string,
    tagId: string
  ): Promise<void> {
    const rules = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM routing_rules
      WHERE store_id = ${storeId} AND conditions -> 'tagIds' @> to_jsonb(${tagId}::text)`
    if (rules.length > 0) {
      throw resourceConflict('a routing rule names this tag: change the rule first', {
        ruleIds: rules.map(rule => rule.id)
      })
    }
  }

  // Case-insensitive: "VIP" and "vip" in one list is a mistake waiting for who picks one. The index
  // uq_tags_store_name_ci holds the same rule when two requests ask together.
  private async requireFreeName(
    tx: PrismaTransaction,
    storeId: string,
    name: string,
    exceptId?: string
  ): Promise<void> {
    const taken = await tx.tag.findFirst({
      where: {
        storeId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === undefined ? {} : { id: { not: exceptId } })
      },
      select: { id: true }
    })
    if (taken !== null) throw alreadyExists('tag', 'name')
  }
}
