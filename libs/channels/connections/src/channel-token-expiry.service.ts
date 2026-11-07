import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  ChannelMetadataKeys,
  isExpiryNoticeDue,
  isRecheckDue,
  lastAskedAt,
  OfActiveInstallation,
  readTokenAttemptAt,
  readTokenInfo,
  TokenExpiryLimits,
  type TokenInfo,
  TokenInfoKeys
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  type ConnectionRow,
  CredentialsUnreadableError
} from './channel-context.factory'
import { errorName, withTimeout } from './timeout'

// The states in which a connection is written: a disconnected one is left as it is
const LIVE_STATUSES = [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR]

// A little over the time the call itself is given, so that the call's own deadline is the one that speaks
const ASK_TIMEOUT_MS = TokenExpiryLimits.REQUEST_TIMEOUT_MS + 2_000

// What the provider says about the token of each connection, kept in its metadata and announced to the people
// who set the channel up before the token stops (TDD_10 section 10). It never keeps the token, and a question
// that could not be asked leaves what was known: only a date that Meta gave and that has passed means
// "expired", and only Meta saying the token is not valid means "invalid".
@Injectable()
export class ChannelTokenExpiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contexts: ChannelContextFactory,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ChannelTokenExpiryService.name)
  }

  // Asks about one connection of one store and writes the answer. It never throws: it is run after a
  // connection is made, where a failure must not undo the connect, and in a round, where one connection must
  // not stop the others. Returns whether an answer was written.
  async refresh(
    connectionRowId: string,
    storeId: string,
    plugin: ChannelPlugin | undefined,
    now: Date = new Date()
  ): Promise<boolean> {
    let row: ConnectionRow | null = null
    try {
      if (plugin?.inspectToken === undefined) return false
      row = await this.prisma.client.channelConnection.findFirst({
        where: {
          id: connectionRowId,
          storeId,
          status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
          ...OfActiveInstallation
        },
        select: CONNECTION_ROW_SELECT
      })
      if (row === null) return false
      let context
      try {
        context = this.contexts.contextFor(row)
      } catch (error) {
        if (!(error instanceof CredentialsUnreadableError)) throw error
        await this.markAttempt(row, now) // The health check says what is wrong; this is not asked again at once
        return false
      }
      const inspection = await withTimeout(plugin.inspectToken(context), ASK_TIMEOUT_MS)
      const expiresAt = inspection.expiresAt === null ? null : inspection.expiresAt.toISOString()
      // `expiryNotifiedFor` is settled by the write itself, from what the row holds when it takes its lock
      const info: TokenInfo = {
        kind: inspection.kind,
        isValid: inspection.isValid,
        expiresAt,
        scopes: inspection.scopes,
        checkedAt: now.toISOString(),
        expiryNotifiedFor: null
      }
      const written = await this.write(row, info, now)
      if (written && !info.isValid && row.status === String(ChannelConnectionStatus.ACTIVE)) {
        // Meta says the token does not work and the connection is still up: the health check will take it down
        // on its next round. It must not pass in silence.
        this.logger.warn(
          { connection: row.id, storeId, pluginId: row.pluginId, kind: info.kind },
          'a connection is up but its token is reported as not valid'
        )
      }
      return written
    } catch (error) {
      // Only the name: the message of an error from the provider can echo what was sent
      this.logger.warn(
        { connection: connectionRowId, storeId, errorName: errorName(error) },
        'the token of a connection could not be asked about'
      )
      // The question counts as asked: a connection that always fails is tried again in its turn, not first in
      // every round, where it would take the place of the ones that can be answered
      if (row !== null) await this.markAttempt(row, now)
      return false
    }
  }

  // The connections that are due, the one asked about longest ago first (one never asked about is first), up
  // to the calls a round may make and the time it may take.
  async runDue(
    findPlugin: (pluginId: string) => ChannelPlugin | undefined,
    maxCalls: number = TokenExpiryLimits.RUN_MAX_CALLS,
    budgetMs: number = TokenExpiryLimits.ROUND_BUDGET_MS,
    now: Date = new Date()
  ): Promise<{ asked: number; written: number }> {
    const rows = await this.prisma.client.channelConnection.findMany({
      where: {
        status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
        ...OfActiveInstallation
      },
      select: { id: true, storeId: true, pluginId: true, metadata: true }
    })
    const due = rows
      .filter(row => findPlugin(row.pluginId)?.inspectToken !== undefined)
      .map(row => ({
        row,
        info: readTokenInfo(row.metadata),
        attemptAt: readTokenAttemptAt(row.metadata)
      }))
      .filter(({ info, attemptAt }) => isRecheckDue(info, attemptAt, now))
      // Never asked first, then the one asked longest ago, whether it was answered or not
      .sort(
        (a, b) => (lastAskedAt(a.info, a.attemptAt) ?? 0) - (lastAskedAt(b.info, b.attemptAt) ?? 0)
      )
      .slice(0, maxCalls)
    const deadline = Date.now() + budgetMs
    const result = { asked: 0, written: 0 }
    for (const { row } of due) {
      if (Date.now() >= deadline) {
        this.logger.warn({ left: due.length - result.asked }, 'the token round ran out of time')
        break
      }
      result.asked += 1
      if (await this.refresh(row.id, row.storeId, findPlugin(row.pluginId), now)) {
        result.written += 1
      }
    }
    if (rows.length > 0 && due.length === maxCalls) {
      this.logger.warn({ maxCalls }, 'the token round reached its limit of questions')
    }
    return result
  }

  // Notes that the provider was asked about this connection now, whatever came of it. Under the same guards
  // as the answer; best effort, because it is itself a reaction to a failure.
  private async markAttempt(
    row: { id: string; storeId: string; credentials: Uint8Array },
    now: Date
  ): Promise<void> {
    try {
      await this.prisma.client.$executeRaw`
        UPDATE channel_connections
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[${ChannelMetadataKeys.TOKEN_ATTEMPT_AT}::text], to_jsonb(${now.toISOString()}::text), true)
        WHERE id = ${row.id} AND store_id = ${row.storeId} AND credentials = ${Buffer.from(row.credentials)}
          AND status = ANY(${LIVE_STATUSES}::text[])`
    } catch (error) {
      this.logger.warn(
        { connection: row.id, errorName: errorName(error) },
        'a question was not noted'
      )
    }
  }

  // One statement per key under the lock of the row: a writer that changes another key of the metadata (the
  // reason of a failure, a label) is not overwritten, and a connection whose credentials were replaced while
  // Meta answered (a new token) is not written with the answer about the old one. The notice is claimed by
  // the same transaction that announces it, so two rounds cannot both announce one date.
  private async write(
    row: { id: string; storeId: string; pluginId: string; credentials: Uint8Array },
    info: TokenInfo,
    now: Date
  ): Promise<boolean> {
    const credentials = Buffer.from(row.credentials)
    const key = ChannelMetadataKeys.TOKEN_INFO
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, row.storeId)
      const stored = await tx.$executeRaw`
        UPDATE channel_connections
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          ARRAY[${key}::text],
          ${JSON.stringify(info)}::jsonb || jsonb_build_object(
            ${TokenInfoKeys.EXPIRY_NOTIFIED_FOR}::text,
            CASE WHEN (metadata -> ${key}::text ->> ${TokenInfoKeys.EXPIRES_AT}::text) IS NOT DISTINCT FROM ${info.expiresAt}::text
                 THEN metadata -> ${key}::text -> ${TokenInfoKeys.EXPIRY_NOTIFIED_FOR}::text
                 ELSE 'null'::jsonb END),
          true)
        WHERE id = ${row.id} AND store_id = ${row.storeId} AND credentials = ${credentials}
          AND status = ANY(${LIVE_STATUSES}::text[])`
      if (stored !== 1) return false
      if (info.expiresAt !== null && isExpiryNoticeDue(info, now)) {
        // Claimed only if no one has announced this date: `expiryNotifiedFor` is read in the statement itself
        const claimed = await tx.$executeRaw`
          UPDATE channel_connections
          SET metadata = jsonb_set(metadata, ARRAY[${key}::text, ${TokenInfoKeys.EXPIRY_NOTIFIED_FOR}::text], to_jsonb(${info.expiresAt}::text), true)
          WHERE id = ${row.id} AND store_id = ${row.storeId} AND credentials = ${credentials}
            AND status = ${ChannelConnectionStatus.ACTIVE}
            AND (metadata -> ${key}::text ->> ${TokenInfoKeys.EXPIRY_NOTIFIED_FOR}::text) IS DISTINCT FROM ${info.expiresAt}`
        if (claimed === 1) {
          this.events.publish(tx, Events.CHANNEL_TOKEN_EXPIRING, {
            storeId: row.storeId,
            channelConnectionId: row.id,
            pluginId: row.pluginId,
            expiresAt: info.expiresAt
          })
        }
      }
      return true
    })
  }
}
