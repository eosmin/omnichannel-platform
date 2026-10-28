import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { PluginRegistry } from '@platform/plugins/runtime'

import { ChannelConnectionsService } from '../channels/channel-connections.service'
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
    private readonly connections: ChannelConnectionsService,
    private readonly audit: AuditService
  ) {}

  // The approved plugins this store may see: the official ones and the private ones the registry
  // holds for it. A row the registry does not know is shown to nobody.
  async catalog(storeId: string): Promise<PluginCatalogEntry[]> {
    const [plugins, installations, live] = await Promise.all([
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
      })
    ])
    const installationOf = new Map(installations.map(row => [row.pluginId, row]))
    const activeOf = new Map(live.map(row => [row.installationId, row._count._all]))
    return plugins
      .filter(plugin => this.registry.isVisibleTo(plugin.id, storeId))
      .map(plugin => {
        const installation = installationOf.get(plugin.id)
        const installed =
          installation !== undefined &&
          installation.status === String(PluginInstallationStatus.ACTIVE)
        return {
          ...plugin,
          installed,
          installationId: installation?.id ?? null,
          activeConnections: installation ? (activeOf.get(installation.id) ?? 0) : 0
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
    // The integration plugins have a key and a consent screen, which Step 5.6 builds
    if (plugin.type !== String(PluginCatalogTypes.CHANNEL) || !this.registry.has(pluginId)) {
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
      await this.disconnectOpen(storeId, previous.id, actor)
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

    await this.disconnectOpen(storeId, installation.id, actor)
    if (revoked) this.record(AuditAction.PLUGIN_REVOKED, storeId, installation.id, pluginId, actor)
    return this.entryOf(storeId, pluginId)
  }

  private async disconnectOpen(
    storeId: string,
    installationId: string,
    actor: Actor
  ): Promise<void> {
    const open = await this.prisma.client.channelConnection.findMany({
      where: { installationId, storeId, status: { not: ChannelConnectionStatus.DISCONNECTED } },
      select: { id: true },
      orderBy: { id: 'asc' }
    })
    for (const connection of open) {
      await this.connections.disconnect(storeId, connection.id, actor)
    }
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
