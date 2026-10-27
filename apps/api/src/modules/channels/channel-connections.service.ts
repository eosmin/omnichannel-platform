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
  ChannelHealthLimits
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

import type { Actor } from '../tenancy'

import { type ConnectChannelBody, connectResultSchema } from './channel-connections.schemas'

type ConnectionWrite = Parameters<PrismaTransaction['channelConnection']['updateMany']>[0]['data']

// What the settings page shows of a connection. The credentials are never part of it.
export interface ChannelConnectionView {
  id: string
  pluginId: string
  displayName: string
  status: ChannelConnectionStatus
  lastHealthyAt: Date | null
  lastError: string | null
  createdAt: Date
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

function view(row: {
  id: string
  pluginId: string
  displayName: string
  status: string
  lastHealthyAt: Date | null
  lastError: string | null
  createdAt: Date
}): ChannelConnectionView {
  return {
    ...row,
    status: enumValueOf(ChannelConnectionStatus, row.status, 'channel connection status')
  }
}

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

  async list(storeId: string): Promise<ChannelConnectionView[]> {
    const rows = await this.prisma.client.channelConnection.findMany({
      where: { storeId },
      select: VIEW_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(view)
  }

  async get(storeId: string, connectionId: string): Promise<ChannelConnectionView> {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, storeId },
      select: VIEW_SELECT
    })
    if (row === null) throw resourceNotFound('channel connection')
    return view(row)
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
          lastHealthyAt: new Date()
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
      connection = await store()
    } catch (error) {
      // The store lock is shared, so two connects of a new account can both find nothing: the unique
      // index decides, and the second one runs again to find what the first wrote (and conflict, or
      // update its own)
      if (!isUniqueViolation(error)) throw error
      connection = await store()
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
    return view(connection)
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
    return view(done.saved)
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
