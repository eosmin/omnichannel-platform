import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  ChannelHealthService,
  errorName,
  providerText,
  withTimeout
} from '@platform/channels/connections'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import {
  isUniqueViolation,
  lockStoreForWrite,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  ChannelConnectionLimits,
  ChannelConnectionStatus,
  ChannelHealthLimits,
  OfActiveInstallation,
  PluginInstallationStatus,
  PluginStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { ChannelDisconnectedReasons, Events } from '@platform/core/events'
import { enumValueOf } from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'
import type { ChannelCapabilityType, ChannelPlugin } from '@platform/plugins/sdk'

import type { Actor } from '../tenancy'

import {
  type ConnectChannelBody,
  type ConnectResult,
  connectResultSchema
} from './channel-connections.schemas'

type ConnectionWrite = Parameters<PrismaTransaction['channelConnection']['updateMany']>[0]['data']
type InstallationReader = Pick<PrismaTransaction, '$queryRaw'>

// What the settings page shows of a connection. The credentials are never part of it.
export interface ChannelConnectionView {
  id: string
  pluginId: string
  displayName: string
  status: ChannelConnectionStatus
  lastHealthyAt: Date | null
  lastError: string | null
  createdAt: Date
  // What the channel can do (`ChannelCapability`), so that the web app decides which actions to draw
  // without knowing any channel by name. Static per plugin.
  capabilities: ChannelCapabilityType[]
}

export interface ChannelTestResult {
  healthy: boolean
  checkedAt: Date
  error?: string
}

const VIEW_SELECT = {
  id: true,
  pluginId: true,
  displayName: true,
  status: true,
  lastHealthyAt: true,
  lastError: true,
  createdAt: true
} as const

type ConnectionRow = Omit<ChannelConnectionView, 'status' | 'capabilities'> & { status: string }

// The connections of the store of the request (TDD_10 §10). Every read and write is filtered by that
// store; the plugin is the one of the registry, and what it returns is checked before it is kept.
@Injectable()
export class ChannelConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly health: ChannelHealthService,
    private readonly cipher: CredentialCipher,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ChannelConnectionsService.name)
  }

  private view(row: ConnectionRow): ChannelConnectionView {
    // Field by field: whatever else a query selects must not reach the response
    return {
      id: row.id,
      pluginId: row.pluginId,
      displayName: row.displayName,
      status: enumValueOf(ChannelConnectionStatus, row.status, 'channel connection status'),
      lastHealthyAt: row.lastHealthyAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      capabilities: this.registry.capabilitiesOf(row.pluginId)
    }
  }

  async list(storeId: string): Promise<ChannelConnectionView[]> {
    const rows = await this.prisma.client.channelConnection.findMany({
      where: { storeId },
      select: VIEW_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(row => this.view(row))
  }

  async get(storeId: string, connectionId: string): Promise<ChannelConnectionView> {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, storeId },
      select: VIEW_SELECT
    })
    if (row === null) throw resourceNotFound('channel connection')
    return this.view(row)
  }

  // The call to the provider happens before the transaction: it can be slow, and a row lock held
  // across a network call would block the store. A connection that belongs to another store is a
  // conflict, never a takeover; one that its store disconnected is released first (see below).
  async connect(
    storeId: string,
    pluginId: string,
    body: ConnectChannelBody,
    actor: Actor
  ): Promise<ChannelConnectionView> {
    if (!this.registry.isVisibleTo(pluginId, storeId)) throw resourceNotFound('channel')
    const plugin = this.registry.get(pluginId)
    // Before the provider hears of it: connecting a plugin the store has not installed is refused
    await this.installationOf(this.prisma.client, storeId, pluginId)

    let result
    let sealed
    try {
      result = connectResultSchema.parse(
        await withTimeout(
          plugin.connect({ storeId, credentials: body.credentials }),
          ChannelHealthLimits.PROVIDER_TIMEOUT_MS
        )
      )
      // Sealed here and not in the transaction: what cannot be written as JSON, or is too large, is
      // refused as what it is, a plugin that answered badly
      sealed = this.cipher.seal(result.credentials)
    } catch (error) {
      // What the provider said may echo the credentials: it is not logged nor sent back
      this.logger.warn({ pluginId, storeId, errorName: errorName(error) }, 'connect failed')
      throw new PlatformException(
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        'the provider did not accept the connection',
        HttpStatusCodes.BAD_REQUEST
      )
    }

    const store = () =>
      this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        // Read again with the row locked: the uninstall changes that row, so it waits for this
        // connection to commit and then disconnects it, and a connection is never added to an
        // installation that was revoked a moment ago
        const installationId = await this.installationOf(tx, storeId, pluginId)
        let existing = await tx.channelConnection.findUnique({
          where: { pluginId_connectionId: { pluginId, connectionId: result.connectionId } },
          select: { id: true, storeId: true, status: true, connectionId: true }
        })
        if (existing !== null && existing.storeId !== storeId) {
          if (existing.status !== String(ChannelConnectionStatus.DISCONNECTED)) {
            throw resourceConflict('this account is connected to another store')
          }
          // Its store let it go. The row stays with that store, because its conversations point at it,
          // and gives up the key (plugin, account) so that this store can have it.
          // Conditional: its store may have reconnected it since it was read, and then it keeps it
          const released = await tx.channelConnection.updateMany({
            where: {
              id: existing.id,
              storeId: existing.storeId,
              status: ChannelConnectionStatus.DISCONNECTED
            },
            data: { connectionId: `${existing.connectionId}~released~${existing.id}` }
          })
          if (released.count !== 1) {
            throw resourceConflict('this account is connected to another store')
          }
          existing = null
        }
        const data = {
          // Cleaned, and the account id if nothing is left of it
          displayName:
            providerText(result.displayName, ChannelConnectionLimits.DISPLAY_NAME_MAX_LENGTH) ||
            result.connectionId,
          status: ChannelConnectionStatus.ACTIVE,
          credentials: sealed,
          metadata: result.metadata,
          lastError: null,
          lastHealthyAt: new Date(),
          installationId
        }
        const row =
          existing === null
            ? await tx.channelConnection.create({
                data: { ...data, storeId, pluginId, connectionId: result.connectionId },
                select: VIEW_SELECT
              })
            : await this.reconnect(tx, existing, storeId, data)
        this.events.publish(tx, Events.CHANNEL_CONNECTED, {
          storeId,
          channelConnectionId: row.id,
          pluginId
        })
        return row
      })
    let connection
    try {
      try {
        connection = await store()
      } catch (error) {
        // The store lock is shared, so two connects of a new account can both find nothing: the
        // unique index decides, and the second one runs again to find what the first wrote (and
        // conflict, or update its own)
        if (!isUniqueViolation(error)) throw error
        connection = await store()
      }
    } catch (error) {
      // The plugin was uninstalled while the provider was answering: no row will ever hold this
      // account, so nothing else would tell the provider to let it go
      if (error instanceof PlatformException && error.code === ErrorCodes.PLUGIN_NOT_INSTALLED) {
        await this.releaseAccount(plugin, storeId, pluginId, result, sealed)
      }
      throw error
    }
    this.audit.log({
      action: AuditAction.CHANNEL_CONNECTED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'channel_connection',
      resourceId: connection.id,
      metadata: { pluginId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.view(connection)
  }

  // Tells the provider to drop an account that was connected and could not be kept, if no row holds
  // it. Whether the provider answers is not up to it: the request is refused either way.
  private async releaseAccount(
    plugin: ChannelPlugin,
    storeId: string,
    pluginId: string,
    result: ConnectResult,
    sealed: Uint8Array
  ): Promise<void> {
    try {
      // An account that a row holds, of this store or of another, is not ours to release
      const holder = await this.prisma.client.channelConnection.findUnique({
        where: { pluginId_connectionId: { pluginId, connectionId: result.connectionId } },
        select: { id: true }
      })
      if (holder !== null) return
      await withTimeout(
        plugin.disconnect(
          this.contexts.contextFor({
            id: result.connectionId,
            storeId,
            pluginId,
            connectionId: result.connectionId,
            status: ChannelConnectionStatus.ACTIVE,
            credentials: sealed,
            metadata: result.metadata
          })
        ),
        ChannelHealthLimits.PROVIDER_TIMEOUT_MS
      )
    } catch (error) {
      this.logger.warn(
        { pluginId, storeId, errorName: errorName(error) },
        'the provider did not release the account'
      )
    }
  }

  // The id of the active installation of the plugin in the store: the connection hangs from it (D19).
  // A suspended plugin is refused too. FOR SHARE, not the KEY SHARE of the store lock, because the uninstall updates the status and
  // that is the lock it conflicts with.
  private async installationOf(
    db: InstallationReader,
    storeId: string,
    pluginId: string
  ): Promise<string> {
    const [installation] = await db.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM plugin_installations i
      JOIN plugins p ON p.id = i.plugin_id
      WHERE i.store_id = ${storeId} AND i.plugin_id = ${pluginId}
        AND i.status = ${PluginInstallationStatus.ACTIVE}
        AND p.status = ${PluginStatus.APPROVED}
      FOR SHARE OF i`
    if (installation === undefined) {
      throw new PlatformException(
        ErrorCodes.PLUGIN_NOT_INSTALLED,
        'the plugin is not installed in this store',
        HttpStatusCodes.CONFLICT
      )
    }
    return installation.id
  }

  // The same account of the same store again. The write names the account id it read: another store
  // may have released this very row a moment ago (it was disconnected), and then it is no longer ours.
  private async reconnect(
    tx: PrismaTransaction,
    existing: { id: string; connectionId: string },
    storeId: string,
    data: ConnectionWrite
  ) {
    const updated = await tx.channelConnection.updateMany({
      where: { id: existing.id, storeId, connectionId: existing.connectionId },
      data
    })
    if (updated.count !== 1) throw resourceConflict('this account is connected to another store')
    return tx.channelConnection.findUniqueOrThrow({
      where: { id: existing.id },
      select: VIEW_SELECT
    })
  }

  // Asks the plugin now and writes the answer, as the scheduler would
  async test(storeId: string, connectionId: string): Promise<ChannelTestResult> {
    const row = await this.rowOf(storeId, connectionId)
    if (row.status === String(ChannelConnectionStatus.DISCONNECTED)) {
      throw resourceConflict('the connection is disconnected')
    }
    // A stranded connection (its installation was revoked) is not probed: it is only disconnected
    const working = await this.prisma.client.channelConnection.count({
      where: { id: connectionId, storeId, ...OfActiveInstallation }
    })
    if (working === 0) throw resourceConflict('the plugin is not installed in this store')
    const plugin = this.registry.find(row.pluginId)
    if (plugin === undefined) throw resourceNotFound('channel')
    const checkedAt = new Date()
    const checked = await this.health.check(row, plugin)
    await this.health.record(row, checked)
    // Disconnected while it was being asked: the verdict is about a connection that is no more
    if ((await this.get(storeId, connectionId)).status === ChannelConnectionStatus.DISCONNECTED) {
      throw resourceConflict('the connection is disconnected')
    }
    return {
      healthy: checked.healthy,
      checkedAt,
      ...(checked.error === undefined ? {} : { error: checked.error })
    }
  }

  // The provider is told, but whether it answers is not up to it: the connection is down here either
  // way, and its credentials are replaced by an empty set. The row stays, because the conversations
  // that went through it point at it. The change is one conditional write, so of two disconnects at
  // once only one changes, audits and announces it; the other finds it done.
  async disconnect(
    storeId: string,
    connectionId: string,
    actor: Actor
  ): Promise<ChannelConnectionView> {
    const row = await this.rowOf(storeId, connectionId)
    if (row.status !== String(ChannelConnectionStatus.DISCONNECTED)) {
      const plugin = this.registry.find(row.pluginId)
      if (plugin !== undefined) {
        try {
          await withTimeout(
            plugin.disconnect(this.contexts.contextFor(row)),
            ChannelHealthLimits.PROVIDER_TIMEOUT_MS
          )
        } catch (error) {
          this.logger.warn(
            { pluginId: row.pluginId, storeId, errorName: errorName(error) },
            'the provider did not confirm the disconnect'
          )
        }
      }
    }
    const done = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const changed = await tx.channelConnection.updateMany({
        where: { id: connectionId, storeId, status: { not: ChannelConnectionStatus.DISCONNECTED } },
        data: {
          status: ChannelConnectionStatus.DISCONNECTED,
          credentials: this.cipher.seal({}),
          lastError: null
        }
      })
      if (changed.count === 1) {
        this.events.publish(tx, Events.CHANNEL_DISCONNECTED, {
          storeId,
          channelConnectionId: connectionId,
          pluginId: row.pluginId,
          reason: ChannelDisconnectedReasons.USER
        })
      }
      const saved = await tx.channelConnection.findFirst({
        where: { id: connectionId, storeId },
        select: VIEW_SELECT
      })
      if (saved === null) throw resourceNotFound('channel connection')
      return { saved, changed: changed.count === 1 }
    })
    if (done.changed) {
      this.audit.log({
        action: AuditAction.CHANNEL_DISCONNECTED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: 'channel_connection',
        resourceId: connectionId,
        metadata: { pluginId: row.pluginId },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.view(done.saved)
  }

  private async rowOf(storeId: string, connectionId: string) {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, storeId },
      select: CONNECTION_ROW_SELECT
    })
    if (row === null) throw resourceNotFound('channel connection')
    return row
  }
}
