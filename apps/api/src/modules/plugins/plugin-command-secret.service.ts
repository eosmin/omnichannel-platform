import { Injectable } from '@nestjs/common'

import { newCommandSecret, RemoteChannelSync, sealCommandSecret } from '@platform/channels/remote'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import {
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginStatus,
  RemoteChannelLimits,
  RemoteChannelLockScopes
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

// What the owner gets, once: the new secret, and until when the old one still signs
export interface RotatedCommandSecret {
  commandSecret: string
  rotatedAt: string
  previousValidUntil: string
}

// Rotating the secret that signs the commands to a remote channel (TDD_10 §6.7.3). The new secret signs from now on and the
// previous one stays valid for ten minutes (every command carries both signatures), so what is already queued is not
// interrupted. A rotation is refused while another one is still open: a second one would drop the secret the plugin has not
// had the time to replace.
@Injectable()
export class PluginCommandSecretService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly sync: RemoteChannelSync,
    private readonly audit: AuditService
  ) {}

  async rotate(
    store: { id: string },
    installationId: string,
    actor: Actor
  ): Promise<RotatedCommandSecret> {
    const secret = newCommandSecret()
    const graceMs = RemoteChannelLimits.ROTATION_GRACE_SECONDS * 1000
    const { pluginId, now } = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, store.id)
      // The store lock is a shared one: two rotations at once would both find the window closed. This one makes them take turns
      await lockStoreScope(
        tx,
        store.id,
        `${RemoteChannelLockScopes.COMMAND_SECRET}:${installationId}`
      )
      // Taken under the lock: the grace window counts from the moment the rotation is visible
      const now = new Date()
      // The installation is the one of this store and of a remote channel that is up: another store's id is "not found"
      const installation = await tx.pluginInstallation.findFirst({
        where: {
          id: installationId,
          storeId: store.id,
          status: PluginInstallationStatus.ACTIVE,
          plugin: {
            type: PluginCatalogTypes.CHANNEL,
            status: PluginStatus.APPROVED,
            isOfficial: false
          }
        },
        select: { pluginId: true, commandSecret: true, commandSecretRotatedAt: true }
      })
      if (installation === null) throw resourceNotFound('plugin installation')
      if (
        installation.commandSecretRotatedAt !== null &&
        now.getTime() - installation.commandSecretRotatedAt.getTime() <= graceMs
      ) {
        throw resourceConflict(
          'the secret was rotated a moment ago: wait until the previous one stops working'
        )
      }
      // A revoke does not take the lock above: the write itself holds the installation to "active", so a secret is never put on a revoked one
      const written = await tx.pluginInstallation.updateMany({
        where: { id: installationId, storeId: store.id, status: PluginInstallationStatus.ACTIVE },
        data: {
          commandSecret: sealCommandSecret(this.cipher, secret),
          commandSecretPrevious: installation.commandSecret,
          commandSecretRotatedAt: now
        }
      })
      if (written.count !== 1) throw resourceNotFound('plugin installation')
      return { pluginId: installation.pluginId, now }
    })
    // Never the secret: only which installation it was rotated for
    this.audit.log({
      action: AuditAction.PLUGIN_COMMAND_SECRET_ROTATED,
      actor: { userId: actor.userId },
      storeId: store.id,
      resourceType: 'plugin_installation',
      resourceId: installationId,
      metadata: { pluginId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    await this.sync.announceChange()
    return {
      commandSecret: secret,
      rotatedAt: now.toISOString(),
      previousValidUntil: new Date(now.getTime() + graceMs).toISOString()
    }
  }
}
