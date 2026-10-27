import type { INestApplication } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { REDIS_CLIENT } from '@platform/core/redis'

import { RedisIoAdapter } from './redis-io.adapter'

// Makes the sockets of the app work across instances. Before the app starts (the gateway is created
// with the adapter that is set when it initializes): main.ts and the test app both call it.
export function useRealtime(app: INestApplication): void {
  const adapter = new RedisIoAdapter(app, app.get<Redis>(REDIS_CLIENT))
  adapter.connectToRedis()
  app.useWebSocketAdapter(adapter)
}
