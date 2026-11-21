import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { generateToken, hashToken } from '@platform/core/crypto'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PLUGIN_INSTALLATION_RESOURCE_TYPE,
  PluginInstallationStatus,
  PluginInstallLimits,
  PluginLockScopes,
  PluginStatus
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

// What the owner gets, once: the new key and the part of it that is shown again
export interface RotatedPluginApiKey {
  apiKey: string
  apiKeyPrefix: string
  rotatedAt: string
}

// Rotating the API key of an installation (TDD_10 §6.7.3, HC-216). The new key replaces the old one in one write, so the old one
// stops opening the door at that very call: there is no grace window, because a key is rotated when it may be exposed and the lookup
// of the guard is by hash with no cache to wait for. A key that never reached the owner (the answer was lost) is replaced by rotating again. Only the hash and the display prefix are kept; the key itself is in the answer
// of this call and nowhere else (not the log, not the audit entry).
@Injectable()
export class PluginApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async rotate(
    store: { id: string },
    installationId: string,
    actor: Actor
  ): Promise<RotatedPluginApiKey> {
    const apiKey = `${PLUGIN_API_KEY_TOKEN_PREFIX}${generateToken(PluginInstallLimits.KEY_SECRET_BYTES)}`
    const apiKeyPrefix = apiKey.slice(0, PluginInstallLimits.KEY_DISPLAY_PREFIX_LENGTH)
    const { pluginId, now } = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, store.id)
      // The store lock is a shared one: this one makes two rotations of the same installation take turns, so the second reads the
      // hash the first wrote and both succeed in order (the last key is the live one) instead of the second one failing on its swap
      await lockStoreScope(tx, store.id, `${PluginLockScopes.API_KEY}:${installationId}`)
      // Taken under the lock, so the time is that of the order in which rotations took effect
      const now = new Date()
      // The installation is the one of this store and one that is up with an approved plugin: another store's id is "not found",
      // and so is one that is not set up yet (it has no key to replace: the setup code makes the first) or was revoked
      const installation = await tx.pluginInstallation.findFirst({
        where: {
          id: installationId,
          storeId: store.id,
          status: PluginInstallationStatus.ACTIVE,
          // Only an installation that holds a key of its own: the official plugins have none
          plugin: { status: PluginStatus.APPROVED, isOfficial: false }
        },
        select: { pluginId: true, apiKeyHash: true }
      })
      if (installation === null || installation.apiKeyHash === null) {
        throw resourceNotFound('plugin installation')
      }
      // Compare and swap on the hash that was read: a revoke or another rotation that got in between leaves nothing written
      const written = await tx.pluginInstallation.updateMany({
        where: {
          id: installationId,
          storeId: store.id,
          status: PluginInstallationStatus.ACTIVE,
          apiKeyHash: installation.apiKeyHash
        },
        data: { apiKeyPrefix, apiKeyHash: hashToken(apiKey) }
      })
      if (written.count !== 1) throw resourceNotFound('plugin installation')
      return { pluginId: installation.pluginId, now }
    })
    // Never the key: only which installation it was rotated for
    this.audit.log({
      action: AuditAction.PLUGIN_API_KEY_ROTATED,
      actor: { userId: actor.userId },
      storeId: store.id,
      resourceType: PLUGIN_INSTALLATION_RESOURCE_TYPE,
      resourceId: installationId,
      metadata: { pluginId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { apiKey, apiKeyPrefix, rotatedAt: now.toISOString() }
  }
}
