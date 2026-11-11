import { Injectable } from '@nestjs/common'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  CarrierConnectionStatus,
  ChannelConnectionStatus,
  type ChannelOAuthDescriptor,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginStatus,
  ShippingPlugin
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { PublicApiConfig } from '@platform/core/http'
import {
  CarrierRegistry,
  type ConnectFieldSnapshot,
  PluginRegistry
} from '@platform/plugins/runtime'

import { CarrierConnectionsService } from '../carriers/carrier-connections.service'
import { OPEN_PICKUP_FILTER, OPEN_SHIPMENT_FILTER } from '../carriers/carrier-connections.views'
import { ChannelConnectionsService } from '../channels/channel-connections.service'
import { type PublicChannelDescriptor, publicDescriptorOf } from '../channels/public-descriptor'
import type { Actor } from '../tenancy'

// One plugin of the catalog and where it stands in the store of the request
export interface PluginCatalogEntry {
  id: string
  name: string
  authorName: string
  type: string
  isOfficial: boolean
  installed: boolean
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

const CATALOG_SELECT = {
  id: true,
  name: true,
  authorName: true,
  type: true,
  isOfficial: true
} as const

// What a store does with the plugin catalog: see it, install a plugin and uninstall it (D19). The
// registry holds the running plugin and the rows say what exists and what a store installed.
@Injectable()
export class PluginInstallationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly carriers: CarrierRegistry,
    private readonly connections: ChannelConnectionsService,
    private readonly carrierConnections: CarrierConnectionsService,
    private readonly publicApi: PublicApiConfig,
    private readonly audit: AuditService
  ) {}

  // The approved plugins this store may see: the official ones and the private ones the registry
  // holds for it. A row the registry does not know is shown to nobody.
  async catalog(storeId: string): Promise<PluginCatalogEntry[]> {
    const [plugins, installations, live, shipping] = await Promise.all([
      this.prisma.client.plugin.findMany({
        where: { status: PluginStatus.APPROVED },
        select: CATALOG_SELECT,
        orderBy: [{ isOfficial: 'desc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.client.pluginInstallation.findMany({
        where: { storeId },
        select: { id: true, pluginId: true, status: true }
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
      .filter(plugin =>
        plugin.id === ShippingPlugin.ID
          ? this.carriers.list().length > 0
          : this.registry.isVisibleTo(plugin.id, storeId)
      )
      .map(plugin => {
        const installation = installationOf.get(plugin.id)
        const installed =
          installation !== undefined &&
          installation.status === String(PluginInstallationStatus.ACTIVE)
        return {
          ...plugin,
          installed,
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

  // Installing a channel makes it connectable. A plugin that was uninstalled is installed again on
  // the same row: the pair (store, plugin) has one.
  async install(storeId: string, pluginId: string, actor: Actor): Promise<PluginCatalogEntry> {
    const plugin = await this.prisma.client.plugin.findUnique({
      where: { id: pluginId },
      select: { type: true, status: true }
    })
    if (
      plugin === null ||
      plugin.status !== String(PluginStatus.APPROVED) ||
      (this.registry.has(pluginId) && !this.registry.isVisibleTo(pluginId, storeId))
    ) {
      throw resourceNotFound('plugin')
    }
    // The shipping plugin installs when the platform runs at least one carrier; a channel when the registry holds it. The
    // integration plugins have a key and a consent screen, which Step 5.6 builds
    const installable =
      pluginId === ShippingPlugin.ID
        ? plugin.type === String(PluginCatalogTypes.CARRIER) && this.carriers.list().length > 0
        : plugin.type === String(PluginCatalogTypes.CHANNEL) && this.registry.has(pluginId)
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
      await write()
    } catch (error) {
      // Two installs at once: the second one runs again and finds the first one's row
      if (!isUniqueViolation(error)) throw error
      await write()
    }
    const entry = await this.entryOf(storeId, pluginId)
    this.record(
      AuditAction.PLUGIN_INSTALLED,
      storeId,
      entry.installationId ?? pluginId,
      pluginId,
      actor
    )
    return entry
  }

  // The installation is revoked first, so that nothing new connects; then every connection that
  // hangs from it is disconnected (the provider is told, the credentials are emptied) and the
  // conversations, messages and customers stay, because they are the business's history. Run again
  // it finishes what a failed run left.
  async uninstall(
    storeId: string,
    installationId: string,
    actor: Actor
  ): Promise<PluginCatalogEntry> {
    const installation = await this.prisma.client.pluginInstallation.findFirst({
      where: { id: installationId, storeId },
      select: { id: true, pluginId: true }
    })
    if (installation === null) throw resourceNotFound('plugin installation')
    const { pluginId } = installation
    const revoked = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const changed = await tx.pluginInstallation.updateMany({
        where: { id: installation.id, storeId, status: { not: PluginInstallationStatus.REVOKED } },
        data: { status: PluginInstallationStatus.REVOKED, revokedAt: new Date() }
      })
      return changed.count === 1
    })

    // Audited right after the revoke, before the disconnects: a failure of those must not leave the revocation unrecorded
    if (revoked) this.record(AuditAction.PLUGIN_REVOKED, storeId, installation.id, pluginId, actor)
    await this.disconnectOpen(storeId, installation.id, pluginId, actor)
    return this.entryOf(storeId, pluginId)
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

  private async entryOf(storeId: string, pluginId: string): Promise<PluginCatalogEntry> {
    const entry = (await this.catalog(storeId)).find(candidate => candidate.id === pluginId)
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
      resourceType: 'plugin_installation',
      resourceId: installationId,
      metadata: { pluginId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
