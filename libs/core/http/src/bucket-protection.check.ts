import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import type { Gauge } from '@prometheus-io/client'

import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  bucketProtectionGaps,
  BucketProtections,
  BucketProtectionStates
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

export const BUCKET_PROTECTION_CHECK_ENABLED = Symbol('BUCKET_PROTECTION_CHECK_ENABLED')

const TIMEOUT_MS = 5000

// Nothing in the repository provisions the production bucket, so when the api starts it asks the bucket for the two
// protections TDD_03 §7.3 requires (encryption at rest, versioning) and says what is missing: a warning in the log and a
// gauge to alert on. It never stops the api: a bucket without them still serves, and the person who can fix it is not
// the one a failed boot would reach. Only a deployed environment is judged: the local store has neither.
@Injectable()
export class BucketProtectionCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(BucketProtectionCheck.name)

  constructor(
    private readonly storage: StorageService,
    @Inject(BUCKET_PROTECTION_CHECK_ENABLED) private readonly enabled: boolean,
    @InjectMetric(MetricNames.STORAGE_BUCKET_PROTECTION_GAP) private readonly gap: Gauge<string>
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return
    try {
      const report = await this.storage.inspectProtection(TIMEOUT_MS)
      const gaps = bucketProtectionGaps(report)
      for (const protection of Object.values(BucketProtections)) {
        this.gap.set({ protection }, gaps.includes(protection) ? 1 : 0)
      }
      for (const protection of gaps) {
        this.logger.warn(
          report[protection] === BucketProtectionStates.UNKNOWN
            ? `the bucket does not say whether ${protection} is on: check it (TDD_03 §7.3)`
            : `the bucket has no ${protection}: turn it on (TDD_03 §7.3)`
        )
      }
    } catch (error) {
      this.logger.warn(
        `the protection of the bucket could not be checked: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
