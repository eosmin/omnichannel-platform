import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { Redis } from 'ioredis'
import { z } from 'zod'

import { CacheKeys } from '@platform/core/cache'
import { EVENTS_BRIDGE_CHANNEL, EVENTS_BRIDGE_CLAIM_SECONDS } from '@platform/core/events'
import { REDIS_CLIENT } from '@platform/core/redis'

import { bridgedPayload, isBridged } from './bridged-payloads'

export const EventsBridgeModes = { PUBLISH: 'publish', SUBSCRIBE: 'subscribe' } as const
export type EventsBridgeMode = (typeof EventsBridgeModes)[keyof typeof EventsBridgeModes]

export const EVENTS_BRIDGE_OPTIONS = Symbol('EVENTS_BRIDGE_OPTIONS')

export interface EventsBridgeOptions {
  // publish: the process (the worker) sends what it announces to the api instances. subscribe: the
  // process (the api) hears it and re-emits it in its own bus. Never both, so an event cannot loop.
  mode: EventsBridgeMode
}

const envelopeSchema = z.object({
  id: z.uuid(),
  event: z.string(),
  payload: z.unknown()
})

// The sockets live in the api, and the worker is another process: an event that the worker announces
// (a snooze that woke up, an export that is ready) reaches the api listeners through Redis. What
// travels is the payload of a domain event: ids and plain values.
//
// A bridged event is heard by every api instance and passed on by one, so a listener of the api for
// these events runs on that one instance only: it must not depend on being run on all.
@Injectable()
export class EventsBridge implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsBridge.name)
  private subscriber: Redis | null = null
  private markSubscribed: () => void = () => undefined
  // Settles when Redis has acknowledged the first subscription. Nothing in the boot waits for it
  // (a Redis that is down must not stop the api); a test that publishes at once does.
  readonly subscribed = new Promise<void>(resolve => {
    this.markSubscribed = resolve
  })

  constructor(
    @Inject(EVENTS_BRIDGE_OPTIONS) private readonly options: EventsBridgeOptions,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly emitter: EventEmitter2
  ) {}

  // Best effort, like the rest of the realtime layer: the change is committed already. Only the
  // process that publishes (the worker) does anything: in the api it is a no-op, so that an event
  // cannot loop back through the channel the api listens to.
  publish(event: string, payload: object): void {
    if (this.options.mode !== EventsBridgeModes.PUBLISH) return
    // Only the events the api acts on, and only the fields it reads of them
    const kept = bridgedPayload(event, payload)
    if (kept === null) {
      // An event nobody bridges is nobody's business; one that is bridged and does not fit is a bug
      if (isBridged(event)) this.lost(event, new Error('the payload does not fit its schema'))
      return
    }
    try {
      const message = JSON.stringify({ id: randomUUID(), event, payload: kept })
      this.redis
        .publish(EVENTS_BRIDGE_CHANNEL, message)
        .catch((error: unknown) => this.lost(event, error))
    } catch (error) {
      this.lost(event, error)
    }
  }

  onModuleInit(): void {
    if (this.options.mode !== EventsBridgeModes.SUBSCRIBE) return
    // Its own connection, from the shared client so that it has the same settings (a connection in
    // subscriber mode can run no other command); it waits for Redis instead of failing fast
    const subscriber = this.redis.duplicate({
      maxRetriesPerRequest: null,
      commandTimeout: undefined
    })
    subscriber.on('error', error => this.logger.error(`bridge connection error: ${error.message}`))
    // On every connection, the first one and each one after Redis comes back. Not awaited: a Redis
    // that is down at boot costs the worker events, not the start of the api.
    subscriber.on('ready', () => {
      subscriber
        .subscribe(EVENTS_BRIDGE_CHANNEL)
        .then(() => this.markSubscribed())
        .catch((error: unknown) => {
          this.logger.error(
            'the bridge could not subscribe',
            error instanceof Error ? error.stack : String(error)
          )
        })
    })
    subscriber.on('message', (_channel: string, message: string) => {
      this.hear(message).catch((error: unknown) => {
        this.logger.error(
          'the bridge failed to pass an event on',
          error instanceof Error ? error.stack : String(error)
        )
      })
    })
    this.subscriber = subscriber
  }

  async onModuleDestroy(): Promise<void> {
    const subscriber = this.subscriber
    this.subscriber = null
    if (subscriber === null) return
    try {
      await subscriber.quit()
    } catch {
      subscriber.disconnect() // quit() rejects when the connection is already down
    }
  }

  private lost(event: string, error: unknown): void {
    this.logger.error(
      `${event} did not reach the bridge`,
      error instanceof Error ? error.stack : String(error)
    )
  }

  // Every api instance hears every event, and an emit through the sockets already reaches all of
  // them: the instance that claims the event first passes it on, the others let it go
  private async hear(message: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      this.logger.warn('the bridge heard something that is not JSON')
      return
    }
    const envelope = envelopeSchema.safeParse(parsed)
    const kept = envelope.success
      ? bridgedPayload(envelope.data.event, envelope.data.payload)
      : null
    if (!envelope.success || kept === null) {
      this.logger.warn('the bridge heard an event it does not know or that does not fit')
      return
    }
    const { id, event } = envelope.data
    const payload = kept
    // A claim that cannot be made is not a reason to lose the event: better heard twice (the sockets
    // are told ids to read again) than never
    const claimed = await this.redis
      .set(CacheKeys.eventsBridge.taken(id), '1', 'EX', EVENTS_BRIDGE_CLAIM_SECONDS, 'NX')
      .catch((error: unknown) => {
        this.logger.warn(`the bridge could not claim an event: ${String(error)}`)
        return 'OK'
      })
    if (claimed !== 'OK') return
    this.emitter.emitAsync(event, payload).catch((error: unknown) => {
      this.logger.error(
        `a listener of ${event} failed`,
        error instanceof Error ? error.stack : String(error)
      )
    })
  }
}
