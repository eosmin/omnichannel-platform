import { type ExecutionContext, Injectable, Logger } from '@nestjs/common'
import {
  ThrottlerException,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerRequest
} from '@nestjs/throttler'
import type { Response } from 'express'

import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { ErrorCodes, HttpHeaders, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// The rate limit is a protection, not a dependency of the service: when its storage fails (Redis is
// down), the request goes on and the failure is logged, instead of every route answering 500.
// Refusing is still refused. Nothing that the limit guards is guessable in the meantime: the tokens
// of the login have 256 bits. The limit that must hold (the magic link per address) is checked by
// its own service, which fails with the storage, and the queue it needs is down with it.
@Injectable()
export class ResilientThrottlerGuard extends ThrottlerGuard {
  private readonly storageLogger = new Logger(ResilientThrottlerGuard.name)

  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps)
    } catch (error) {
      if (error instanceof ThrottlerException || error instanceof PlatformException) throw error
      this.storageLogger.error(
        `rate limit storage failed, letting the request through: ${error instanceof Error ? error.message : 'unknown error'}`
      )
      return true
    }
  }

  // The refusal says how long to wait (the body of the 429 and Retry-After, which the filter writes from it) and what the limit is,
  // in the same headers a client that is not refused would have seen (H-11). Nest's own refusal carries a message and nothing else.
  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<Response>()
    response.setHeader(HttpHeaders.RATE_LIMIT_LIMIT, String(detail.limit))
    response.setHeader(HttpHeaders.RATE_LIMIT_REMAINING, '0')
    response.setHeader(HttpHeaders.RATE_LIMIT_RESET, String(detail.timeToExpire))
    throw new PlatformException(
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      'Too many requests',
      HttpStatusCodes.TOO_MANY_REQUESTS,
      { [RETRY_AFTER_METADATA_KEY]: Math.max(Math.ceil(detail.timeToBlockExpire), 1) }
    )
  }
}
