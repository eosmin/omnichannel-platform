import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common'
import type { ThrottlerStorage } from '@nestjs/throttler'
import type { Counter } from '@prometheus-io/client'

import { AuthenticatedUserRateLimit } from '@platform/core/auth'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

import { spendUserBudget } from './spend-user-budget'
import { USER_RATE_LIMIT_STORAGE } from './user-rate-limit.guard'

// The general budget of every authenticated person (TDD_05 §3.1): a global guard that runs right after the token, so `request.user` is known. A request with no user (public routes, the probes, the plugin api, which has the limit
// of its installation) is not counted here: the per-address default already holds it. It is counted apart from the budget of the
// routes that name their own profile (@UserRateLimit), which spend both.
@Injectable()
export class AuthenticatedUserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AuthenticatedUserRateLimitGuard.name)

  constructor(
    @Inject(USER_RATE_LIMIT_STORAGE) private readonly storage: ThrottlerStorage,
    @InjectMetric(MetricNames.RATE_LIMIT_HITS) private readonly hits: Counter<string>
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // The global guards also run on the websocket gateways, which have their own caps: this budget is the HTTP one
    if (context.getType() !== 'http') return true
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (user === undefined) return true
    await spendUserBudget(this.storage, this.hits, this.logger, user.id, AuthenticatedUserRateLimit)
    return true
  }
}
