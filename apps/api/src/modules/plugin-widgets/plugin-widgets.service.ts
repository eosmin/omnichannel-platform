import { createHash, randomBytes } from 'node:crypto'

import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { z } from 'zod'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CacheKeys } from '@platform/core/cache'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  isPlatformHost,
  PluginBridgeOperations,
  type PluginBridgeConversation,
  type PluginBridgeCustomer,
  type PluginBridgeRequest,
  PlatformOrigins,
  PluginInstallationStatus,
  PluginStatus,
  pluginWidgetManifestSchema,
  PluginWidgetLimits
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { ConversationsService, type Viewer } from '@platform/core/messaging'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  PluginBridgeOperationScopes,
  type PluginScope,
  PluginScopePermissions
} from '@platform/plugins/sdk'

import { CustomersService } from '../customers/customers.service'
import type { Actor } from '../tenancy'

import { widgetIdSchema } from './plugin-widgets.schemas'

// One widget a store has, as the agent sidebar draws it. `url` is the manifest's, with no query: the page adds
// the conversation id. The API key of the plugin is not here, nor anywhere a browser can reach.
export interface PluginWidgetView {
  installationId: string
  pluginId: string
  pluginName: string
  widgetId: string
  name: string
  url: string
  origin: string
  width: number | null
  height: number | null
  refreshInterval: number | null
}

// A widget as Settings → Plugins draws it: the same view, and whether the agents see it
export interface PluginWidgetSettingsView extends PluginWidgetView {
  visible: boolean
}

export interface PluginWidgetSession {
  token: string
  expiresInSeconds: number
  origin: string
}

// What the session key holds. Read back with a schema: a value that is not this is no session
const storedSessionSchema = z.object({
  installationId: z.uuid(),
  conversationId: z.uuid(),
  userId: z.string().min(1),
  // The widget the session was opened for, always: hiding that widget ends the session
  widgetId: z.string()
})
type StoredSession = z.infer<typeof storedSessionSchema>

// INCR and the lifetime in one step, so that a counter is never left without one; answers the count
const COUNT_WITH_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function deny(message: string): PlatformException {
  return new PlatformException(ErrorCodes.PLUGIN_SCOPE_DENIED, message, HttpStatusCodes.FORBIDDEN)
}

function invalidSession(): PlatformException {
  return new PlatformException(
    ErrorCodes.PLUGIN_WIDGET_SESSION_INVALID,
    'the widget session is not valid',
    HttpStatusCodes.GONE
  )
}

// The widgets of the plugins a store installed (TDD_10 §7): which ones there are, a short session for one
// conversation, and the bridge that answers what a widget asks through its port, scope by scope.
@Injectable()
export class PluginWidgetsService {
  private readonly logger = new Logger(PluginWidgetsService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
    private readonly platform: PlatformOrigins,
    private readonly audit: AuditService
  ) {}

  // Active installations of approved plugins whose manifest declares widgets. A widget on a first-party host is
  // dropped: with `allow-same-origin` it would not be a different origin at all. The same rule runs again on every
  // request of a session (`call`), so a manifest that changed ends the sessions already open.
  async list(storeId: string): Promise<PluginWidgetView[]> {
    return (await this.widgetsOf(storeId, undefined, true)).map(entry => entry.view)
  }

  // Every widget of the store, the hidden ones too, for the owner who chooses what the agents see
  async settings(storeId: string): Promise<PluginWidgetSettingsView[]> {
    const entries = await this.widgetsOf(storeId, undefined, false, true)
    return entries.map(entry => ({ ...entry.view, visible: !entry.hidden }))
  }

