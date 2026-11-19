import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import {
  inSavepoint,
  isUniqueViolation,
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  ChannelConnectionStatus,
  PluginInstallationStatus,
  PluginStatus,
  RemoteChannelApiLimits,
  RemoteChannelLockScopes
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { ChannelDisconnectedReasons, Events } from '@platform/core/events'
import { findConnectionHolder } from '@platform/core/messaging'
import { PluginTypes } from '@platform/plugins/sdk'

import { type Actor, auditActorOf, auditViaOf } from '../tenancy/actor'

import type { PutConnectionBody } from './plugin-channel.schemas'

export interface PluginCaller {
  // The installation of the key and the plugin it belongs to: both come from the guard, never from the request
  installationId: string
  pluginId: string
  storeId: string
}

export function connectionNotFound(): PlatformException {
  return new PlatformException(
    ErrorCodes.CHANNEL_CONNECTION_NOT_FOUND,
    'the connection was not found',
    HttpStatusCodes.NOT_FOUND
  )
}

const NOT_DISCONNECTED = { not: ChannelConnectionStatus.DISCONNECTED }

// The accounts of a remote channel plugin (TDD_10 §6.7.5, `channel:connections`). The plugin owns the provider and its login; this
// is the one place where it says "this account is now linked" or "it is not any more". Everything here is bound to the INSTALLATION
// of the key: the store comes from its row, the plugin id from its row, and a connection is touched only if it hangs from this
// installation. The credentials column stays and holds an empty object: the platform never holds the provider's secrets.
@Injectable()
export class PluginChannelConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  // Creates or updates the connection, or reactivates one that was disconnected. True when the row is new (201), false otherwise (200)
  async put(
    caller: PluginCaller,
    connectionId: string,
    body: PutConnectionBody,
    actor: Actor
  ): Promise<boolean> {
    let outcome: { created: boolean; id: string; connected: boolean }
    try {
      outcome = await inSavepoint(() => this.write(caller, connectionId, body))
    } catch (error) {
      // The store lock is the store's own, so two stores that register the same new account at once can both find nothing: the
      // unique index decides, and the loser runs again to find the row of the winner, and conflict
      if (!isUniqueViolation(error)) throw error
      outcome = await this.write(caller, connectionId, body)
    }
    // Only a connection that was made or brought back is a connection: a plugin that keeps its name up to date leaves no trace here
    if (outcome.connected) {
      this.audit.log({
        action: AuditAction.CHANNEL_CONNECTED,
        actor: auditActorOf(actor),
        storeId: caller.storeId,
        resourceType: 'channel_connection',
        resourceId: outcome.id,
        metadata: { pluginId: caller.pluginId, ...auditViaOf(actor) },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return outcome.created
  }

  // Sets it DISCONNECTED, keeping the row and its conversations. Idempotent for one that already is; a connection that is not one of
  // this installation's is the same 404 as one that does not exist
  async disconnect(caller: PluginCaller, connectionId: string, actor: Actor): Promise<void> {
    const changed = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, caller.storeId)
      // The same lock as the `PUT` of the account: a disconnect and a put of it take turns
      await lockStoreScope(
        tx,
        caller.storeId,
        `${RemoteChannelLockScopes.CONNECTION}:${caller.pluginId}:${connectionId}`
      )
      const row = await tx.channelConnection.findFirst({
        where: {
          pluginId: caller.pluginId,
          connectionId,
          storeId: caller.storeId,
          installationId: caller.installationId
        },
        select: { id: true, status: true }
      })
      if (row === null) throw connectionNotFound()
      const result = await tx.channelConnection.updateMany({
        where: { id: row.id, storeId: caller.storeId, status: NOT_DISCONNECTED },
        data: {
          status: ChannelConnectionStatus.DISCONNECTED,
          credentials: this.cipher.seal({}),
          lastError: null
        }
      })
      if (result.count === 1) {
        this.events.publish(tx, Events.CHANNEL_DISCONNECTED, {
          storeId: caller.storeId,
          channelConnectionId: row.id,
          pluginId: caller.pluginId,
          // The plugin did what an agent does in the settings page: it took the account down
          reason: ChannelDisconnectedReasons.USER
        })
      }
      return result.count === 1 ? row.id : null
    })
    if (changed === null) return
    this.audit.log({
      action: AuditAction.CHANNEL_DISCONNECTED,
      actor: auditActorOf(actor),
      storeId: caller.storeId,
      resourceType: 'channel_connection',
      resourceId: changed,
      metadata: { pluginId: caller.pluginId, ...auditViaOf(actor) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  private write(
    caller: PluginCaller,
    connectionId: string,
    body: PutConnectionBody
  ): Promise<{ created: boolean; id: string; connected: boolean }> {
    const { storeId, pluginId, installationId } = caller
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The same account twice at once from one store takes turns: the second finds the row of the first and updates it (200). Two
      // stores racing for one new account are settled by the unique index and the retry of `put`
      await lockStoreScope(
        tx,
        storeId,
        `${RemoteChannelLockScopes.CONNECTION}:${pluginId}:${connectionId}`
      )
      // Read again with the store locked: a revoke or a suspension waits for this write to commit and then disconnects what it
      // made, and a connection is never added to an installation that was revoked a moment ago
      const installation = await tx.pluginInstallation.findFirst({
        where: {
          id: installationId,
          storeId,
          pluginId,
          status: PluginInstallationStatus.ACTIVE,
          plugin: { status: PluginStatus.APPROVED, type: PluginTypes.CHANNEL }
        },
        select: { id: true }
      })
      if (installation === null) {
        throw new PlatformException(
          ErrorCodes.PLUGIN_API_KEY_INVALID,
          'the plugin key is not valid',
          HttpStatusCodes.UNAUTHORIZED
        )
      }
      const existing = await tx.channelConnection.findUnique({
        where: { pluginId_connectionId: { pluginId, connectionId } },
        select: { id: true, storeId: true, installationId: true, status: true }
      })
      if (existing === null) {
        // Another store's row is invisible to this transaction once row security is enforced: the same answer as before for it
        const holder = await findConnectionHolder(tx, pluginId, connectionId)
        if (holder !== null && holder.storeId !== storeId) {
          throw resourceConflict('this account is already linked')
        }
      }
      if (existing !== null) {
        // An account is linked to one store at a time, and to one installation of it: another store's, or an installation that is
        // not this one's and is still live, is the plugin's to resolve with a new connectionId. The answer does not say whose.
        if (
          existing.storeId !== storeId ||
          (existing.installationId !== installationId &&
            existing.status !== String(ChannelConnectionStatus.DISCONNECTED))
        ) {
          throw resourceConflict('this account is already linked')
        }
        const reactivating = existing.status === String(ChannelConnectionStatus.DISCONNECTED)
        if (reactivating) await this.assertRoom(tx, installationId)
        const data = {
          displayName: body.displayName,
          ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
          ...(reactivating
            ? {
                status: ChannelConnectionStatus.ACTIVE,
                credentials: this.cipher.seal({}),
                lastError: null,
                lastHealthyAt: new Date(),
                installationId
              }
            : {})
        }
        await tx.channelConnection.update({ where: { id: existing.id }, data })
        if (reactivating) {
          this.events.publish(tx, Events.CHANNEL_CONNECTED, {
            storeId,
            channelConnectionId: existing.id,
            pluginId
          })
        }
        return { created: false, id: existing.id, connected: reactivating }
      }
      await this.assertRoom(tx, installationId)
      const row = await tx.channelConnection.create({
        data: {
          storeId,
          pluginId,
          connectionId,
          displayName: body.displayName,
          status: ChannelConnectionStatus.ACTIVE,
          credentials: this.cipher.seal({}),
          ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
          lastHealthyAt: new Date(),
          installationId
        },
        select: { id: true }
      })
      this.events.publish(tx, Events.CHANNEL_CONNECTED, {
        storeId,
        channelConnectionId: row.id,
        pluginId
      })
      return { created: true, id: row.id, connected: true }
    })
  }

  // One installation holds at most 20 connections that are not DISCONNECTED (the ones that are do not count)
  private async assertRoom(tx: PrismaTransaction, installationId: string): Promise<void> {
    const held = await tx.channelConnection.count({
      where: { installationId, status: NOT_DISCONNECTED }
    })
    if (held >= RemoteChannelApiLimits.MAX_ACTIVE_CONNECTIONS) {
      throw resourceConflict('the installation already holds its limit of connections', {
        limit: RemoteChannelApiLimits.MAX_ACTIVE_CONNECTIONS
      })
    }
  }
}
