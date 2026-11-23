// rls-context: every database access of this run happens inside `unit` (JobContext.inOrganization), one short unit per page and per value
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { JobContext } from '@platform/core/database'
import { CredentialsReseal } from '@platform/core/domain'

import { CredentialsResealService } from './credentials-reseal.service'

// The nightly step of a rotation of CREDENTIALS_ENCRYPTION_KEY for the sealed values outside the fiscal area (Step 7.3-S11c): while the
// deployment holds a previous key, what opens only with it is sealed again with the current one. Without a previous key it does nothing and
// reads nothing. A value that cannot be handled is counted and logged by its failure code (the first lines of a run, then a count); the job
// fails when any was, so the retry is visible in the log. The scheduler does not keep failed jobs (removeOnFail), so the operator learns of it
// from the log, which the runbook asks to keep until the old key is retired, not from a failed-jobs alarm.
@Injectable()
export class CredentialsResealer {
  constructor(
    private readonly reseal: CredentialsResealService,
    private readonly jobContext: JobContext,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(CredentialsResealer.name)
  }

  get enabled(): boolean {
    return this.reseal.enabled
  }

  async reconcile(organizationId: string): Promise<void> {
    const report = await this.reseal.run(organizationId, work =>
      this.jobContext.inOrganization(organizationId, work, {
        maxWait: CredentialsReseal.CONTEXT_MAX_WAIT_MS,
        timeout: CredentialsReseal.CONTEXT_TIMEOUT_MS
      })
    )
    if (!report.enabled) return
    this.logger.info(
      { organizationId, ...report },
      'the sealed credentials were checked for the previous key'
    )
    const failed = Object.values(report.failed).reduce((sum, n) => sum + n, 0)
    if (failed > 0) {
      throw new Error(`${failed} sealed values were not sealed again (see the log by code)`)
    }
  }
}
