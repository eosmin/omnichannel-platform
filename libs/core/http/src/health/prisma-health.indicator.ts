import { Injectable } from '@nestjs/common'
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus'

import { PrismaService } from '@platform/core/database'

const DEFAULT_TIMEOUT_MS = 3000

@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indicators: HealthIndicatorService
  ) {}

  // A round trip through the same client the requests use, in the same pool
  isHealthy(key: string, options: { timeoutMs?: number } = {}): PromiseLike<HealthIndicatorResult> {
    return this.indicators
      .check(key)
      .attempt(async () => {
        await this.prisma.client.$queryRaw`SELECT 1`
      })
      .withTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }
}
