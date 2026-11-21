import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  UseGuards,
  applyDecorators
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { ThrottlerStorage } from '@nestjs/throttler'
import type { Counter, Histogram } from '@prometheus-io/client'

import { USER_RATE_LIMIT_METADATA_KEY, type UserRateLimitProfile } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

import { spendUserBudget } from './spend-user-budget'

export const USER_RATE_LIMIT_STORAGE = Symbol('USER_RATE_LIMIT_STORAGE')

// Like the per-address layer it is a protection and not a dependency: when Redis fails the request goes on and the failure is
// logged. What it refuses is answered 429 with the time to wait, as the other layer does.
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name)

  constructor(
    private readonly reflector: Reflector,
    @Inject(USER_RATE_LIMIT_STORAGE) private readonly storage: ThrottlerStorage,
    @InjectMetric(MetricNames.RATE_LIMIT_HITS) private readonly hits: Counter<string>,
    @InjectMetric(MetricNames.RATE_LIMIT_BUDGET_USAGE) private readonly usage: Histogram<string>
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const profile = this.reflector.getAllAndOverride<UserRateLimitProfile | undefined>(
      USER_RATE_LIMIT_METADATA_KEY,
      [context.getHandler(), context.getClass()]
    )
    if (profile === undefined) return true
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (user === undefined) {
      // A route of this layer is behind AuthGuard: reaching it without a user is a wiring mistake, never a reason to let
      // an anonymous caller spend nobody's budget
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'a route with a per-user rate limit was reached with no authenticated user',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }
    await spendUserBudget(this.storage, this.hits, this.usage, this.logger, user.id, profile)
    return true
  }
}

// @UserRateLimit(UserRateLimits.SEARCH): the second layer of a route, per authenticated user (TDD_05 §3.1). The guard it adds
// runs after the global ones (token, store, permission), so `request.user` is known; the first layer, per address, is
// @RateLimit() and runs before them.
export const UserRateLimit = (profile: UserRateLimitProfile): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(USER_RATE_LIMIT_METADATA_KEY, profile), UseGuards(UserRateLimitGuard))
