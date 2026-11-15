import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { CacheKeys } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  ChannelHealthLimits,
  OfActiveInstallation,
  RemoteChannelHealthLimits
} from '@platform/core/domain'
import { REDIS_CLIENT } from '@platform/core/redis'
import { PluginRegistry } from '@platform/plugins/runtime'

import { CONNECTION_ROW_SELECT } from './channel-context.factory'
import { ChannelHealthService } from './channel-health.service'
import { errorName } from './timeout'

// The health round of the connections of the plugins that run outside the platform (TDD_10 §6.7.7). One check for each
// connection, ten at a time, so a plugin that is slow delays its own checks and not the others'. A failed check does not put the
// connection in error: three in a row do (a count kept in Redis for an hour), and a healthy one clears the count and brings the
// connection back. The official plugins keep the round of `ChannelHealthService.checkAll`.
@Injectable()
export class RemoteChannelHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: ChannelHealthService,
    private readonly registry: PluginRegistry,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(RemoteChannelHealthService.name)
  }

  async checkAll(
    budgetMs: number = ChannelHealthLimits.ROUND_BUDGET_MS
  ): Promise<{ checked: number; unhealthy: number }> {
    const rows = await this.prisma.client.channelConnection.findMany({
      where: {
        status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
        ...OfActiveInstallation
      },
      select: { id: true, pluginId: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }]
    })
    const ids = rows.filter(row => this.registry.isRemote(row.pluginId))
    const deadline = Date.now() + budgetMs
    const result = { checked: 0, unhealthy: 0 }
    let next = 0
    const worker = async (): Promise<void> => {
      while (Date.now() < deadline) {
        const item = ids[next]
        next += 1
        if (item === undefined) return
        await this.checkOne(item.id, result)
      }
    }
    await Promise.all(Array.from({ length: RemoteChannelHealthLimits.CONCURRENCY }, worker))
    if (next < ids.length) {
      this.logger.warn({ left: ids.length - next }, 'the remote health round ran out of time')
    }
    return result
  }

  private async checkOne(
    connectionRowId: string,
    result: { checked: number; unhealthy: number }
  ): Promise<void> {
    try {
      const row = await this.prisma.client.channelConnection.findFirst({
        where: {
          id: connectionRowId,
          status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
          ...OfActiveInstallation
        },
        select: CONNECTION_ROW_SELECT
      })
      if (row === null) return // Disconnected or gone since the round began
      const plugin = this.registry.isRemote(row.pluginId)
        ? this.registry.find(row.pluginId)
        : undefined
      if (plugin === undefined) return
      const checked = await this.health.check(row, plugin)
      result.checked += 1
      const key = CacheKeys.channel.healthFailures(row.id)
      if (checked.healthy) {
        // A count that could not be cleared is not "recovered": an error here leaves the state as it was
        await this.redis.del(key)
        await this.health.record(row, checked)
        return
      }
      result.unhealthy += 1
      // One command: a count with no life would survive for ever. Set at every failure, so the count of a connection that stops
      // failing is gone in an hour.
      const answers = await this.redis
        .multi()
        .incr(key)
        .expire(key, RemoteChannelHealthLimits.FAILURES_TTL_SECONDS)
        .exec()
      const failures = Number(answers?.[0]?.[1] ?? 0)
      // The first failures are only counted: a plugin that restarts must not show the agents a banner
      if (failures >= RemoteChannelHealthLimits.FAILURES_TO_ERROR) {
        await this.health.record(row, checked)
      }
    } catch (error) {
      // One connection must not stop the others; a Redis that is down leaves the state as it was (nothing is concluded without the count)
      this.logger.error(
        { errorName: errorName(error), connection: connectionRowId },
        'a remote health check could not be recorded'
      )
    }
  }
}
