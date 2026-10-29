import { Injectable } from '@nestjs/common'

import { allowedOriginsOf, originsLabel, WidgetEmbedConfig } from '@platform/channels/web-widget'
import { API_PREFIX } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, ChannelIds, WidgetMetadataKeys } from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

// What the owner sees of a widget: the sites that may load it and the snippet to paste into them
export interface WidgetEmbedView {
  siteKey: string
  allowedOrigins: string[]
  snippet: string
}

const CONNECTION_SELECT = {
  connectionId: true,
  status: true,
  metadata: true
} as const

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  '<': '&lt;',
  '>': '&gt;'
}
const escapeAttribute = (value: string): string =>
  value.replace(/[&"<>]/g, c => HTML_ESCAPES[c] ?? c)

// The settings of one widget connection of a store. The site key never changes, so a snippet already
// published keeps working when a site is added or removed.
@Injectable()
export class WidgetSettings {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WidgetEmbedConfig,
    private readonly audit: AuditService
  ) {}

  async embed(storeId: string, connectionId: string): Promise<WidgetEmbedView> {
    const row = await this.find(storeId, connectionId)
    return this.view(row.connectionId, allowedOriginsOf(row.metadata))
  }

  async updateOrigins(
    storeId: string,
    connectionId: string,
    siteOrigins: string[],
    actor: Actor
  ): Promise<WidgetEmbedView> {
    const before = await this.find(storeId, connectionId)
    if (before.status !== String(ChannelConnectionStatus.ACTIVE)) {
      throw resourceConflict('the widget is disconnected')
    }
    // The write names the state it read, so a disconnect in between is a conflict and not a revival
    const updated = await this.prisma.client.channelConnection.updateMany({
      where: {
        id: connectionId,
        storeId,
        pluginId: ChannelIds.WEB_WIDGET,
        status: String(ChannelConnectionStatus.ACTIVE)
      },
      data: {
        displayName: originsLabel(siteOrigins),
        metadata: { [WidgetMetadataKeys.ALLOWED_ORIGINS]: siteOrigins }
      }
    })
    if (updated.count !== 1) throw resourceConflict('the widget is disconnected')
    // The list is the boundary of who may load the widget: the log says what it was and what it is
    this.audit.log({
      action: AuditAction.WIDGET_ORIGINS_CHANGED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'channel_connection',
      resourceId: connectionId,
      metadata: { before: allowedOriginsOf(before.metadata), after: siteOrigins },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.view(before.connectionId, siteOrigins)
  }

  // Another store's connection, or one of another channel, is "not found"
  private async find(storeId: string, connectionId: string) {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, storeId, pluginId: ChannelIds.WEB_WIDGET },
      select: CONNECTION_SELECT
    })
    if (row === null) throw resourceNotFound('widget')
    return row
  }

  private view(siteKey: string, allowedOrigins: string[]): WidgetEmbedView {
    return { siteKey, allowedOrigins, snippet: this.snippetOf(siteKey) }
  }

  // Plain attributes on a script tag: the script reads them itself, so the merchant writes no code.
  // The values are escaped, so that a url with a quote in it cannot add attributes to the page.
  private snippetOf(siteKey: string): string {
    const apiUrl = `${this.config.apiUrl.replace(/\/$/, '')}${API_PREFIX}`
    const attributes = [
      `src="${escapeAttribute(this.config.scriptUrl)}"`,
      `data-site-key="${escapeAttribute(siteKey)}"`,
      `data-api-url="${escapeAttribute(apiUrl)}"`
    ]
    return `<script ${attributes.join(' ')} async></script>`
  }
}
