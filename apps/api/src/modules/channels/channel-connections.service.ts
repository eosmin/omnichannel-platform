import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  ChannelHealthService,
  connectReasonOfError,
  CredentialsUnreadableError,
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
  type ChannelAuthMethod,
  ChannelConnectionLimits,
  ChannelConnectionListStates,
  ChannelConnectionStatus,
  type CursorPage,
  ChannelHealthLimits,
  isInstallationActive,
  MembershipStatus,
  OfActiveInstallation,
  PluginInstallationStatus,
  PluginStatus
} from '@platform/core/domain'
import {
  ChannelConnectFailureReasons,
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
import {
  ChannelCapability,
  type ChannelCapabilityType,
  type ChannelPlugin,
  PluginError,
  pluginFailureLog
} from '@platform/plugins/sdk'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import {
  type ConnectChannelBody,
  type ConnectResult,
  connectResultSchema,
  type ListConnectionsQuery
} from './channel-connections.schemas'

// One shape for the refusal, with the name of the holder only when the caller may be told
function accountInUseException(storeName: string | null): PlatformException {
  return new PlatformException(
    ErrorCodes.CHANNEL_ACCOUNT_IN_USE,
    'this account is connected to another store',
    HttpStatusCodes.CONFLICT,
    storeName === null ? undefined : { storeName }
  )
}

type ConnectionWrite = Parameters<PrismaTransaction['channelConnection']['updateMany']>[0]['data']
type InstallationReader = Pick<PrismaTransaction, '$queryRaw'>

// What the settings page shows of a connection. The credentials are never part of it.
export interface ChannelConnectionView {
  id: string
  pluginId: string
  // What is shown as the name: the label the owner gave, or the name of the account while there is none
  displayName: string
  // The label the owner gave, if any, and the name of the account at the provider (what `displayName` is
  // without a label), so that the form that names it can say what it goes back to
  label: string | null
  accountName: string
  status: ChannelConnectionStatus
  lastHealthyAt: Date | null
  lastError: string | null
  createdAt: Date
  // What the channel can do (`ChannelCapability`), so that the web app decides which actions to draw
  // without knowing any channel by name. Static per plugin.
  capabilities: ChannelCapabilityType[]
  // How reading the name and photo of customers goes through this connection; null for a channel
  // that has no such thing
  profile: ConnectionProfileStatus | null
}

// Step 2.8 (1c-2): the profile of a customer is read by a job, and a refusal is stored on the identity
// (`profileFetchError`, a code of ours). This counts them, so that the owner learns what is missing.
export interface ConnectionProfileStatus {
  // Customers of this connection whose last read failed
  failedIdentities: number
  errors: { code: string; identities: number }[]
  // Message key of the step the owner takes at the provider (Messenger: "Business Asset User Profile
  // Access"); only present while some read fails
  setupKey: string | null
}

// What any agent may know of a connection: enough to name the channel in the inbox, to draw only the
// actions it supports and to tell one that is down (`status`, public on purpose: an agent must know
// that a reply cannot go out). `lastError` and the dates belong to who manages channels.
export type ChannelDirectoryEntry = Pick<
  ChannelConnectionView,
  'id' | 'pluginId' | 'displayName' | 'status' | 'capabilities'
> & {
  // What the channel is called ("WhatsApp"), for the filter that groups the accounts of one plugin
  pluginName: string
}

export interface ChannelTestResult {
  healthy: boolean
  checkedAt: Date
  error?: string
}

const CONNECTION_ORDER: ({ createdAt: 'asc' } | { id: 'asc' })[] = [
  { createdAt: 'asc' },
  { id: 'asc' }
]

const VIEW_SELECT = {
  id: true,
  pluginId: true,
  displayName: true,
  label: true,
  status: true,
  lastHealthyAt: true,
  lastError: true,
  createdAt: true
} as const

type ConnectionRow = Omit<
  ChannelConnectionView,
  'status' | 'capabilities' | 'profile' | 'accountName'
> & {
  status: string
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

  private view(
    row: ConnectionRow,
    profiles: ReadonlyMap<string, ConnectionProfileStatus>
  ): ChannelConnectionView {
    // Field by field: whatever else a query selects must not reach the response
    return {
      id: row.id,
      pluginId: row.pluginId,
      displayName: row.label ?? row.displayName,
      label: row.label,
      accountName: row.displayName,
      status: enumValueOf(ChannelConnectionStatus, row.status, 'channel connection status'),
      lastHealthyAt: row.lastHealthyAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      capabilities: this.registry.capabilitiesOf(row.pluginId),
      profile: this.registry.hasCapability(row.pluginId, ChannelCapability.CUSTOMER_PROFILE)
        ? (profiles.get(row.id) ?? this.noProfileFailures())
        : null
    }
  }

  private noProfileFailures(): ConnectionProfileStatus {
    return { failedIdentities: 0, errors: [], setupKey: null }
  }

  // The failed profile reads of the store, by connection, in one query: the identities that have a
  // conversation through the connection, grouped by the code stored. Filtered by the store on both
  // tables. The setup step is the plugin's, and only shown while something fails.
  private async profileStatuses(
    storeId: string,
    rows: readonly { id: string; pluginId: string }[]
  ): Promise<Map<string, ConnectionProfileStatus>> {
    const statuses = new Map<string, ConnectionProfileStatus>()
    const asked = rows.filter(row =>
      this.registry.hasCapability(row.pluginId, ChannelCapability.CUSTOMER_PROFILE)
    )
    if (asked.length === 0) return statuses
    const counted = await this.prisma.client.$queryRaw<
      { connectionId: string; code: string; identities: number }[]
    >`
      SELECT c.channel_connection_id AS "connectionId",
             i.profile_fetch_error AS "code",
             COUNT(DISTINCT i.id)::int AS "identities"
      FROM customer_identities i
      JOIN conversations c ON c.customer_identity_id = i.id AND c.store_id = i.store_id
      WHERE i.store_id = ${storeId}
        AND i.profile_fetch_error IS NOT NULL
        AND c.channel_connection_id = ANY(${asked.map(row => row.id)}::text[])
      GROUP BY c.channel_connection_id, i.profile_fetch_error
      ORDER BY c.channel_connection_id, i.profile_fetch_error`
    for (const row of asked) {
      const mine = counted.filter(entry => entry.connectionId === row.id)
      const failed = mine.reduce((total, entry) => total + entry.identities, 0)
      statuses.set(row.id, {
        failedIdentities: failed,
        errors: mine.map(entry => ({ code: entry.code, identities: entry.identities })),
        setupKey:
          failed > 0
            ? (this.registry.connectManifestOf(row.pluginId)?.profileSetupKey ?? null)
            : null
      })
    }
    return statuses
  }

  // A read says what it found or fails, like the list does
  private async viewOf(storeId: string, row: ConnectionRow): Promise<ChannelConnectionView> {
    return this.view(row, await this.profileStatuses(storeId, [row]))
  }

  // The answer of an operation that already happened (connect, disconnect) must not fail because the
  // count of profile errors could not be read: it is told as none, and the next list says the truth
  private async viewAfterWrite(
    storeId: string,
    row: ConnectionRow
  ): Promise<ChannelConnectionView> {
    try {
      return this.view(row, await this.profileStatuses(storeId, [row]))
    } catch (error) {
      this.logger.warn({ storeId, errorName: errorName(error) }, 'profile status not read')
      return this.view(row, new Map())
    }
  }

  // One page, oldest first: the position is the (createdAt, id) of the last row, so a connection
  // made or removed while the person reads does not shift the next page
  async list(
    storeId: string,
    query: ListConnectionsQuery
  ): Promise<CursorPage<ChannelConnectionView>> {
    const { cursor, state, limit } = query
    const disconnected = ChannelConnectionStatus.DISCONNECTED
    const rows = await this.prisma.client.channelConnection.findMany({
      where: {
        storeId,
        ...(state === ChannelConnectionListStates.LIVE ? { status: { not: disconnected } } : {}),
        ...(state === ChannelConnectionListStates.PAST ? { status: disconnected } : {}),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } }
              ]
            })
      },
      select: VIEW_SELECT,
      orderBy: CONNECTION_ORDER,
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    // The profile errors are counted for this page only, never for the whole store
    const profiles = await this.profileStatuses(storeId, page)
    return {
      data: page.map(row => this.view(row, profiles)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  // Its own select, not the full view cut down: whatever a column holds that only who manages channels
  // may read (the error text, the dates) never leaves the database for this route. A connection whose
  // installation is gone or whose plugin was suspended is inert (D19): it is told as `error`, because
  // a reply cannot go out through it, whatever its own row says.
  async directory(storeId: string): Promise<ChannelDirectoryEntry[]> {
    const rows = await this.prisma.client.channelConnection.findMany({
      where: { storeId },
      select: {
        id: true,
        pluginId: true,
        displayName: true,
        label: true,
        status: true,
        installation: { select: { status: true, plugin: { select: { status: true } } } }
      },
      orderBy: CONNECTION_ORDER
    })
    return rows.map(row => ({
      id: row.id,
      pluginId: row.pluginId,
      pluginName: this.pluginNameOf(row.pluginId),
      displayName: row.label ?? row.displayName,
      status: isInstallationActive(row.installation)
        ? enumValueOf(ChannelConnectionStatus, row.status, 'channel connection status')
        : ChannelConnectionStatus.ERROR,
      capabilities: this.registry.capabilitiesOf(row.pluginId)
    }))
  }

  // Nothing checks the name of a plugin when it registers, so it is not trusted to be a string. It goes
  // through the same cleaning as any text from a provider, and a cut that leaves a joiner at the end
  // (in the middle of an emoji family) loses it.
  private pluginNameOf(pluginId: string): string {
    const name: unknown = this.registry.find(pluginId)?.name
    const clean =
      typeof name === 'string'
        ? providerText(name, ChannelConnectionLimits.PLUGIN_NAME_MAX_LENGTH).replace(
            /[\u200C\u200D]+$/u,
            ''
          )
        : ''
    return clean === '' ? pluginId : clean
  }

  async get(storeId: string, connectionId: string): Promise<ChannelConnectionView> {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, storeId },
      select: VIEW_SELECT
    })
    if (row === null) throw resourceNotFound('channel connection')
    return this.viewOf(storeId, row)
  }

  // The call to the provider happens before the transaction: it can be slow, and a row lock held
  // across a network call would block the store. A connection that belongs to another store is a
  // conflict, never a takeover; one that its store disconnected is released first (see below).
  // The plugin must be installed in the store: it is how the login checks it before sending the person to
  // the provider, and how `connect` checks it before the provider hears of anything
  async ensureInstalled(storeId: string, pluginId: string): Promise<void> {
    await this.installationOf(this.prisma.client, storeId, pluginId)
  }

  async connect(
    storeId: string,
    pluginId: string,
    body: ConnectChannelBody,
    actor: Actor,
    // How the credentials were obtained, kept in the metadata of the connection when the login says it. A
    // connection with none was made with what the person pasted or typed (a token, a phone number, the sites
    // of a widget): there is nothing to say of it.
    options: { authMethod?: ChannelAuthMethod } = {}
  ): Promise<ChannelConnectionView> {
    const { authMethod } = options
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
      throw this.providerRefusal(error, pluginId, storeId)
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
            throw await this.accountInUse(tx, existing.storeId, actor.userId)
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
          if (released.count !== 1)
            throw await this.accountInUse(tx, existing.storeId, actor.userId)
          existing = null
        }
        const data = {
          // Cleaned, and the account id if nothing is left of it
          displayName:
            providerText(result.displayName, ChannelConnectionLimits.DISPLAY_NAME_MAX_LENGTH) ||
            result.connectionId,
          status: ChannelConnectionStatus.ACTIVE,
          credentials: sealed,
          // Last, so that a plugin cannot say how it was connected through the login
          metadata: authMethod === undefined ? result.metadata : { ...result.metadata, authMethod },
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
      metadata: authMethod === undefined ? { pluginId } : { pluginId, authMethod },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.viewAfterWrite(storeId, connection)
  }

  // What the provider said may echo the credentials: it is not logged nor sent back.
  // Only the name of the error, the numbers of the provider's answer and the name of the local check
  // that refused: never the message, a value or the token (see pluginFailureLog)
  private providerRefusal(
    error: unknown,
    pluginId: string,
    storeId: string,
    operation = 'connect failed'
  ): PlatformException {
    this.logger.warn({ pluginId, storeId, ...pluginFailureLog(error) }, operation)
    // The code stays one, so a page older than the server shows its generic message. The reason is a
    // name of a closed list (never the provider's words, a value or an id) that says what to do; the
    // page that knows it shows it.
    // A call that took longer than the time given to it is the provider being slow, not a bad token
    const reason = connectReasonOfError(error)
    return new PlatformException(
      ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
      'the provider did not accept the connection',
      HttpStatusCodes.BAD_REQUEST,
      reason === undefined ? undefined : { reason }
    )
  }

  // A new token for a connection that exists, in this order:
  // 1. Who the token belongs to is READ, with the plugin's health check run on the credentials the
  //    connection would have (the new secret over what it already holds). Nothing is subscribed and
  //    nothing is written yet, so the token of another account or Page leaves no trace on that account.
  // 2. Only when it is the same account, `connect` runs (it subscribes the app again) and the sealed
  //    credentials of THIS row are replaced in one transaction under the store lock.
  // The row, its name, its account id and its conversations are the ones it had. Another store's
  // connection, or none, is the same 404.
  async updateToken(
    storeId: string,
    connectionId: string,
    body: ConnectChannelBody,
    actor: Actor
  ): Promise<ChannelConnectionView> {
    const row = await this.rowOf(storeId, connectionId)
    if (row.status === String(ChannelConnectionStatus.DISCONNECTED)) {
      throw resourceConflict('the connection is disconnected')
    }
    const working = await this.prisma.client.channelConnection.count({
      where: { id: connectionId, storeId, ...OfActiveInstallation }
    })
    if (working === 0) throw resourceConflict('the plugin is not installed in this store')
    const plugin = this.registry.find(row.pluginId)
    if (plugin === undefined) throw resourceNotFound('channel')
    const fields = this.registry.connectManifestOf(row.pluginId)?.connectFields ?? []
    const secretKeys = fields.filter(field => field.secret).map(field => field.key)
    if (secretKeys.length === 0) throw resourceConflict('this channel has no token to replace')

    // What the connection already holds that is not secret stays; of what arrives only the secret
    // fields count, so this cannot be used to change the account the connection points at
    let held: Record<string, unknown> = {}
    // The metadata is plain JSON and is read whatever the state of the sealed credentials: a plugin may
    // compare it (Instagram keeps its Page id there), and without it the right token would look foreign
    const metadata: Record<string, unknown> =
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? Object.fromEntries(Object.entries(row.metadata))
        : {}
    try {
      held = this.contexts.contextFor(row).credentials
    } catch (error) {
      // Only credentials that cannot be opened: that is the very case this fixes, and nothing is kept from
      // them. Any other failure is a defect and must not pass as one
      if (!(error instanceof CredentialsUnreadableError)) throw error
      this.logger.warn(
        { pluginId: row.pluginId, storeId, errorName: errorName(error) },
        'the credentials of a connection cannot be read'
      )
    }
    const credentials: Record<string, unknown> = {}
    for (const field of fields) {
      if (!field.secret && field.key in held) credentials[field.key] = held[field.key]
    }
    // A secret that is not sent is kept, but at least one must be: nothing is replaced by sending nothing
    if (!secretKeys.some(key => key in body.credentials)) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        'the provider did not accept the connection',
        HttpStatusCodes.BAD_REQUEST,
        { reason: ChannelConnectFailureReasons.TOKEN_MALFORMED }
      )
    }
    for (const key of secretKeys) {
      if (key in body.credentials) credentials[key] = body.credentials[key]
      else if (key in held) credentials[key] = held[key]
    }

    let result
    let sealed
    try {
      const report = await withTimeout(
        plugin.healthCheck({
          storeId,
          connectionId: row.connectionId,
          credentials,
          metadata
        }),
        ChannelHealthLimits.CHECK_TIMEOUT_MS
      )
      // A plugin may be a third party's: only a true boolean says the account is the one held
      if (report.healthy !== true) throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      result = connectResultSchema.parse(
        await withTimeout(
          plugin.connect({ storeId, credentials }),
          ChannelHealthLimits.PROVIDER_TIMEOUT_MS
        )
      )
      sealed = this.cipher.seal(result.credentials)
    } catch (error) {
      throw this.providerRefusal(error, row.pluginId, storeId, 'token update refused')
    }
    // The read said it is the account of the connection; a plugin that now names another is refused
    // and nothing is written; what it subscribed on the account it named is let go if no row holds it
    if (result.connectionId !== row.connectionId) {
      await this.releaseAccount(plugin, storeId, row.pluginId, result, sealed)
      throw new PlatformException(
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        'the provider did not accept the connection',
        HttpStatusCodes.BAD_REQUEST,
        { reason: ChannelConnectFailureReasons.OTHER_ACCOUNT }
      )
    }

    const saved = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await this.installationOf(tx, storeId, row.pluginId)
      // Named by the account it read: a connection released or disconnected meanwhile is not written
      // and still holding the credentials it had when it was read: a disconnect and a reconnect with another
      // token while the provider answered must not be overwritten by this older one
      const where = {
        id: row.id,
        storeId,
        connectionId: row.connectionId,
        credentials: row.credentials
      }
      const data = {
        credentials: sealed,
        metadata: result.metadata,
        lastError: null,
        lastHealthyAt: new Date()
      }
      const restored = await tx.channelConnection.updateMany({
        where: { ...where, status: ChannelConnectionStatus.ERROR },
        data: { ...data, status: ChannelConnectionStatus.ACTIVE }
      })
      const stayed =
        restored.count === 1
          ? 0
          : (
              await tx.channelConnection.updateMany({
                where: { ...where, status: ChannelConnectionStatus.ACTIVE },
                data
              })
            ).count
      if (restored.count + stayed !== 1) {
        throw resourceConflict('the connection changed while the token was being checked')
      }
      if (restored.count === 1) {
        this.events.publish(tx, Events.CHANNEL_HEALTH_RESTORED, {
          storeId,
          channelConnectionId: row.id,
          pluginId: row.pluginId
        })
      }
      await this.forgetProfileRefusals(tx, storeId, row.id)
      return tx.channelConnection.findFirstOrThrow({
        where: { id: row.id, storeId },
        select: VIEW_SELECT
      })
    })
    this.audit.log({
      action: AuditAction.CHANNEL_TOKEN_UPDATED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'channel_connection',
      resourceId: row.id,
      metadata: { pluginId: row.pluginId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.viewAfterWrite(storeId, saved)
  }

  // The owner just gave the provider new credentials or permissions: a refusal recorded before says
  // nothing about them. Forget it on the customers that wrote through this connection, and let their
  // next message ask again (a null date is a stale profile). A customer whose read succeeded keeps its date.
  private async forgetProfileRefusals(
    tx: PrismaTransaction,
    storeId: string,
    rowId: string
  ): Promise<void> {
    await tx.customerIdentity.updateMany({
      where: {
        storeId,
        profileFetchError: { not: null },
        conversations: { some: { storeId, channelConnectionId: rowId } }
      },
      data: { profileFetchError: null, profileFetchedAt: null, profileRetryAfter: null }
    })
  }

  // The account lives in another store, and that is a rule, not a clash of two edits. The store is
  // named only to somebody who is an active member of it (suspended or removed does not count): to
  // anybody else the answer is the same whatever the other store is, and carries nothing of it. The
  // name is user text, cleaned as the text of a provider is and cut, and it is the only thing sent.
  private async accountInUse(
    tx: PrismaTransaction,
    holderStoreId: string,
    userId: string
  ): Promise<PlatformException> {
    const membership = await tx.membership.findFirst({
      where: {
        userId,
        storeId: holderStoreId,
        status: MembershipStatus.ACTIVE,
        revokedAt: null
      },
      select: { store: { select: { name: true } } }
    })
    // Cut like any provider text, and no joiner is left dangling by the cut
    const storeName =
      membership === null
        ? ''
        : providerText(
            membership.store.name,
            ChannelConnectionLimits.DISPLAY_NAME_MAX_LENGTH
          ).replace(/[\u200C\u200D]+$/u, '')
    return accountInUseException(storeName === '' ? null : storeName)
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
    if (updated.count !== 1) {
      // Another store took the account meanwhile: which one is not looked up, and nothing is said of it
      throw accountInUseException(null)
    }
    await this.forgetProfileRefusals(tx, storeId, existing.id)
    return tx.channelConnection.findUniqueOrThrow({
      where: { id: existing.id },
      select: VIEW_SELECT
    })
  }

  // The name the owner gives to a connection, or none (null) to go back to the name of the account. Only that
  // column is written, and only for a connection of this store that is not disconnected: the account id, the
  // credentials and the status are not reachable from here.
  async rename(
    storeId: string,
    connectionId: string,
    label: string | null,
    actor: Actor
  ): Promise<ChannelConnectionView> {
    // Only what is needed: the credentials of the row are not read to name it
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, storeId },
      select: { pluginId: true, status: true, label: true }
    })
    if (row === null) throw resourceNotFound('channel connection')
    if (row.status === String(ChannelConnectionStatus.DISCONNECTED)) {
      throw resourceConflict('the connection is disconnected')
    }
    if (row.label !== label) {
      const changed = await this.prisma.client.channelConnection.updateMany({
        where: { id: connectionId, storeId, status: { not: ChannelConnectionStatus.DISCONNECTED } },
        data: { label }
      })
      // Disconnected while it was being named: nothing was written
      if (changed.count !== 1) throw resourceConflict('the connection is disconnected')
      // The label is the owner's own text, not a secret: what it was and what it is stay in the trail
      this.audit.log({
        action: AuditAction.CHANNEL_RENAMED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: 'channel_connection',
        resourceId: connectionId,
        metadata: { pluginId: row.pluginId, label, previousLabel: row.label },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    // The answer of a write that happened must not fail because the profile errors could not be counted
    const saved = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, storeId },
      select: VIEW_SELECT
    })
    if (saved === null) throw resourceNotFound('channel connection')
    return this.viewAfterWrite(storeId, saved)
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
    return this.viewAfterWrite(storeId, done.saved)
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
