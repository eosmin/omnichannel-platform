import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import type { Gauge } from '@prometheus-io/client'

import { PrismaService } from '@platform/core/database'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

import { workerRoleVerdict, WorkerRoleVerdicts } from './worker-role.policy'

// At start the worker asks the database whether the role it connects with skips row-level security (TDD_01 §3.2). Only the flag
// WORKER_RLS_CONTEXT turns a bypassing role into a failed start; see workerRoleVerdict.
export const WORKER_RLS_CONTEXT_ON = Symbol('WORKER_RLS_CONTEXT_ON')

@Injectable()
export class WorkerRoleCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerRoleCheck.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WORKER_RLS_CONTEXT_ON) private readonly contextOn: boolean,
    @InjectMetric(MetricNames.WORKER_ROLE_BYPASSES_RLS) private readonly gauge: Gauge<string>
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.prisma.client.$queryRaw<Array<{ bypass: boolean }>>`
      SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    const bypassesRls = rows[0]?.bypass === true
    this.gauge.set(bypassesRls ? 1 : 0)
    const verdict = workerRoleVerdict({ bypassesRls, contextOn: this.contextOn })
    if (verdict === WorkerRoleVerdicts.FAIL) {
      throw new Error(
        'the worker role skips row-level security (BYPASSRLS) while WORKER_RLS_CONTEXT is on: remove BYPASSRLS from the role or turn the flag off'
      )
    }
    if (verdict === WorkerRoleVerdicts.WARN) {
      this.logger.warn(
        'the worker role skips row-level security (BYPASSRLS); WORKER_RLS_CONTEXT is off'
      )
    }
  }
}
