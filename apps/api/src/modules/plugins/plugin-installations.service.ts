import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { RemoteChannelSync } from '@platform/channels/remote'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  inSavepoint,
  isUniqueViolation,
  JobContext,
  lockStoreForWrite,
  PrismaService
} from '@platform/core/database'
import {
  CarrierConnectionStatus,
  ChannelConnectionStatus,
  type ChannelOAuthDescriptor,
  PLUGIN_INSTALLATION_RESOURCE_TYPE,
  type LocalizedText,
  PLUGIN_REVOKE_CONFIRMATION,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginManifestLimits,
  PluginStatus,
  readLocalizedText,
  ShippingPlugin
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { PublicApiConfig } from '@platform/core/http'
import {
  JobNames,
  pluginRevokedJobId,
  QueueNames,
  type TriggerPluginWebhookJob
} from '@platform/core/queues'
import {
  CarrierRegistry,
  type ConnectFieldSnapshot,
  manifestWebhookOf,
  PluginRegistry
} from '@platform/plugins/runtime'

import { CarrierConnectionsService } from '../carriers/carrier-connections.service'
import { OPEN_PICKUP_FILTER, OPEN_SHIPMENT_FILTER } from '../carriers/carrier-connections.views'
import { ChannelConnectionsService } from '../channels/channel-connections.service'
import { type PublicChannelDescriptor, publicDescriptorOf } from '../channels/public-descriptor'
import type { Actor } from '../tenancy'

import { isPluginScope } from './plugin-install-rules'
import {
  type PluginConsent,
  PluginIntegrationInstallService,
  type PluginSetupOffer
} from './plugin-integration-install.service'

// One plugin of the catalog and where it stands in the store of the request
export interface PluginCatalogEntry {
  id: string
  name: string
  authorName: string
  type: string
  isOfficial: boolean
  // A plugin the organization registered with its own manifest: the only kind `DELETE /plugins/:id` removes
  registered: boolean
  installed: boolean
  // Where the installation of this store stands (`PluginInstallationStatus`): `pending_setup` is an integration plugin that has
  // not traded its setup code for its key yet, which `installed` (true only when active) does not say. Null: never installed.
  installationStatus: string | null
  // When the failures of the deliveries turned the webhooks of an installation off (the plugin is installed and hears nothing
  // until it is revoked and installed again); null while they are on
  webhooksDisabledAt: string | null
  // The name the plugin gave in each language (a registered plugin may), for the interface; null: the plain `name` is the only one
  names: LocalizedText | null
  // What uninstalling names: null only while the plugin was never installed in the store. A revoked
  // installation keeps its id, so an uninstall that failed half way can be run again.
  installationId: string | null
  // The connections of the installation that are not disconnected
  activeConnections: number
  // What uninstalling would leave without a carrier to ask (the shipping plugin only; 0 for the others): shipments that are
  // still on their way and pickups still waiting
  openShipments: number
  openPickups: number
  // How a channel is connected, for the settings page; null for a plugin that is not a registered
  // channel (it is drawn from this, not from knowing the channel by name)
  channel: ChannelConnectManifest | null
}

export interface ChannelConnectManifest {
  // The connect form, in order. Nothing in it is a value: only what to ask for.
  connectFields: ConnectFieldSnapshot[]
  // How the channel is named and drawn, as the plugin declared it (the image hosts are for the build of the
  // web app and never leave the api)
  descriptor: PublicChannelDescriptor
  // For a channel the provider calls: the url the owner pastes into the provider's dashboard. It
  // carries no secret; the verify token of Meta is one value for the app, in the environment, and no
  // route returns it (owner decision, 2026-10-29).
  callbackUrl: string | null
  // "Connect with Facebook" can be offered for this channel: the plugin declares a login and the api has the
  // address Facebook sends the browser back to. A flag and nothing else: no address, scope or app id.
  facebookLogin: boolean
  // How the login is drawn (the provider's dialog origin, its name, the account it links, the pattern of an id),
  // as the plugin declared it and the registry checked it; null when the channel has no login or the api cannot
  // send the browser back (the same condition as `facebookLogin`)
  oauth: ChannelOAuthDescriptor | null
}

// What installing answers: where the plugin stands in the store now and, for an integration plugin that is waiting to be set up,
// the one-time code to give it (shown once, here and in a new code of `POST /plugins/:id/setup-code`)
// What the detail screen draws of a plugin: the entry of the catalog, what its manifest says about itself and the installation of this
// store. Never a secret: of the key only the prefix, of the webhook the address and the state.
export type PluginDetail = PluginCatalogEntry & {
  version: string | null
  description: string | null
  // The scopes the manifest asks for now (an installation holds the ones authorized on the consent screen)
  requestedScopes: string[]
  webhookEvents: string[]
  installation: {
    id: string
    status: string
    scopes: string[]
    apiKeyPrefix: string | null
    rateLimitPerMinute: number
    webhookEndpoint: string | null
    webhookConsecutiveFailures: number
    webhookLastFailureAt: string | null
    webhookDisabledAt: string | null
    installedAt: string
    revokedAt: string | null
  } | null
}

// What a stored manifest says about itself, read defensively: a row is data, and an official plugin has an empty one
function manifestSummaryOf(manifest: unknown): {
  version: string | null
  description: string | null
  requestedScopes: string[]
} {
  const block =
    typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : {}
  const scopes = Array.isArray(block['scopes'])
    ? block['scopes'].filter(
        (scope): scope is string => typeof scope === 'string' && isPluginScope(scope)
      )
    : []
  return {
    version: typeof block['version'] === 'string' ? block['version'] : null,
    description: typeof block['description'] === 'string' ? block['description'] : null,
    requestedScopes: scopes
  }
}

function namesOf(manifest: unknown): LocalizedText | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const names = (manifest as { names?: unknown }).names
  return names === undefined ? null : readLocalizedText(names, PluginManifestLimits.NAME_MAX_LENGTH)
}

