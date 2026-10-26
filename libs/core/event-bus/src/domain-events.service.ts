import { Injectable } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import type { DomainEventPayloads } from '@platform/core/events'

// The one way a service announces that something happened. The event leaves after the transaction
// that wrote it commits, never before: a listener that reacts to a change must find it in the
// database, and a rolled-back change is announced to nobody.
@Injectable()
export class DomainEvents {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DomainEvents.name)
  }

  publish<E extends keyof DomainEventPayloads>(
    tx: PrismaService['client'],
    event: E,
    payload: DomainEventPayloads[E]
  ): void {
    this.prisma.afterCommit(tx, () => {
      const failed = (error: unknown): void => {
        // The change is committed: a listener that fails cannot undo it or fail the request
        this.logger.error({ err: error, event }, 'a domain event listener failed')
      }
      try {
        // Listeners start in order, now; one that returns a promise is not waited for, so what it
        // does after its first await can finish in any order and must not depend on another event
        this.emitter.emitAsync(event, payload).catch(failed)
      } catch (error) {
        failed(error)
      }
    })
  }
}
