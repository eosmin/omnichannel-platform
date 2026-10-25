import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown
} from '@nestjs/common'
import { Redis } from 'ioredis'

export const REDIS_CLIENT = Symbol('REDIS_CLIENT')

export interface RedisModuleOptions {
  url: string
}

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'end') return
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect() // quit() rejects when the connection is already down
    }
  }
}

// The client of the cache, the leader locks and the readiness probe. The queues open their own
// connections (they need maxRetriesPerRequest: null, which a request-reply client must not have).
@Global()
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        {
          provide: REDIS_CLIENT,
          useFactory: (): Redis => {
            const client = new Redis(options.url) // TLS is implied by rediss://
            const logger = new Logger('Redis')
            // Without a listener ioredis would throw the connection errors as uncaught exceptions
            client.on('error', error => logger.error(`redis connection error: ${error.message}`))
            return client
          }
        },
        RedisShutdown
      ],
      exports: [REDIS_CLIENT]
    }
  }
}
