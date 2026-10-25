import { Injectable, Logger } from '@nestjs/common'
import { ThrottlerException, ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler'

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
      if (error instanceof ThrottlerException) throw error
      this.storageLogger.error(
        `rate limit storage failed, letting the request through: ${error instanceof Error ? error.message : 'unknown error'}`
      )
      return true
    }
  }
}
