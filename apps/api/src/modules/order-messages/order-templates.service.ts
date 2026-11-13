import { createHash } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  DatabaseNull,
  lockStoreForWrite,
  lockStoreScope,
  PrismaService
} from '@platform/core/database'
import {
  defaultAutoSend,
  type OrderMessageKindType,
  orderMessageAutoSendSchema
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { DEFAULT_LOCALE, type Locale } from '@platform/core/i18n'
import { invalidInput } from '@platform/core/messaging'
import {
  assertKnownVariables,
  type OrderMessagePreview,
  previewOrderMessage,
  variablesNeededBy
} from '@platform/core/shipping'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import {
  ChannelTemplatesService,
  TemplateLinkVerdicts
} from '../channels/channel-templates.service'
import type { Actor } from '../tenancy'

import type {
  ChannelTemplateLink,
  PreviewTemplateBody,
  PutTemplateBody
} from './order-templates.schemas'
import {
  type OrderTemplateView,
  readChannelTemplate,
  templateWarnings
} from './order-templates.support'

// The name of the lock the writers of the templates of a store take
const TEMPLATE_LOCK_SCOPE = 'order_message_template'

const TEMPLATE_SELECT = {
  id: true,
  kind: true,
  locale: true,
  body: true,
  autoSend: true,
  attachSummary: true,
  channelTemplate: true,
  updatedAt: true
} as const

interface TemplateRow {
  id: string
  kind: string
  locale: string
  body: string
  autoSend: boolean
  attachSummary: boolean
  channelTemplate: unknown
  updatedAt: Date
}

function viewOf(row: TemplateRow): OrderTemplateView {
  const channelTemplate = readChannelTemplate(row.channelTemplate)
  return {
    id: row.id,
    // The column is a string (open sets have no CHECK, TDD_17 §2): what this service wrote is one of the kinds
    kind: row.kind as OrderMessageKindType,
    locale: row.locale,
    body: row.body,
    autoSend: row.autoSend,
    attachSummary: row.attachSummary,
    channelTemplate,
    variables: variablesNeededBy(row.body, channelTemplate?.variables ?? []),
    warnings: templateWarnings({ body: row.body, autoSend: row.autoSend, channelTemplate }),
    updatedAt: row.updatedAt
  }
}

// The messages the store sends about an order, one template per kind and language (TDD_17 §4.7). This is the editor's side:
// reading, writing and previewing. Sending a message is OrderMessagesService (Step 4.9, PR C2), which reads a template through
// `resolve` and renders it with the pure functions of the shipping library.
@Injectable()
export class OrderTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: PluginRegistry,
    private readonly channelTemplates: ChannelTemplatesService
  ) {}

  async list(storeId: string): Promise<OrderTemplateView[]> {
    const rows = await this.prisma.client.orderMessageTemplate.findMany({
      where: { storeId },
      select: TEMPLATE_SELECT,
      orderBy: [{ kind: 'asc' }, { locale: 'asc' }]
    })
    return rows.map(viewOf)
  }

  async get(
    storeId: string,
    kind: OrderMessageKindType,
    locale: Locale
  ): Promise<OrderTemplateView> {
    const row = await this.prisma.client.orderMessageTemplate.findFirst({
      where: { storeId, kind, locale },
      select: TEMPLATE_SELECT
    })
    if (row === null) throw resourceNotFound('order message template')
    return viewOf(row)
  }

  // The template a message of this kind is written from: the one of the customer's language, otherwise the one of the
  // store's default language, otherwise none (the sender then falls back, it never drops the message).
  async resolve(
    storeId: string,
    kind: OrderMessageKindType,
    customerLocale: string | null
  ): Promise<OrderTemplateView | null> {
    const store = await this.prisma.client.store.findFirst({
      where: { id: storeId },
      select: { defaultLocale: true }
    })
    const wanted = [customerLocale, store?.defaultLocale ?? DEFAULT_LOCALE].filter(
      (locale): locale is string => locale !== null
    )
    const rows = await this.prisma.client.orderMessageTemplate.findMany({
      where: { storeId, kind, locale: { in: wanted } },
      select: TEMPLATE_SELECT
    })
    for (const locale of wanted) {
      const row = rows.find(candidate => candidate.locale === locale)
      if (row !== undefined) return viewOf(row)
    }
    return null
  }

  // Creates or replaces the template of a kind and language. The whole template is the request: a field left out is not
  // kept, so what is stored is always what the editor showed.
  async put(
    storeId: string,
    kind: OrderMessageKindType,
    locale: Locale,
    body: PutTemplateBody,
    actor: Actor
  ): Promise<OrderTemplateView> {
    assertKnownVariables(body.body)
    const autoSend = body.autoSend ?? defaultAutoSend(kind)
    // The summary and the failed attempt follow a store preference: one source of truth, so a template cannot turn them on
    if (!orderMessageAutoSendSchema.safeParse({ kind, autoSend }).success) {
      throw invalidInput('this kind follows a store preference, not autoSend')
    }
    if (body.channelTemplate !== null) {
      this.assertLinkable(storeId, body.channelTemplate)
      // A link that is already stored is not asked again: editing the text of a template must not fail because the channel
      // has since paused or removed the one it points to (the send judges it)
      const stored = await this.storedLink(storeId, kind, locale)
      const same =
        stored?.pluginId === body.channelTemplate.pluginId &&
        stored.name === body.channelTemplate.name &&
        stored.language === body.channelTemplate.language
      if (!same) await this.assertListed(storeId, body.channelTemplate)
    }
    const data = {
      body: body.body,
      autoSend,
      attachSummary: body.attachSummary,
      // A JSON column is cleared with Prisma's own marker: a plain null is a value it cannot place
      channelTemplate: body.channelTemplate ?? DatabaseNull
    }
    const { row, created } = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The store lock is a shared one: two PUTs of the same address would both find no row and both create it, and the second
      // would break on the unique index. This one makes the writers of templates take turns.
      await lockStoreScope(tx, storeId, TEMPLATE_LOCK_SCOPE)
      const existing = await tx.orderMessageTemplate.findFirst({
        where: { storeId, kind, locale },
        select: { id: true }
      })
      if (existing === null) {
        const made = await tx.orderMessageTemplate.create({
          data: { storeId, kind, locale, ...data },
          select: TEMPLATE_SELECT
        })
        return { row: made, created: true }
      }
      const updated = await tx.orderMessageTemplate.update({
        where: { id: existing.id },
        data,
        select: TEMPLATE_SELECT
      })
      return { row: updated, created: false }
    })
    this.logChange(storeId, actor, AuditAction.ORDER_TEMPLATE_UPDATED, kind, locale, {
      change: created ? 'created' : 'updated',
      autoSend,
      linked: body.channelTemplate !== null,
      // What went out to customers is the text: its hash tells that it changed, and its length how much
      bodySha256: createHash('sha256').update(body.body).digest('hex'),
      bodyLength: body.body.length
    })
    return viewOf(row)
  }

  async remove(
    storeId: string,
    kind: OrderMessageKindType,
    locale: Locale,
    actor: Actor
  ): Promise<void> {
    const deleted = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const { count } = await tx.orderMessageTemplate.deleteMany({
        where: { storeId, kind, locale }
      })
      return count
    })
    if (deleted === 0) throw resourceNotFound('order message template')
    this.logChange(storeId, actor, AuditAction.ORDER_TEMPLATE_DELETED, kind, locale, {
      change: 'deleted'
    })
  }

  // The body being edited as a customer would read it, with an invented order. Nothing is read from the store and nothing is
  // written; it answers the same refusals as saving.
  preview(body: PreviewTemplateBody): OrderMessagePreview {
    return previewOrderMessage(body.body, body.locale)
  }

  // Whether the channel takes an approved template, decided only by what its plugin declares (the TEMPLATES capability and a
  // window that asks for one when it is closed): never by its name (rule 13). A channel with no window sends free text at any
  // time, so a link to it would never be used and is refused instead of kept.
  private assertLinkable(storeId: string, link: ChannelTemplateLink): void {
    const plugin = this.registry.isVisibleTo(link.pluginId, storeId)
      ? this.registry.find(link.pluginId)
      : undefined
    if (
      plugin === undefined ||
      !this.registry.hasCapability(link.pluginId, ChannelCapability.TEMPLATES) ||
      plugin.messagingWindow?.requiresTemplateWhenClosed !== true
    ) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
        'the channel does not take approved templates',
        HttpStatusCodes.CONFLICT
      )
    }
  }

  private async storedLink(
    storeId: string,
    kind: OrderMessageKindType,
    locale: Locale
  ): Promise<ReturnType<typeof readChannelTemplate>> {
    const row = await this.prisma.client.orderMessageTemplate.findFirst({
      where: { storeId, kind, locale },
      select: { channelTemplate: true }
    })
    return readChannelTemplate(row?.channelTemplate ?? null)
  }

  // The template the owner typed must be one the channel lists as approved, so a typo does not wait for the first customer to be
  // found. Only a clear answer refuses: with no account, or an account that does not answer, the link is kept and the send judges
  // it (it falls back to the email when the template is not there, TDD_17 §4.7).
  private async assertListed(storeId: string, link: ChannelTemplateLink): Promise<void> {
    const verdict = await this.channelTemplates.checkLink(storeId, link.pluginId, link)
    if (verdict === TemplateLinkVerdicts.MISSING) {
      throw new PlatformException(
        ErrorCodes.ORDER_TEMPLATE_CHANNEL_TEMPLATE_MISSING,
        'the channel does not list a template with that name and language',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    if (verdict === TemplateLinkVerdicts.NOT_APPROVED) {
      throw new PlatformException(
        ErrorCodes.ORDER_TEMPLATE_CHANNEL_TEMPLATE_NOT_APPROVED,
        'the channel has not approved that template',
        HttpStatusCodes.BAD_REQUEST
      )
    }
  }

  private logChange(
    storeId: string,
    actor: Actor,
    action: AuditActionType,
    kind: string,
    locale: string,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'order_message_template',
      resourceId: `${kind}:${locale}`,
      metadata: { kind, locale, ...metadata },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