export type PluginInstallResult = PluginCatalogEntry & { setup: PluginSetupOffer | null }

// The store of the request: the catalog it sees depends on its organization (a plugin the owner registered is the
// organization's, not every store's)
export interface PluginStoreRef {
  id: string
  organizationId: string
}

const CATALOG_SELECT = {
  id: true,
  name: true,
  authorName: true,
  type: true,
  isOfficial: true,
  // Read for the names of the plugin in each language, and for nothing else of the manifest
  manifest: true,
  // Whose it is: read to decide who sees it, never sent to the page
  organizationId: true
} as const

// What a store does with the plugin catalog: see it, install a plugin and uninstall it (D19). The
// registry holds the running plugin and the rows say what exists and what a store installed.
@Injectable()
export class PluginInstallationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobContext,
    private readonly registry: PluginRegistry,
    private readonly carriers: CarrierRegistry,
    private readonly connections: ChannelConnectionsService,
    private readonly carrierConnections: CarrierConnectionsService,
    private readonly publicApi: PublicApiConfig,
    private readonly audit: AuditService,
    private readonly integrations: PluginIntegrationInstallService,
    @InjectQueue(QueueNames.WEBHOOKS)
    private readonly webhooksQueue: Queue<TriggerPluginWebhookJob>,
    private readonly logger: PinoLogger,
    private readonly sync: RemoteChannelSync
  ) {
    this.logger.setContext(PluginInstallationsService.name)
  }

  // The approved plugins this store may see: the ones the platform ships (a row the registry does not know is shown to
  // nobody) and the integration plugins its organization registered, which no registry holds: the row says whose it is. An
  // integration plugin is listed here and installed by its own flow (consent, challenge and setup code: PluginIntegrationInstallService).
  async catalog(store: PluginStoreRef): Promise<PluginCatalogEntry[]> {
    const storeId = store.id
    const [plugins, installations, live, shipping] = await Promise.all([
      this.prisma.client.plugin.findMany({
        // The ones every store sees (the platform's) and the ones this organization registered, never another's
        where: {
          status: PluginStatus.APPROVED,
          OR: [{ organizationId: null }, { organizationId: store.organizationId }]
        },
        select: CATALOG_SELECT,
        orderBy: [{ isOfficial: 'desc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.client.pluginInstallation.findMany({
        where: { storeId },
        select: { id: true, pluginId: true, status: true, webhookDisabledAt: true }
      }),
      this.prisma.client.channelConnection.groupBy({
        by: ['installationId'],
        where: { storeId, status: { not: ChannelConnectionStatus.DISCONNECTED } },
        _count: { _all: true }
      }),
      // Only where the platform runs carriers: a deployment with none has no shipping entry to count for
      this.carriers.list().length > 0
        ? this.shippingUsage(storeId)
        : Promise.resolve({ active: 0, openShipments: 0, openPickups: 0 })
    ])
    const installationOf = new Map(installations.map(row => [row.pluginId, row]))
    const activeOf = new Map(live.map(row => [row.installationId, row._count._all]))
    return plugins
      .filter(plugin => {
        if (plugin.id === ShippingPlugin.ID) return this.carriers.list().length > 0
        // A plugin an organization registered runs outside the platform: the row and its organization say who sees it (the
        // catalog is already cut to the organization of the store), and a channel of that kind may not be in the registry yet
        if (plugin.organizationId !== null) return true
        return this.registry.isVisibleTo(plugin.id, storeId)
      })
      .map(({ organizationId: owner, manifest, ...plugin }) => {
        const installation = installationOf.get(plugin.id)
        const live =
          installation !== undefined &&
          installation.status !== String(PluginInstallationStatus.REVOKED)
        const installed =
          installation !== undefined &&
          installation.status === String(PluginInstallationStatus.ACTIVE)
        return {
          ...plugin,
          // The organization registered it, so the organization may delete it (the owner id itself never leaves)
          registered: owner !== null && !plugin.isOfficial,
          installed,
          installationStatus: installation?.status ?? null,
          // A revoked installation hears nothing and says nothing of its webhooks (the revocation keeps the column until a new install)
          webhooksDisabledAt: live ? (installation.webhookDisabledAt?.toISOString() ?? null) : null,
          names: namesOf(manifest),
          installationId: installation?.id ?? null,
          activeConnections:
            plugin.id === ShippingPlugin.ID
              ? shipping.active
              : installation
                ? (activeOf.get(installation.id) ?? 0)
                : 0,
          openShipments: plugin.id === ShippingPlugin.ID ? shipping.openShipments : 0,
          openPickups: plugin.id === ShippingPlugin.ID ? shipping.openPickups : 0,
          channel: this.manifestOf(plugin.id)
        }
      })
  }

  // One plugin of the catalog with what this store holds of it, for its detail screen. The plugin is looked for in the catalog of the
  // store (the ones every store sees and the ones its organization registered), so a plugin another organization registered answers
  // as one that does not exist, as the catalog, the consent and the install do.
  async detail(store: PluginStoreRef, pluginId: string): Promise<PluginDetail> {
    const entry = await this.entryOf(store, pluginId)
    const [row, installation] = await Promise.all([
      this.prisma.client.plugin.findUnique({ where: { id: pluginId }, select: { manifest: true } }),
      this.prisma.client.pluginInstallation.findUnique({
        where: { storeId_pluginId: { storeId: store.id, pluginId } },
        select: {
          id: true,
          status: true,
          scopes: true,
          apiKeyPrefix: true,
          rateLimitPerMinute: true,
          webhookEndpoint: true,
          webhookConsecutiveFailures: true,
          webhookLastFailureAt: true,
          webhookDisabledAt: true,
          createdAt: true,
          revokedAt: true
        }
      })
    ])
    // Gone between the two reads: the same answer as a plugin that was never there
    if (row === null) throw resourceNotFound('plugin')
    const webhook = manifestWebhookOf(row.manifest)
    return {
      ...entry,
      ...manifestSummaryOf(row.manifest),
      webhookEvents: webhook === null ? [] : [...webhook.events],
      installation:
        installation === null
          ? null
          : {
              id: installation.id,
              status: installation.status,
              scopes: installation.scopes,
              apiKeyPrefix: installation.apiKeyPrefix,
              rateLimitPerMinute: installation.rateLimitPerMinute,
              webhookEndpoint: installation.webhookEndpoint,
              webhookConsecutiveFailures: installation.webhookConsecutiveFailures,
              webhookLastFailureAt: installation.webhookLastFailureAt?.toISOString() ?? null,
              webhookDisabledAt:
                installation.status === String(PluginInstallationStatus.REVOKED)
                  ? null
                  : (installation.webhookDisabledAt?.toISOString() ?? null),
              installedAt: installation.createdAt.toISOString(),
              revokedAt: installation.revokedAt?.toISOString() ?? null
            }
    }
  }

  // What installing an integration plugin would grant, to be read before authorizing it
  consent(store: PluginStoreRef, pluginId: string): Promise<PluginConsent> {
    return this.integrations.consent(store, pluginId)
  }

  // A new code for an installation whose plugin has not set up yet (the first one expired or was lost)
  reissueSetupCode(
    store: PluginStoreRef,
    installationId: string,
    actor: Actor
  ): Promise<PluginSetupOffer> {
    return this.integrations.reissue(store, installationId, actor)
  }

  // Installing a channel makes it connectable. A plugin that was uninstalled is installed again on
  // the same row: the pair (store, plugin) has one. An integration plugin is installed with the scopes the owner authorized and
  // ends waiting for its plugin to set up (it is not `installed` until it has exchanged its code for its key).
  async install(
    store: PluginStoreRef,
    pluginId: string,
    scopes: readonly string[] | undefined,
    actor: Actor
  ): Promise<PluginInstallResult> {
    const storeId = store.id
    // The route is @NoTenantTransaction (the challenge of an integration plugin is a call to its address): each unit of database work
    // opens a short context of the store, or joins the one that is open (F6-3f)
    const plugin = await this.jobs.forStoreOrJoin(storeId, () =>
      this.prisma.client.plugin.findUnique({
        where: { id: pluginId },
        select: { type: true, status: true, organizationId: true }
      })
    )
    if (
      plugin === null ||
      plugin.status !== String(PluginStatus.APPROVED) ||
      // A plugin another organization registered does not exist for this one
      (plugin.organizationId !== null && plugin.organizationId !== store.organizationId) ||
      // A remote channel is private to the stores that installed it, so a store that has not is not told it does not exist: the
      // organization check above is its rule (as in the catalog and the consent)
      (this.registry.has(pluginId) &&
        !this.registry.isRemote(pluginId) &&
        !this.registry.isVisibleTo(pluginId, storeId))
    ) {
      throw resourceNotFound('plugin')
    }
    // A remote channel is a plugin an organization registered (an official one has no organization): it is installed with the
    // scopes its manifest asks for, like an integration plugin, and gets its command secret when it sets itself up
    const isRemoteChannel =
      plugin.type === String(PluginCatalogTypes.CHANNEL) && plugin.organizationId !== null
    if (plugin.type === String(PluginCatalogTypes.INTEGRATION) || isRemoteChannel) {
      if (scopes === undefined) {
        throw new PlatformException(
          ErrorCodes.VALIDATION_FAILED,
          'an integration plugin is installed with the scopes the owner authorized',
          HttpStatusCodes.BAD_REQUEST,
          { field: 'scopes' }
        )
      }
      const setup = await this.integrations.install(store, pluginId, scopes, actor)
      const entry = await this.jobs.forStoreOrJoin(storeId, () => this.entryOf(store, pluginId))
      return { ...entry, setup }
    }
    // The rest makes no call outside the platform's own database: one context for it
    return this.jobs.forStoreOrJoin(storeId, () =>
      this.installBuiltIn(store, pluginId, plugin.type, scopes, actor)
    )
  }

  // The plugins that run inside the platform (a channel of the registry, the shipping plugin): installed in one transaction
  private async installBuiltIn(
    store: PluginStoreRef,
    pluginId: string,
    type: string,
    scopes: readonly string[] | undefined,
    actor: Actor
  ): Promise<PluginInstallResult> {
    const storeId = store.id
    if (scopes !== undefined) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'this plugin takes no scopes',
        HttpStatusCodes.BAD_REQUEST,
        { field: 'scopes' }
      )
    }
    // The shipping plugin installs when the platform runs at least one carrier; a channel when the registry holds it
    const installable =
      pluginId === ShippingPlugin.ID
        ? type === String(PluginCatalogTypes.CARRIER) && this.carriers.list().length > 0
        : type === String(PluginCatalogTypes.CHANNEL) && this.registry.has(pluginId)
    if (!installable) {
      throw new PlatformException(
        ErrorCodes.PLUGIN_INSTALLATION_FAILED,
        'this plugin cannot be installed yet',
        HttpStatusCodes.CONFLICT
      )
    }

    // Installing again must not bring back what an uninstall that failed half way left up: those
    // connections are disconnected first, and the installation stays revoked while they are
    const previous = await this.prisma.client.pluginInstallation.findUnique({
      where: { storeId_pluginId: { storeId, pluginId } },
      select: { id: true, status: true }
    })
    if (previous !== null && previous.status !== String(PluginInstallationStatus.ACTIVE)) {
      await this.disconnectOpen(storeId, previous.id, pluginId, actor)
    }

    const write = () =>
      this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        const existing = await tx.pluginInstallation.findUnique({
          where: { storeId_pluginId: { storeId, pluginId } },
          select: { id: true, status: true }
        })
        if (existing?.status === String(PluginInstallationStatus.ACTIVE)) {
          throw new PlatformException(
            ErrorCodes.PLUGIN_ALREADY_INSTALLED,
            'the plugin is already installed in this store',
            HttpStatusCodes.CONFLICT
          )
        }
        if (existing === null) {
          await tx.pluginInstallation.create({
            data: {
              storeId,
              pluginId,
              scopes: [],
              status: PluginInstallationStatus.ACTIVE,
              installedBy: actor.userId
            }
          })
        } else {
          await tx.pluginInstallation.update({
            where: { id: existing.id },
            data: {
              status: PluginInstallationStatus.ACTIVE,
              revokedAt: null,
              installedBy: actor.userId
            }
          })
        }
      })
    try {
      await inSavepoint(write)
    } catch (error) {
      // Two installs at once: the second one runs again and finds the first one's row
      if (!isUniqueViolation(error)) throw error
      await inSavepoint(write)
    }
    const entry = await this.entryOf(store, pluginId)
    this.record(
      AuditAction.PLUGIN_INSTALLED,
      storeId,
      entry.installationId ?? pluginId,
      pluginId,
      actor
    )
    return { ...entry, setup: null }
  }

  // The installation is revoked first, so that nothing new connects; then every connection that
  // hangs from it is disconnected (the provider is told, the credentials are emptied) and the
  // conversations, messages and customers stay, because they are the business's history. Run again
  // it finishes what a failed run left.
  //
  // An integration plugin (TDD_10 §6.6) is revoked only with the word typed as written, and the same transaction takes away what let
  // it in: the hash of its key goes with the status (the guard already refuses a revoked installation at the next call; with no hash
  // there is nothing left to match), and its webhook subscription is closed after one last `plugin.revoked` delivery, which the
  // worker signs with the secret that is still kept and then removes together with the endpoint.
  async uninstall(
    store: PluginStoreRef,
    installationId: string,
    actor: Actor,
    confirmation?: string
  ): Promise<PluginCatalogEntry> {
    const storeId = store.id
    const installation = await this.prisma.client.pluginInstallation.findFirst({
      where: { id: installationId, storeId },
      select: { id: true, pluginId: true, plugin: { select: { type: true } } }
    })
    if (installation === null) throw resourceNotFound('plugin installation')
    const { pluginId } = installation
    const integration = installation.plugin.type === String(PluginCatalogTypes.INTEGRATION)
    const isChannel = installation.plugin.type === String(PluginCatalogTypes.CHANNEL)
    if (integration && confirmation !== PLUGIN_REVOKE_CONFIRMATION) {
      throw new PlatformException(
        ErrorCodes.PLUGIN_REVOKE_NOT_CONFIRMED,
        'type the confirmation word to revoke the plugin',
        HttpStatusCodes.BAD_REQUEST,
        { field: 'confirmation' }
      )
    }
    const revokedAt = new Date()
    const revoked = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const changed = await tx.pluginInstallation.updateMany({
        where: { id: installation.id, storeId, status: { not: PluginInstallationStatus.REVOKED } },
        data: {
          status: PluginInstallationStatus.REVOKED,
          revokedAt,
          // A key that is gone cannot be matched, whatever a check forgets
          ...(integration || isChannel ? { apiKeyHash: null, apiKeyPrefix: null } : {})
        }
      })
      return changed.count === 1
    })

    // Audited right after the revoke, before the disconnects: a failure of those must not leave the revocation unrecorded
    if (revoked) this.record(AuditAction.PLUGIN_REVOKED, storeId, installation.id, pluginId, actor)
    if (integration) {
      // Run again on an installation that is already revoked, it finishes what a failed run left: the one job of the revocation
      // (its id is the same) is queued if it is not, and nothing is sent twice
      await this.sendFinalWebhook(storeId, installation.id, pluginId)
    }
    // A code that was still waiting for the plugin to set up stops working with the installation
    if (integration || isChannel) {
      await this.integrations.voidSetup(installation.id)
    }
    // The plugin hears the disconnects first (they are signed with the secrets of the revoked installation); then every process stops
    // signing for it, whatever became of the disconnects
    try {
      await this.disconnectOpen(storeId, installation.id, pluginId, actor)
    } finally {
      if (isChannel) {
        await this.sync.announceChange()
      }
    }
    return this.entryOf(store, pluginId)
  }

  // The last thing a plugin hears from the installation (TDD_10 §6.6). Queued after the revocation stands, once: the id of the job
  // is made of the installation and the moment of the revocation, so asking again queues nothing new while the job is there, and
  // nothing at all once the worker has closed the subscription (the secret is gone). A plugin may see it before the events that were
  // queued earlier, which are skipped from then on. When it cannot be queued the subscription is closed at once instead, so a secret
  // never stays on a revoked row for a delivery that will not come; nothing here may fail the revocation, which already stands.
  private async sendFinalWebhook(
    storeId: string,
    installationId: string,
    pluginId: string
  ): Promise<void> {
    try {
      const kept = await this.prisma.client.pluginInstallation.findFirst({
        where: { id: installationId, storeId, status: PluginInstallationStatus.REVOKED },
        select: { webhookEndpoint: true, webhookSecret: true, revokedAt: true }
      })
      // No endpoint or no secret: no one to tell, or it was told
      if (
        kept === null ||
        kept.webhookEndpoint === null ||
        kept.webhookSecret === null ||
        kept.revokedAt === null
      ) {
        return
      }
      const job: TriggerPluginWebhookJob = {
        pluginInstallationId: installationId,
        storeId,
        deliveryId: randomUUID(),
        event: Events.PLUGIN_REVOKED,
        payload: {
          storeId,
          installationId,
          pluginId,
          revokedAt: kept.revokedAt.toISOString()
        },
        final: true
      }
      await this.webhooksQueue.add(JobNames.TRIGGER_PLUGIN_WEBHOOK, job, {
        jobId: pluginRevokedJobId(installationId, kept.revokedAt)
      })
    } catch (error) {
      this.logger.error(
        { installationId, err: String(error) },
        'the final webhook of a revoked plugin could not be queued'
      )
      try {
        await this.prisma.client.pluginInstallation.updateMany({
          where: { id: installationId, storeId, status: PluginInstallationStatus.REVOKED },
          data: { webhookEndpoint: null, webhookSecret: null }
        })
      } catch (closing) {
        this.logger.error(
          { installationId, err: String(closing) },
          'the subscription of a revoked plugin could not be closed'
        )
      }
    }
  }

  private async disconnectOpen(
    storeId: string,
    installationId: string,
    pluginId: string,
    actor: Actor
  ): Promise<void> {
    // The carriers of a store hang from the one installation of the shipping plugin: all of them are disconnected
    if (pluginId === ShippingPlugin.ID) {
      await this.carrierConnections.disconnectAll(storeId, actor)
      return
    }
    const open = await this.prisma.client.channelConnection.findMany({
      where: { installationId, storeId, status: { not: ChannelConnectionStatus.DISCONNECTED } },
      select: { id: true },
      orderBy: { id: 'asc' }
    })
    // One that fails must not leave the rest with their credentials: every one is tried, and the first failure is raised after
    let failure: Error | null = null
    for (const connection of open) {
      try {
        await this.connections.disconnect(storeId, connection.id, actor)
      } catch (error) {
        failure ??=
          error instanceof Error ? error : new Error('a channel could not be disconnected')
      }
    }
    if (failure !== null) throw failure
  }

  // What the shipping plugin holds in the store: its live connections, and what uninstalling would leave without a carrier
  private async shippingUsage(
    storeId: string
  ): Promise<{ active: number; openShipments: number; openPickups: number }> {
    const [active, openShipments, openPickups] = await Promise.all([
      this.prisma.client.carrierConnection.count({
        where: { storeId, status: { not: CarrierConnectionStatus.DISABLED } }
      }),
      this.prisma.client.shipment.count({ where: { storeId, ...OPEN_SHIPMENT_FILTER } }),
      this.prisma.client.pickupRequest.count({ where: { storeId, ...OPEN_PICKUP_FILTER } })
    ])
    return { active, openShipments, openPickups }
  }

  // Copies of what the registry kept at registration; null for a row whose plugin is not running here
  private manifestOf(pluginId: string): ChannelConnectManifest | null {
    const manifest = this.registry.connectManifestOf(pluginId)
    if (manifest === null) return null
    const descriptor = publicDescriptorOf(this.registry.descriptorOf(pluginId))
    if (descriptor === null) return null
    const hasLogin = this.registry.oauthOf(pluginId)?.redirectUri != null
    return {
      connectFields: manifest.connectFields.map(field => ({ ...field })),
      descriptor,
      callbackUrl: manifest.receivesProviderWebhooks ? this.callbackUrlOf(pluginId) : null,
      facebookLogin: hasLogin,
      oauth: hasLogin ? this.registry.oauthDescriptorOf(pluginId) : null
    }
  }

  private callbackUrlOf(pluginId: string): string {
    return `${this.publicApi.apiUrl.replace(/\/$/, '')}${API_PREFIX}${ApiRoutes.webhooks.channel(pluginId)}`
  }

  private async entryOf(store: PluginStoreRef, pluginId: string): Promise<PluginCatalogEntry> {
    const entry = (await this.catalog(store)).find(candidate => candidate.id === pluginId)
    if (entry === undefined) throw resourceNotFound('plugin')
    return entry
  }

  private record(
    action: typeof AuditAction.PLUGIN_INSTALLED | typeof AuditAction.PLUGIN_REVOKED,
    storeId: string,
    installationId: string,
    pluginId: string,
    actor: Actor
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: PLUGIN_INSTALLATION_RESOURCE_TYPE,
      resourceId: installationId,
      metadata: { pluginId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