  // Shows or hides one widget of an installation for every agent of the store. A hidden widget is not listed, gets
  // no new session, and the sessions it already has end at the next request (`call` reads the widgets again). The
  // config is read and written under the store lock, so two changes at once keep both.
  async setVisible(
    storeId: string,
    installationId: string,
    widgetId: string,
    visible: boolean,
    actor: Actor
  ): Promise<PluginWidgetSettingsView> {
    const entries = await this.widgetsOf(storeId, installationId, false, true)
    const target = entries.find(entry => entry.view.widgetId === widgetId)
    if (target === undefined) throw resourceNotFound('plugin widget')
    const declared = new Set(entries.map(entry => entry.view.widgetId))
    const changed = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Read again under the lock: an installation revoked since the check above is not written to
      const row = await tx.pluginInstallation.findFirst({
        where: { id: installationId, storeId, status: PluginInstallationStatus.ACTIVE },
        select: { config: true }
      })
      if (row === null) throw resourceNotFound('plugin widget')
      const config = this.configOf(row.config)
      const wasVisible = !config.hiddenWidgets.includes(widgetId)
      const hidden = new Set(config.hiddenWidgets)
      if (visible) hidden.delete(widgetId)
      else hidden.add(widgetId)
      // Ids the manifest no longer declares are dropped: a widget that comes back later does not return hidden
      const kept = [...hidden].filter(id => declared.has(id))
      const unchanged = wasVisible === visible && kept.length === config.hiddenWidgets.length
      if (unchanged) return false
      await tx.pluginInstallation.updateMany({
        where: { id: installationId, storeId },
        data: { config: { ...config, hiddenWidgets: kept } }
      })
      return wasVisible !== visible
    })
    if (changed) {
      this.audit.log({
        action: AuditAction.PLUGIN_WIDGET_VISIBILITY_CHANGED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: 'plugin_installation',
        resourceId: installationId,
        metadata: { widgetId, visible },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return { ...target.view, visible }
  }

  // What the config holds for widgets. The hidden list is filtered entry by entry, so one damaged value does not make
  // the owner's other choices reappear, and every other key of an object config is kept: a write never drops what the
  // installation holds besides this list.
  private configOf(raw: unknown): { hiddenWidgets: string[]; [key: string]: unknown } {
    const base =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    const list: unknown[] = Array.isArray(base.hiddenWidgets) ? base.hiddenWidgets : []
    const hiddenWidgets = list.filter(
      (id): id is string => typeof id === 'string' && widgetIdSchema.safeParse(id).success
    )
    return { ...base, hiddenWidgets }
  }

  private async widgetsOf(
    storeId: string,
    onlyInstallationId: string | undefined,
    report: boolean,
    includeHidden = false
  ): Promise<{ view: PluginWidgetView; scopes: string[]; hidden: boolean }[]> {
    const installations = await this.prisma.client.pluginInstallation.findMany({
      where: {
        storeId,
        status: PluginInstallationStatus.ACTIVE,
        plugin: { status: PluginStatus.APPROVED },
        ...(onlyInstallationId === undefined ? {} : { id: onlyInstallationId })
      },
      select: {
        id: true,
        scopes: true,
        config: true,
        plugin: { select: { id: true, name: true, manifest: true } }
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    const platformHosts = this.platform.origins.map(origin => new URL(origin).hostname)
    const entries: { view: PluginWidgetView; scopes: string[]; hidden: boolean }[] = []
    for (const installation of installations) {
      const parsed = pluginWidgetManifestSchema.safeParse(installation.plugin.manifest)
      if (!parsed.success) continue
      const { origin, hostname } = new URL(parsed.data.ui.widget)
      if (isPlatformHost(hostname, platformHosts)) {
        if (report) {
          this.logger.warn(
            { pluginId: installation.plugin.id },
            'widget on a platform host dropped'
          )
        }
        continue
      }
      const hiddenIds = new Set(this.configOf(installation.config).hiddenWidgets)
      for (const widget of parsed.data.widgets) {
        const hidden = hiddenIds.has(widget.id)
        if (hidden && !includeHidden) continue
        entries.push({
          scopes: installation.scopes,
          hidden,
          view: {
            installationId: installation.id,
            pluginId: installation.plugin.id,
            pluginName: installation.plugin.name,
            widgetId: widget.id,
            name: widget.name,
            url: parsed.data.ui.widget,
            origin,
            width: widget.defaultWidth ?? null,
            height: widget.defaultHeight ?? null,
            refreshInterval: widget.refreshInterval ?? null
          }
        })
      }
    }
    return entries
  }

  // Five minutes, for one person, one installation and one conversation that person may see. The token is
  // random and only its hash is kept; it goes to the page, which hands it to the frame over the port.
  async openSession(
    storeId: string,
    viewer: Viewer,
    installationId: string,
    conversationId: string,
    widgetId?: string
  ): Promise<PluginWidgetSession> {
    const entry = (await this.widgetsOf(storeId, installationId, true)).find(
      candidate => widgetId === undefined || candidate.view.widgetId === widgetId
    )
    if (entry === undefined) throw resourceNotFound('plugin widget')
    const widget = entry.view
    // Counted only for an installation that exists in the store, so that ids made up by the caller leave no keys
    await this.hit(
      CacheKeys.pluginWidget.sessionOpens(storeId, viewer.userId, installationId),
      PluginWidgetLimits.SESSIONS_PER_MINUTE
    )
    // Not visible to this person, or not of this store: the same 404
    await this.conversations.get(storeId, conversationId, viewer)

    const token = randomBytes(PluginWidgetLimits.TOKEN_BYTES).toString('base64url')
    const stored: StoredSession = {
      installationId,
      conversationId,
      userId: viewer.userId,
      widgetId: entry.view.widgetId
    }
    await this.redis.set(
      CacheKeys.pluginWidget.session(storeId, hashOf(token)),
      JSON.stringify(stored),
      'EX',
      PluginWidgetLimits.SESSION_TTL_SECONDS
    )
    return {
      token,
      expiresInSeconds: PluginWidgetLimits.SESSION_TTL_SECONDS,
      origin: widget.origin
    }
  }

  // Every request through the port ends here. Nothing the page forwarded is trusted: the session says who,
  // where and for which installation; the installation and its widget are read again (a revoked one, or one whose
  // manifest is no longer acceptable, stops at once) and its scopes decide; the conversation is the session's,
  // never one the frame names.
  async call(
    storeId: string,
    viewer: Viewer,
    token: string,
    request: PluginBridgeRequest
  ): Promise<PluginBridgeConversation | PluginBridgeCustomer> {
    const tokenHash = hashOf(token)
    const session = await this.sessionOf(storeId, tokenHash)
    if (session === null || session.userId !== viewer.userId) throw invalidSession()

    // Counted for the person and the installation, not for the token: a loop that opens a session after another
    // would otherwise get a new budget each time
    await this.hit(
      CacheKeys.pluginWidget.bridgeRequests(storeId, viewer.userId, session.installationId),
      PluginWidgetLimits.BRIDGE_REQUESTS_PER_MINUTE
    )

    // The widget the session was opened for must still be shown: hiding it ends its sessions at their next request
    const eligible = (await this.widgetsOf(storeId, session.installationId, false)).find(
      candidate => candidate.view.widgetId === session.widgetId
    )
    if (eligible === undefined) throw invalidSession()
    const installation = { scopes: eligible.scopes }

    const scope: PluginScope = PluginBridgeOperationScopes[request.operation]
    if (!installation.scopes.includes(scope)) {
      this.logger.warn(
        { installationId: session.installationId, storeId, operation: request.operation },
        'widget request outside its scopes'
      )
      throw deny('the plugin does not hold the scope for that request')
    }
    // A plugin can never read what the person could not: the scope grants these permissions, the person must hold one
    if (!PluginScopePermissions[scope].some(permission => viewer.held.includes(permission))) {
      throw deny('the person does not hold the permission for that request')
    }

    const conversation = await this.conversations.get(storeId, session.conversationId, viewer)
    if (request.operation === PluginBridgeOperations.CONVERSATION_GET) {
      return {
        id: conversation.id,
        status: conversation.status,
        channelType: conversation.channelType,
        createdAt: conversation.createdAt.toISOString(),
        lastInboundAt: conversation.lastInboundAt?.toISOString() ?? null,
        tags: conversation.tags.map(tag => tag.name)
      }
    }
    const customer = await this.customers.get(storeId, conversation.customer.id)
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      locale: customer.locale
    }
  }

  // A value that is not a session (truncated, from another version, edited) is no session, never a 500
  private async sessionOf(storeId: string, tokenHash: string): Promise<StoredSession | null> {
    const raw = await this.redis.get(CacheKeys.pluginWidget.session(storeId, tokenHash))
    if (raw === null) return null
    try {
      const parsed = storedSessionSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  // One more use of `key`, counted from the first one for a minute; over `limit` it is refused
  private async hit(key: string, limit: number): Promise<void> {
    const count = Number(
      await this.redis.eval(COUNT_WITH_WINDOW, 1, key, PluginWidgetLimits.BRIDGE_WINDOW_SECONDS)
    )
    if (count > limit) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'too many widget requests',
        HttpStatusCodes.TOO_MANY_REQUESTS
      )
    }
  }
}
