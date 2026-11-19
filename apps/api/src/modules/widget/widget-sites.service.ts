import { Injectable } from '@nestjs/common'

import { allowedOriginsOf, isSiteKey, preChatEnabledOf } from '@platform/channels/web-widget'
import {
  contextOf,
  PrismaService,
  resolveWidgetSite,
  type ResolvedRow
} from '@platform/core/database'
import { ChannelConnectionStatus, ChannelIds } from '@platform/core/domain'

// A store's widget as the public routes see it
export interface WidgetSite {
  siteKey: string
  // ChannelConnection.id
  connectionId: string
  storeId: string
  organizationId: string
  storeName: string
  // Store.defaultLocale, which the widget speaks unless the snippet names another
  storeLocale: string
  allowedOrigins: readonly string[]
  // The widget asks the visitor for a name, an email and a phone before the first message
  preChatEnabled: boolean
}

// A site key that was resolved is kept this long: a visitor's widget calls the api several times a minute (bootstrap, messages,
// typing at the handshake), and each one would pay the lookup of the definer function. Only the ids are kept, never the row:
// the status, the origins and the name are read again inside the context on every call, so a site that is disconnected or edited
// is seen at once. A key that did not resolve is never kept (a key that is connected a second later must work).
const RESOLVED_TTL_MS = 30_000
const RESOLVED_MAX = 500

// The door from a site key, which anyone can send, to the store it belongs to. Only an active
// connection of the widget plugin opens it: one that was disconnected, or a key of another channel,
// is the same as a key that never existed. The routes turn that into the same 403 as a site that is not
// listed (`allowOrigin`), never a 404, so the answers do not tell which keys exist.
@Injectable()
export class WidgetSites {
  private readonly resolved = new Map<string, { row: ResolvedRow; until: number }>()

  constructor(private readonly prisma: PrismaService) {}

  private async resolve(siteKey: string, now: number): Promise<ResolvedRow | null> {
    const kept = this.resolved.get(siteKey)
    if (kept !== undefined && kept.until > now) return kept.row
    this.resolved.delete(siteKey)
    const found = await resolveWidgetSite(this.prisma.client, ChannelIds.WEB_WIDGET, siteKey)
    if (found === null) return null
    if (this.resolved.size >= RESOLVED_MAX) {
      // The oldest goes, not all of them: a visitor who tries false keys must not empty the cache of the real ones
      const oldest = this.resolved.keys().next().value
      if (oldest !== undefined) this.resolved.delete(oldest)
    }
    this.resolved.set(siteKey, { row: found, until: now + RESOLVED_TTL_MS })
    return found
  }

  async find(siteKey: unknown): Promise<WidgetSite | null> {
    if (!isSiteKey(siteKey)) return null
    // The site key says which store it is only to the database: the lookup finds the connection and its store, and the row is read
    // inside the context of that store (the status, the origins and the store's name are the connection's and the store's)
    // The ids may be a moment old (a key deleted and made again for another store): a miss that came from kept ids is asked once more
    // from the database before the key is given up
    const wasKept = this.resolved.has(siteKey)
    let found = await this.resolve(siteKey, Date.now())
    if (found === null) return null
    let row = await this.readConnection(found, siteKey)
    if (row === null && wasKept) {
      this.resolved.delete(siteKey)
      found = await this.resolve(siteKey, Date.now())
      if (found === null) return null
      row = await this.readConnection(found, siteKey)
    }
    if (row === null || row.status !== String(ChannelConnectionStatus.ACTIVE)) {
      this.resolved.delete(siteKey)
      return null
    }
    return {
      siteKey,
      connectionId: row.id,
      storeId: row.storeId,
      organizationId: found.organizationId,
      storeName: row.store.name,
      storeLocale: row.store.defaultLocale,
      allowedOrigins: allowedOriginsOf(row.metadata),
      preChatEnabled: preChatEnabledOf(row.metadata)
    }
  }

  private readConnection(found: ResolvedRow, siteKey: string) {
    return this.prisma.tenantTransaction(contextOf(found), () =>
      this.prisma.client.channelConnection.findFirst({
        // The key too: a site key that was rotated on the same connection stops working at once, not when the kept ids end
        where: { id: found.id, storeId: found.storeId, connectionId: siteKey },
        select: {
          id: true,
          storeId: true,
          status: true,
          metadata: true,
          store: { select: { name: true, defaultLocale: true } }
        }
      })
    )
  }
}
