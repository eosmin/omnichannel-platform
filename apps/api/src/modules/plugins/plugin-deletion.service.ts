import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { RemoteChannelSync } from '@platform/channels/remote'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isForeignKeyViolation, PrismaService } from '@platform/core/database'
import { PluginCatalogTypes, PluginInstallationStatus, phraseMatches } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'

import type { Actor } from '../tenancy'

import { PluginIconService } from './plugin-icon.service'
import type { PluginStoreRef } from './plugin-installations.service'

function inUse(message: string): PlatformException {
  return new PlatformException(ErrorCodes.PLUGIN_IN_USE, message, HttpStatusCodes.CONFLICT)
}

// Removing a plugin the organization registered (debt (h) of PR P1, PR W1-2). The catalog row goes, and so do the rows of its
// installations, which by then are revoked and empty: no key, no secret, no open subscription and no connection. What the plugin
// did stays where it is (messages, audit entries, the conversations of a channel's past connections); that is why a plugin
// whose installation still holds connections, the history of a channel, is refused, as is any that is not fully revoked.
@Injectable()
export class PluginDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly icons: PluginIconService,
    private readonly sync: RemoteChannelSync,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PluginDeletionService.name)
  }

  // `confirmation` is the name of the plugin, typed (none: refused like a wrong one); space around it is not an error and the case is, as for the screen. A plugin of another organization, an official one and one that does not
  // exist answer the same 404, before the confirmation is looked at.
  async delete(
    store: PluginStoreRef,
    pluginId: string,
    confirmation: string | undefined,
    actor: Actor
  ): Promise<void> {
    const plugin = await this.prisma.client.plugin.findFirst({
      where: { id: pluginId, organizationId: store.organizationId, isOfficial: false },
      select: { id: true, name: true, type: true }
    })
    if (plugin === null) throw resourceNotFound('plugin')
    if (confirmation === undefined || !phraseMatches(confirmation, plugin.name)) {
      throw new PlatformException(
        ErrorCodes.PLUGIN_DELETE_NOT_CONFIRMED,
        'type the name of the plugin to delete it',
        HttpStatusCodes.BAD_REQUEST,
        { field: 'confirmation' }
      )
    }

    let removedInstallations: number
    try {
      removedInstallations = await this.prisma.transaction(async tx => {
        // The same lock as a registration: one change of the organization's catalog at a time
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${store.organizationId} FOR UPDATE`
        const installations = await tx.pluginInstallation.findMany({
          where: { pluginId: plugin.id },
          select: {
            status: true,
            webhookEndpoint: true,
            webhookSecret: true,
            _count: { select: { channelConnections: true } }
          }
        })
        const busy = installations.some(
          installation =>
            installation.status !== String(PluginInstallationStatus.REVOKED) ||
            // The last delivery of a revocation is still to be sent: it needs the row, the endpoint and the secret that signs it. An
            // endpoint with no secret (revoked before the setup exchange) has nothing to send, and the worker never clears it.
            (installation.webhookEndpoint !== null && installation.webhookSecret !== null) ||
            installation._count.channelConnections > 0
        )
        if (busy) {
          throw inUse('revoke the plugin in every store first, and wait for its last webhook')
        }
        await tx.pluginInstallation.deleteMany({ where: { pluginId: plugin.id } })
        const removed = await tx.plugin.deleteMany({
          where: { id: plugin.id, organizationId: store.organizationId, isOfficial: false }
        })
        if (removed.count !== 1) throw resourceNotFound('plugin')
        return installations.length
      })
    } catch (error) {
      // An installation written between the check and the delete: the plugin is in use after all
      if (isForeignKeyViolation(error))
        throw inUse('the plugin was installed while it was being deleted')
      throw error
    }

    // Audited as soon as the rows are gone; the picture and the registry below may fail without hiding it
    this.audit.log({
      action: AuditAction.PLUGIN_DELETED,
      actor: { userId: actor.userId },
      storeId: store.id,
      resourceType: 'plugin',
      resourceId: plugin.id,
      metadata: { pluginId: plugin.id, type: plugin.type, removedInstallations },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    // Best effort: the plugin is gone and audited, so a failure here must not turn the answer into an error (a retry would be a 404)
    if (plugin.type === String(PluginCatalogTypes.CHANNEL)) {
      try {
        // Not when the organization registered the id again in the meantime: the picture is the new plugin's
        const again = await this.prisma.client.plugin.count({ where: { id: plugin.id } })
        if (again === 0) await this.icons.remove(plugin.id)
        await this.sync.announceChange()
      } catch (error) {
        this.logger.warn(
          { errorName: error instanceof Error ? error.name : 'unknown' },
          'the registry could not be refreshed after a plugin was deleted'
        )
      }
    }
  }
}
