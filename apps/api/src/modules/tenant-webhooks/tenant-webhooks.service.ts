import { Injectable } from '@nestjs/common'

import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher, generateToken } from '@platform/core/crypto'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  WEBHOOK_RESOURCE_TYPE,
  WEBHOOK_SECRET_PREFIX,
  WebhookLimits,
  WebhookStatus
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type {
  CreateWebhookBody,
  ListDeliveriesQuery,
  UpdateWebhookBody
} from './tenant-webhooks.schemas'
import {
  DELIVERY_SELECT,
  deliveryView,
  WEBHOOK_SELECT,
  webhookView,
  type WebhookDeliveryPage,
  type WebhookView,
  type WebhookWithSecretView
} from './tenant-webhooks.views'
import { assertWebhookUrl } from './webhook-url'

const SCOPE = 'webhook'
// The status column is text: compared with the value of the enum as text
const ACTIVE: string = WebhookStatus.ACTIVE

// The outbound webhooks of a store (Settings → Webhooks, TDD_07 §2, TDD_09 §13). The secret signs every delivery; it
// is kept sealed like the credentials of a channel and shown once, when it is made. Every read and write is scoped by the
// store of the request, and a webhook of another store is one that does not exist.
@Injectable()
export class TenantWebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string): Promise<WebhookView[]> {
    const rows = await this.prisma.client.webhook.findMany({
      where: { storeId },
      select: WEBHOOK_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(webhookView)
  }

  async get(storeId: string, webhookId: string): Promise<WebhookView> {
    const row = await this.prisma.client.webhook.findFirst({
      where: { id: webhookId, storeId },
      select: WEBHOOK_SELECT
    })
    if (row === null) throw resourceNotFound('webhook')
    return webhookView(row)
  }

  async create(
    storeId: string,
    body: CreateWebhookBody,
    actor: Actor
  ): Promise<WebhookWithSecretView> {
    await assertWebhookUrl(body.url)
    const secret = newSecret()
    const row = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, SCOPE)
      const count = await tx.webhook.count({ where: { storeId } })
      if (count >= WebhookLimits.MAX_PER_STORE) {
        throw resourceConflict(`a store holds at most ${WebhookLimits.MAX_PER_STORE} webhooks`, {
          limit: WebhookLimits.MAX_PER_STORE
        })
      }
      return tx.webhook.create({
        data: {
          storeId,
          url: body.url,
          events: body.events,
          secret: this.cipher.seal({ secret }),
          createdBy: actor.userId
        },
        select: WEBHOOK_SELECT
      })
    })
    // The address is not in the entry: it can carry a token of the receiver
    this.record(AuditAction.WEBHOOK_CREATED, storeId, actor, row.id, { events: body.events })
    return { ...webhookView(row), secret }
  }

  async update(
    storeId: string,
    webhookId: string,
    body: UpdateWebhookBody,
    actor: Actor
  ): Promise<WebhookView> {
    if (body.url !== undefined) await assertWebhookUrl(body.url)
    const row = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const before = await this.lock(tx, storeId, webhookId)
      return tx.webhook.update({
        where: { id: webhookId },
        data: {
          ...(body.url === undefined ? {} : { url: body.url }),
          ...(body.events === undefined ? {} : { events: body.events }),
          ...(body.status === undefined ? {} : { status: body.status }),
          // A webhook that is turned on again (it was not active) starts with a clean count; one that is only saved as active keeps its count: what disabled it was the old state of the
          // endpoint. A new address alone changes nothing about its status: a disabled webhook is turned on on purpose.
          ...(body.status === WebhookStatus.ACTIVE && before !== ACTIVE
            ? { consecutiveFailures: 0 }
            : {})
        },
        select: WEBHOOK_SELECT
      })
    })
    this.record(AuditAction.WEBHOOK_UPDATED, storeId, actor, webhookId, {
      changed: Object.keys(body).filter(key => body[key as keyof UpdateWebhookBody] !== undefined),
      ...(body.status === undefined ? {} : { status: body.status })
    })
    return webhookView(row)
  }

  async remove(storeId: string, webhookId: string, actor: Actor): Promise<void> {
    // Not under the lock of the store: the log that goes with it can be long, and nothing about the store is at stake
    await this.prisma.transaction(async tx => {
      await this.lock(tx, storeId, webhookId)
      await tx.webhook.delete({ where: { id: webhookId } })
    })
    this.record(AuditAction.WEBHOOK_DELETED, storeId, actor, webhookId, {})
  }

  // A new secret: the old one stops signing at once. Shown once, never in the audit entry.
  async rotateSecret(
    storeId: string,
    webhookId: string,
    actor: Actor
  ): Promise<WebhookWithSecretView> {
    const secret = newSecret()
    const row = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await this.lock(tx, storeId, webhookId)
      return tx.webhook.update({
        where: { id: webhookId },
        data: { secret: this.cipher.seal({ secret }) },
        select: WEBHOOK_SELECT
      })
    })
    this.record(AuditAction.WEBHOOK_UPDATED, storeId, actor, webhookId, {
      changed: ['secret']
    })
    return { ...webhookView(row), secret }
  }

  // The log of a webhook, newest first. The webhook is read under the store first: the log table has no store of its own.
  async deliveries(
    storeId: string,
    webhookId: string,
    query: ListDeliveriesQuery
  ): Promise<WebhookDeliveryPage> {
    const webhook = await this.prisma.client.webhook.findFirst({
      where: { id: webhookId, storeId },
      select: { id: true }
    })
    if (webhook === null) throw resourceNotFound('webhook')
    const { cursor } = query
    const rows = await this.prisma.client.webhookDelivery.findMany({
      where: {
        webhookId,
        ...(query.success === undefined ? {} : { success: query.success }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: DELIVERY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      items: page.map(deliveryView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null
    }
  }

  // The webhook under the lock, and the status it had
  private async lock(tx: PrismaTransaction, storeId: string, webhookId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM webhooks WHERE id = ${webhookId} AND store_id = ${storeId} FOR UPDATE`
    const status = rows[0]?.status
    if (status === undefined) throw resourceNotFound('webhook')
    return status
  }

  private record(
    action: AuditActionType,
    storeId: string,
    actor: Actor,
    webhookId: string,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: WEBHOOK_RESOURCE_TYPE,
      resourceId: webhookId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

function newSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${generateToken(WebhookLimits.SECRET_BYTES)}`
}
