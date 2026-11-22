// rls-context: every database access of this run happens inside `unit` (JobContext.inOrganization), one short unit per page and per value
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { JobContext } from '@platform/core/database'
import { FiscalLimits } from '@platform/core/domain'
import { FiscalResealService } from '@platform/fiscal/runtime'

// The nightly step of a rotation of CREDENTIALS_ENCRYPTION_KEY (Step 7.3-S11b): while the deployment holds a previous key, the fiscal
// values of the organization that open only with it are sealed again with the current one. Without a previous key it does nothing and reads
// nothing. A value that cannot be handled is counted and logged by its failure code; the job fails when any was, so the queue (and the
// alarm of a failed job) tells the operator that the previous key cannot be retired yet.
@Injectable()
export class FiscalResealer {
  constructor(
    private readonly reseal: FiscalResealService,
    private readonly jobContext: JobContext,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalResealer.name)
  }

  async reconcile(organizationId: string): Promise<void> {
    const report = await this.reseal.run(organizationId, work =>
      this.jobContext.inOrganization(organizationId, work, {
        maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
        timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
      })
    )
    const failed = Object.values(report.failed).reduce((sum, n) => sum + n, 0)
    if (report.enabled || report.masked > 0 || failed > 0) {
      this.logger.info(
        { organizationId, ...report },
        'the fiscal values were checked for the previous key and the masks'
      )
    }
    if (failed > 0) {
      throw new Error(
        `${failed} fiscal values were not sealed again or masked (see the log by code)`
      )
    }
  }
}
