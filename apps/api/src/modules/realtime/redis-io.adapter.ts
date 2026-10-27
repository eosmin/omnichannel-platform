import { type INestApplicationContext, Logger } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import type { Redis } from 'ioredis'
import type { Server, ServerOptions } from 'socket.io'

import { SocketLimits } from '@platform/core/realtime'

// Sockets live in one api instance, and an event can start in another: the Redis adapter carries
// every emit to all instances, so no sticky sessions are needed. It opens its
// own two connections, publisher and subscriber, from the shared client with its fail-fast limits
// lifted: a connection that waits for messages must not give up on them.
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name)
  private readonly connections: Redis[] = []
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null

  constructor(
    app: INestApplicationContext,
    private readonly redis: Redis
  ) {
    super(app)
  }

  connectToRedis(): void {
    // The publisher does not queue while Redis is down: an outage costs the events of its length, not
    // a memory that grows and a burst of old events when it ends. The subscriber has to queue, to
    // subscribe before it is connected.
    const publisher = this.redis.duplicate({
      maxRetriesPerRequest: null,
      commandTimeout: undefined,
      enableOfflineQueue: false
    })
    const subscriber = this.redis.duplicate({
      maxRetriesPerRequest: null,
      commandTimeout: undefined
    })
    // The adapter does not wait for its publishes, so a refused one would be a rejection nobody
    // catches: it is caught and logged here
    const publish = publisher.publish.bind(publisher)
    publisher.publish = (...args: Parameters<typeof publish>) =>
      publish(...args).catch((error: unknown) => {
        this.logger.warn(`socket adapter publish failed: ${String(error)}`)
        return 0
      })
    // Without a listener ioredis would throw the connection errors as uncaught exceptions. They are
    // logged: while they last, an event reaches only the sockets of the instance that emitted it.
    for (const connection of [publisher, subscriber]) {
      connection.on('error', error =>
        this.logger.error(`socket adapter connection error: ${error.message}`)
      )
      this.connections.push(connection)
    }
    this.adapterConstructor = createAdapter(publisher, subscriber)
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options)
    if (this.adapterConstructor !== null) server.adapter(this.adapterConstructor)
    return server
  }

  override async dispose(): Promise<void> {
    await super.dispose()
    await Promise.all(
      this.connections.map(async connection => {
        try {
          // The adapter sends its last commands when the server closes, and does not wait for them.
          // A ping goes behind them, so that quitting does not cut them off (their rejections would
          // be nobody's to catch).
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              connection.ping(),
              new Promise(resolve => {
                timer = setTimeout(resolve, SocketLimits.CLOSE_TIMEOUT_MS)
              })
            ])
          } finally {
            clearTimeout(timer)
          }
          await connection.quit()
        } catch {
          connection.disconnect() // quit() rejects when the connection is already down
        }
      })
    )
  }
}
