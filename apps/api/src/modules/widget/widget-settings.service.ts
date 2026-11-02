import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  allowedOriginsOf,
  originsLabel,
  preChatEnabledOf,
  WidgetEmbedConfig
} from '@platform/channels/web-widget'
import { API_PREFIX } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  ChannelIds,
  ConnectSrcProbe,
  WidgetMetadataKeys
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { StorageService } from '@platform/core/storage-module'

import type { Actor } from '../tenancy'

// What the owner sees of a widget: the sites that may load it and the snippet to paste into them
export interface WidgetEmbedView {
  siteKey: string
  allowedOrigins: string[]
  // The widget asks the visitor for a name, an email and a phone before the first message
  preChatEnabled: boolean
  snippet: string
  // What a page with a strict `connect-src` must list for the widget to work: the api (http and
  // websocket) and the host of the bucket, where the visitor's browser puts a file on a signed url
  // (TDD_10 §5.4). Origins and nothing else: no path, no query, nothing signed.
  connectSrc: string[]
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
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(WidgetSettings.name)
  }

  async embed(storeId: string, connectionId: string): Promise<WidgetEmbedView> {
    const row = await this.find(storeId, connectionId)
    return this.view(
      row.connectionId,
      allowedOriginsOf(row.metadata),
      preChatEnabledOf(row.metadata)
    )
  }

  async updateOrigins(
    storeId: string,
    connectionId: string,
    siteOrigins: string[],
    actor: Actor
  ): Promise<WidgetEmbedView> {
    const { before, after } = await this.change(storeId, connectionId, {
      metadata: { [WidgetMetadataKeys.ALLOWED_ORIGINS]: siteOrigins },
      displayName: originsLabel(siteOrigins)
    })
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
    return this.view(before.connectionId, siteOrigins, preChatEnabledOf(after.metadata))
  }

  async updatePreChat(
    storeId: string,
    connectionId: string,
    enabled: boolean,
    actor: Actor
  ): Promise<WidgetEmbedView> {
    const { before, after } = await this.change(storeId, connectionId, {
      metadata: { [WidgetMetadataKeys.PRE_CHAT_ENABLED]: enabled }
    })
    // The form makes the widget collect personal data: the log says who turned it on or off
    this.audit.log({
      action: AuditAction.WIDGET_PRE_CHAT_CHANGED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'channel_connection',
      resourceId: connectionId,
      metadata: { before: preChatEnabledOf(before.metadata), after: enabled },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.view(before.connectionId, allowedOriginsOf(after.metadata), enabled)
  }

  // One key of the metadata changes and the others stay. The row is locked while it is read and
  // written, so two settings saved at the same moment both land. A disconnected widget is a conflict,
  // not a revival.
  private async change(
    storeId: string,
    connectionId: string,
    patch: { metadata: Record<string, string[] | boolean>; displayName?: string }
  ) {
    return this.prisma.transaction(async tx => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM channel_connections
        WHERE id = ${connectionId} AND store_id = ${storeId} AND plugin_id = ${ChannelIds.WEB_WIDGET}
        FOR UPDATE`
      if (locked.length === 0) throw resourceNotFound('widget')
      const before = await tx.channelConnection.findFirstOrThrow({
        where: { id: connectionId, storeId, pluginId: ChannelIds.WEB_WIDGET },
        select: CONNECTION_SELECT
      })
      if (before.status !== String(ChannelConnectionStatus.ACTIVE)) {
        throw resourceConflict('the widget is disconnected')
      }
      const current =
        typeof before.metadata === 'object' &&
        before.metadata !== null &&
        !Array.isArray(before.metadata)
          ? before.metadata
          : {}
      const metadata = { ...current, ...patch.metadata }
      await tx.channelConnection.update({
        where: { id: connectionId },
        data: {
          metadata,
          ...(patch.displayName === undefined ? {} : { displayName: patch.displayName })
        }
      })
      return { before, after: { ...before, metadata } }
    })
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

  private async view(
    siteKey: string,
    allowedOrigins: string[],
    preChatEnabled: boolean
  ): Promise<WidgetEmbedView> {
    return {
      siteKey,
      allowedOrigins,
      preChatEnabled,
      snippet: this.snippetOf(siteKey),
      connectSrc: await this.connectSrc()
    }
  }

  // The bucket host is the one the SDK signs for (path style or virtual host, endpoint or AWS), so it
  // is read from a signed url instead of rebuilt from the settings. Signing is local, no call goes to
  // the bucket, and the url is cut to its origin: the signature never leaves this method.
  private bucketOrigin?: Promise<string>
  private connectSrc(): Promise<string[]> {
    this.bucketOrigin ??= this.storage
      .uploadUrl({
        key: ConnectSrcProbe.KEY,
        contentType: ConnectSrcProbe.CONTENT_TYPE,
        contentLength: ConnectSrcProbe.CONTENT_LENGTH
      })
      .then(url => new URL(url).origin)
      .catch((error: unknown) => {
        this.bucketOrigin = undefined // Not kept: the next read asks again
        throw error
      })
    const api = new URL(this.config.apiUrl)
    const socket = `${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}`
    // A bucket that cannot be read must not undo a save that committed, nor hide the snippet: the page
    // then lacks the bucket host, which is all it loses
    return this.bucketOrigin.then(
      bucket => [...new Set([api.origin, socket, bucket])],
      () => {
        // Without a trace the owner lists two hosts and the uploads are blocked by their own page
        this.logger.warn('the bucket host could not be read for connectSrc')
        return [...new Set([api.origin, socket])]
      }
    )
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
