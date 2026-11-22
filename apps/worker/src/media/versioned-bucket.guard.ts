import { Inject, Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import {
  BucketProtections,
  BucketProtectionStates,
  StoredFileSweepGuard,
  SWEEP_NEEDS_VERSIONING
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

// Whether a sweep that rewrites stored files (pictures, documents) may run now. A rewrite replaces the original under the same key, and the
// versioning of the bucket is the only way to get that original back (owner's decision, 2026-11-21, TDD_03 §7.3), so in a deployed environment
// (`staging`, `production`) a sweep takes no batch unless the bucket says versioning is on: off, unknown (no permission, a store without the
// call) and no answer in time all count as off. Elsewhere (a laptop, CI: SeaweedFS has no policy to read) it always allows. The bucket is asked
// on every run, so a versioning turned on is seen at the next one and one turned off stops the sweep at once. Never throws.
@Injectable()
export class VersionedBucketGuard {
  constructor(
    private readonly storage: StorageService,
    @Inject(SWEEP_NEEDS_VERSIONING) private readonly required: boolean,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(VersionedBucketGuard.name)
  }

  async allows(sweep: string): Promise<boolean> {
    if (!this.required) return true
    try {
      const report = await this.storage.inspectProtection(StoredFileSweepGuard.INSPECT_TIMEOUT_MS)
      const versioning = report[BucketProtections.VERSIONING]
      if (versioning === BucketProtectionStates.ON) return true
      this.logger.warn(
        { sweep, versioning },
        'a sweep that rewrites stored files did not run: the bucket does not show versioning on (TDD_03 §7.3)'
      )
    } catch (error) {
      this.logger.warn(
        { sweep, errorName: errorName(error) },
        'a sweep that rewrites stored files did not run: the versioning of the bucket could not be checked'
      )
    }
    return false
  }
}
