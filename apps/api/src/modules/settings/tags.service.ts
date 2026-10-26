import { Injectable } from '@nestjs/common'

import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, PrismaService, type PrismaTransaction } from '@platform/core/database'
import { DEFAULT_TAG_COLOR, SettingsLimits } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { CreateTagBody, UpdateTagBody } from './settings.schemas'
import {
  alreadyExists,
  auditSettingsChange,
  lockStoreScope,
  lockTag,
  requireRoom,
  uniqueTransaction
} from './settings.support'

export interface TagView {
  id: string
  name: string
  color: string
  description: string | null
}

const TAG_SELECT = { id: true, name: true, color: true, description: true } as const

// The tags of a store, shared by its customers and its conversations. Deleting one takes it off
// everything it was on.
@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  list(storeId: string): Promise<TagView[]> {
    return this.prisma.client.tag.findMany({
      where: { storeId },
      select: TAG_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }]
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
      return tx.tag.create({
        data: {
          storeId,
          name: body.name,
          color: body.color ?? DEFAULT_TAG_COLOR,
          description: body.description ?? null
        },
        select: TAG_SELECT
      })
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
      return tx.tag.update({
        where: { id: tagId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.color === undefined ? {} : { color: body.color }),
          ...(body.description === undefined ? {} : { description: body.description })
        },
        select: TAG_SELECT
      })
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
      const tag = await tx.tag.delete({ where: { id: tagId }, select: { name: true } })
      return tag.name
    })
    auditSettingsChange(this.audit, storeId, actor, 'tag', tagId, { change: 'deleted', name })
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
