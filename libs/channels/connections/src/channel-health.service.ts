import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  ChannelHealthErrors,
  ChannelHealthLimits
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { ChannelDisconnectedReasons, Events } from '@platform/core/events'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  type ConnectionRow
} from './channel-context.factory'
import { providerText } from './provider-text'
import { errorName, withTimeout } from './timeout'

export interface CheckedHealth {
  healthy: boolean
  // Said by the plugin, so it is cut and cleaned; absent when healthy
  error?: string
}

// A plugin may be a third party's: what it answers is checked before it is used
const reportSchema = z.object({ healthy: z.boolean(), error: z.string().optional() })

// The state of a connection follows what its plugin says about it (TDD_10 §10): a failed check puts an
// active one in error, a good one brings it back, and a disconnected one is left alone.
@Injectable()
export class ChannelHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contexts: ChannelContextFactory,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ChannelHealthService.name)
  }

  // Asks the plugin. A plugin that fails, or answers nonsense, is an unhealthy one and this does not
  // throw for it. The context is built first and outside of that: if the credentials cannot be opened
  // (a key that is not the one that sealed them, a corrupt row) the fault is ours, the provider was
  // never asked, and the state of the connection must not change because of it.
  async check(row: ConnectionRow, plugin: ChannelPlugin): Promise<CheckedHealth> {
    const context = this.contexts.contextFor(row)
    try {
      const report = reportSchema.safeParse(
        await withTimeout(plugin.healthCheck(context), ChannelHealthLimits.CHECK_TIMEOUT_MS)
      )
      if (!report.success) {
        return { healthy: false, error: ChannelHealthErrors.INVALID_REPORT }
      }
      if (report.data.healthy) return { healthy: true }
      // Cleaned first, then the fallback: a reason made of invisible characters is no reason
      const reason = providerText(report.data.error ?? '', ChannelHealthLimits.ERROR_MAX_LENGTH)
      return { healthy: false, error: reason === '' ? ChannelHealthErrors.UNSPECIFIED : reason }
    } catch (error) {
      // The message of the error may hold a token: only its name is logged, and none of it is stored
      this.logger.warn(
        { pluginId: row.pluginId, connection: row.id, errorName: errorName(error) },
        'health check failed'
      )
      return { healthy: false, error: ChannelHealthErrors.CHECK_FAILED }
    }
  }

  // Writes what the check found, and says it when the connection changes state. Every write names the
  // state it expects (the store lock is shared and keeps nobody out), so a disconnect that happens
  // meanwhile wins, and the event goes out only for the one write that made the change.
  async record(row: ConnectionRow, health: CheckedHealth): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, row.storeId)
      const where = { id: row.id, storeId: row.storeId }
      const payload = { storeId: row.storeId, channelConnectionId: row.id, pluginId: row.pluginId }
      if (!health.healthy) {
        const lastError = health.error ?? ChannelHealthErrors.UNSPECIFIED
        const down = await tx.channelConnection.updateMany({
          where: { ...where, status: ChannelConnectionStatus.ACTIVE },
          data: { status: ChannelConnectionStatus.ERROR, lastError }
        })
        if (down.count === 1) {
          this.events.publish(tx, Events.CHANNEL_DISCONNECTED, {
            ...payload,
            reason: ChannelDisconnectedReasons.ERROR
          })
          return
        }
        await tx.channelConnection.updateMany({
          where: { ...where, status: ChannelConnectionStatus.ERROR },
          data: { lastError }
        })
        return
      }
      const data = { lastError: null, lastHealthyAt: new Date() }
      const back = await tx.channelConnection.updateMany({
        where: { ...where, status: ChannelConnectionStatus.ERROR },
        data: { ...data, status: ChannelConnectionStatus.ACTIVE }
      })
      if (back.count === 1) {
        this.events.publish(tx, Events.CHANNEL_HEALTH_RESTORED, payload)
        return
      }
      await tx.channelConnection.updateMany({
        where: { ...where, status: ChannelConnectionStatus.ACTIVE },
        data
      })
    })
  }

  // Every connection that is up or in error, a few at a time, the one checked longest ago first. A
  // plugin that is not registered any more is skipped and said: nothing to ask. The round stops
  // starting checks when its budget is spent.
  async checkAll(
    findPlugin: (pluginId: string) => ChannelPlugin | undefined,
    budgetMs: number = ChannelHealthLimits.ROUND_BUDGET_MS
  ): Promise<{ checked: number; unhealthy: number }> {
    // The ids first, and each row only when its turn comes: a round is long, and a connection
    // reconnected or disconnected meanwhile must be asked with what it has now, not with what it had
    const ids = await this.prisma.client.channelConnection.findMany({
      where: {
        status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] }
      },
      select: { id: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }]
    })
    const deadline = Date.now() + budgetMs
    const result = { checked: 0, unhealthy: 0 }
    let next = 0
    // A pool and not batches: one slow connection holds one place, not the five
    const worker = async (): Promise<void> => {
      while (Date.now() < deadline) {
        const item = ids[next]
        next += 1
        if (item === undefined) return
        await this.checkOne(item.id, findPlugin, result)
      }
    }
    await Promise.all(Array.from({ length: ChannelHealthLimits.CONCURRENCY }, worker))
    if (next < ids.length) {
      this.logger.warn({ left: ids.length - next }, 'the health round ran out of time')
    }
    return result
  }

  private async checkOne(
    connectionRowId: string,
    findPlugin: (pluginId: string) => ChannelPlugin | undefined,
    result: { checked: number; unhealthy: number }
  ): Promise<void> {
    try {
      const row = await this.prisma.client.channelConnection.findFirst({
        where: {
          id: connectionRowId,
          status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] }
        },
        select: CONNECTION_ROW_SELECT
      })
      if (row === null) return // Disconnected or gone since the round began
      const plugin = findPlugin(row.pluginId)
      if (plugin === undefined) {
        this.logger.warn({ pluginId: row.pluginId }, 'no plugin to check a connection with')
        return
      }
      const health = await this.check(row, plugin)
      await this.record(row, health)
      result.checked += 1
      if (!health.healthy) result.unhealthy += 1
    } catch (error) {
      // One connection must not stop the others
      this.logger.error(
        { errorName: errorName(error), connection: connectionRowId },
        'recording a health check failed'
      )
    }
  }
}
