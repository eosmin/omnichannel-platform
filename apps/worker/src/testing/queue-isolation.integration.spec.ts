import { randomUUID } from 'node:crypto'

import { Queue, Worker } from 'bullmq'

import { queuePrefixFor } from '@platform/core/queues-module'

import { REDIS_URL } from './test-env'

// Two stacks on one Redis with two databases: the job of one must never reach the worker of the other.
// Before the prefix came from the database, both used "bull" and a worker with no row for a media took
// its scan job and ended it as a success.
describe('queues of two stacks that share a Redis', () => {
  const run = randomUUID().slice(0, 8)
  const connection = { url: REDIS_URL, maxRetriesPerRequest: null }
  const prefixA = queuePrefixFor(`postgresql://a:x@localhost:6432/it_${run}_a`)
  const prefixB = queuePrefixFor(`postgresql://a:x@localhost:6432/it_${run}_b`)
  const seenBy = { a: [] as string[], b: [] as string[] }
  const handles: Array<Queue | Worker> = []

  afterAll(async () => {
    for (const handle of handles) {
      if (handle instanceof Queue) await handle.obliterate({ force: true })
      await handle.close()
    }
  })

  it('delivers each job only to the worker of its own database', async () => {
    const make = (prefix: string, key: 'a' | 'b') => {
      const queue = new Queue<{ id: string }>('isolation', { connection, prefix })
      const worker = new Worker<{ id: string }>(
        'isolation',
        job => {
          seenBy[key].push(job.data.id)
          return Promise.resolve()
        },
        { connection, prefix }
      )
      handles.push(queue, worker)
      return { queue, worker }
    }
    const a = make(prefixA, 'a')
    const b = make(prefixB, 'b')
    await Promise.all([a.worker.waitUntilReady(), b.worker.waitUntilReady()])

    await Promise.all(
      [1, 2, 3, 4, 5, 6].map(i =>
        (i % 2 === 0 ? a : b).queue.add('scan', { id: `${i % 2 === 0 ? 'a' : 'b'}${i}` })
      )
    )
    // Until all six were taken (or the time is up, and the assertions say what is missing)
    for (let waited = 0; seenBy.a.length + seenBy.b.length < 6 && waited < 10_000; waited += 100) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    // A job that leaked to the other worker would show up a moment later
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(seenBy.a.sort()).toEqual(['a2', 'a4', 'a6'])
    expect(seenBy.b.sort()).toEqual(['b1', 'b3', 'b5'])
  })
})
