import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import type { Gauge } from '@prometheus-io/client'

import { PrismaService } from '@platform/core/database'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

import { workerRoleVerdict, WorkerRoleVerdicts } from './worker-role.policy'

// rls-context: the one query reads pg_roles, a catalog of the server with no row of any store, inside withoutTenantContext
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
    let bypassesRls: boolean | undefined
    try {
      // A superuser skips row security too, with or without the flag
      const rows = await this.prisma.withoutTenantContext(
        'pg_roles is a catalog of the server, not a table of a store',
        () =>
          this.prisma.client.$queryRaw<Array<{ bypass: boolean }>>`
        SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`
      )
      bypassesRls = rows[0]?.bypass
    } catch (error) {
      // With the flag off this is only a diagnostic and must not stop the start; with it on, not knowing is not safe
      if (this.contextOn) throw error
      this.logger.warn(
        `the role of the worker could not be checked: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    if (bypassesRls !== undefined) this.gauge.set(bypassesRls ? 1 : 0)
    const verdict = workerRoleVerdict({ bypassesRls, contextOn: this.contextOn })
    if (verdict === WorkerRoleVerdicts.FAIL) {
      throw new Error(
        bypassesRls === undefined
          ? 'the role of the worker could not be read while WORKER_RLS_CONTEXT is on'
          : 'the worker role skips row-level security (BYPASSRLS or superuser) while WORKER_RLS_CONTEXT is on: remove it from the role or turn the flag off'
      )
    }
    if (verdict === WorkerRoleVerdicts.WARN) {
      this.logger.warn(
        bypassesRls === undefined
          ? 'the role of the worker was not found in pg_roles'
          : 'the worker role skips row-level security; WORKER_RLS_CONTEXT is off'
      )
    }
  }
}
