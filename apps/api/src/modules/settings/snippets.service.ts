import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { AuditService } from '@platform/core/audit-module'
import { CacheKeys, CacheNamespaces, CacheScopes, CacheTTL } from '@platform/core/cache'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import { SettingsLimits } from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { CacheService } from '@platform/core/redis'

import type { Actor } from '../tenancy'

import type { CreateSnippetBody, UpdateSnippetBody } from './settings.schemas'
import {
  alreadyExists,
  auditSettingsChange,
  lockSnippet,
  requireRoom,
  uniqueTransaction
} from './settings.support'

// updatedAt travels through Redis as text and comes back as the date it was
const snippetSchema = z.object({
  id: z.string(),
  shortcut: z.string(),
  title: z.string(),
  content: z.string(),
  updatedAt: z.coerce.date()
})

export type SnippetView = z.output<typeof snippetSchema>

const snippetListSchema = z.array(snippetSchema)

const SNIPPET_SELECT = {
  id: true,
  shortcut: true,
  title: true,
  content: true,
  updatedAt: true
} as const

// The canned replies of a store, typed in the composer as /shortcut
@Injectable()
export class SnippetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly cache: CacheService
  ) {}

  // Read whenever the composer opens, changed rarely: cached for CacheTTL.MEDIUM and dropped by the cache
  // invalidation listener when a snippet is created, changed or deleted
  list(storeId: string): Promise<SnippetView[]> {
    return this.cache.getOrSet({
      namespace: CacheNamespaces.STORE_SNIPPETS,
      key: CacheKeys.store.snippets(storeId),
      ttlSeconds: CacheTTL.MEDIUM,
      schema: snippetListSchema,
      scopes: [CacheScopes.storeSnippets(storeId)],
      load: () =>
        this.prisma.client.snippet.findMany({
          where: { storeId },
          select: SNIPPET_SELECT,
          orderBy: [{ shortcut: 'asc' }, { id: 'asc' }]
        })
    })
  }

  async get(storeId: string, snippetId: string): Promise<SnippetView> {
    const snippet = await this.prisma.client.snippet.findFirst({
      where: { id: snippetId, storeId },
      select: SNIPPET_SELECT
    })
    if (snippet === null) throw resourceNotFound('snippet')
    return snippet
  }

  async create(storeId: string, body: CreateSnippetBody, actor: Actor): Promise<SnippetView> {
    const snippet = await uniqueTransaction(
      this.prisma,
      alreadyExists('snippet', 'shortcut'),
      async tx => {
        await lockStoreForWrite(tx, storeId)
        await requireRoom(tx, storeId, 'snippet', SettingsLimits.MAX_SNIPPETS_PER_STORE)
        const created = await tx.snippet.create({
          data: { storeId, ...body, createdBy: actor.userId },
          select: SNIPPET_SELECT
        })
        this.events.publish(tx, Events.SNIPPET_CREATED, { storeId, snippetId: created.id })
        return created
      }
    )
    auditSettingsChange(this.audit, storeId, actor, 'snippet', snippet.id, {
      change: 'created',
      shortcut: snippet.shortcut
    })
    return snippet
  }

  async update(
    storeId: string,
    snippetId: string,
    body: UpdateSnippetBody,
    actor: Actor
  ): Promise<SnippetView> {
    const snippet = await uniqueTransaction(
      this.prisma,
      alreadyExists('snippet', 'shortcut'),
      async tx => {
        await lockStoreForWrite(tx, storeId)
        await lockSnippet(tx, storeId, snippetId, 'write')
        const updated = await tx.snippet.update({
          where: { id: snippetId },
          data: body,
          select: SNIPPET_SELECT
        })
        this.events.publish(tx, Events.SNIPPET_UPDATED, { storeId, snippetId })
        return updated
      }
    )
    auditSettingsChange(this.audit, storeId, actor, 'snippet', snippetId, {
      change: 'updated',
      shortcut: snippet.shortcut
    })
    return snippet
  }

  // Two columns without a foreign key point at a snippet: the closing message of the inbox settings
  // and the away message of the business hours. Deleting one they use would break them without a
  // word, so the owner first picks another.
  async remove(storeId: string, snippetId: string, actor: Actor): Promise<void> {
    const shortcut = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockSnippet(tx, storeId, snippetId, 'write')
      const snippet = await tx.snippet.findUniqueOrThrow({
        where: { id: snippetId },
        select: { shortcut: true }
      })
      const closing = await tx.storeSettings.count({
        where: { storeId, closingSnippetId: snippetId }
      })
      const away = await tx.businessHours.count({
        where: { storeId, awayMessageSnippetId: snippetId }
      })
      if (closing + away > 0) {
        throw resourceConflict('a snippet that the settings use cannot be deleted', {
          usedAsClosingMessage: closing > 0,
          usedAsAwayMessage: away > 0
        })
      }
      await tx.snippet.delete({ where: { id: snippetId } })
      this.events.publish(tx, Events.SNIPPET_DELETED, { storeId, snippetId })
      return snippet.shortcut
    })
    auditSettingsChange(this.audit, storeId, actor, 'snippet', snippetId, {
      change: 'deleted',
      shortcut
    })
  }
}
