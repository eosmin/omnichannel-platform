import { queuePrefixFor } from '@platform/core/queues-module'

// Where the integration suites of the api find Redis: the variable CI and .env.example define, with
// the local docker compose address as the default. The one file of the api that reads process.env.
export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

// The prefix of the queues, and so of the channel of the events bridge, that the apps of a test run use: derived as the platform
// module derives it, from the database of the run and QUEUE_PREFIX
export const BRIDGE_PREFIX = queuePrefixFor(
  process.env['DATABASE_URL'] ?? '',
  process.env['QUEUE_PREFIX'] === '' ? undefined : process.env['QUEUE_PREFIX']
)
