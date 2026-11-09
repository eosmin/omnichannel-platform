import { createHash } from 'node:crypto'

// BullMQ namespaces its Redis keys with a prefix, "bull" by default. Two stacks that share one Redis
// but not the database would then share the queues, and the worker of one takes the jobs of the other:
// it finds no row for them and ends them as a success. So the prefix is derived from the NAME of the
// database, and QUEUE_PREFIX overrides it.
//
// Only the name, not the host or the port: the api and the worker connect with different roles and may
// reach the same database by different ways (through PgBouncer or directly, another host or port). A
// prefix that followed the way would send the api's jobs to a queue that no worker reads, and nothing
// would be processed without an error. The price is that two different servers that hold a database
// of the same name and share one Redis would share the queues: set QUEUE_PREFIX in one of them.
export function queuePrefixFor(databaseUrl: string, override?: string): string {
  if (override !== undefined) return override
  const name = new URL(databaseUrl).pathname.replace(/^\//, '')
  return `q-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
}
