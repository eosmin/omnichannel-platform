import { Injectable } from '@nestjs/common'
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus'

import { StorageService } from '@platform/core/storage-module'

const DEFAULT_TIMEOUT_MS = 2000

@Injectable()
export class StorageHealthIndicator {
  constructor(
    private readonly storage: StorageService,
    private readonly indicators: HealthIndicatorService
  ) {}

  // A HeadBucket: the bucket exists and the credentials reach it (TDD_04 §4)
  isHealthy(key: string, options: { timeoutMs?: number } = {}): PromiseLike<HealthIndicatorResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return this.indicators
      .check(key)
      .attempt(async () => {
        await this.storage.checkBucket(timeoutMs)
      })
      .withTimeout(timeoutMs)
  }
}
