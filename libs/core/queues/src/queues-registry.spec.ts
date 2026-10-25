import { getQueueToken } from '@nestjs/bullmq'
import type { ModuleRef } from '@nestjs/core'
import type { Queue } from 'bullmq'

import { QueueNames } from '@platform/core/queues'

import { QueuesRegistry } from './queues-registry'

// A module ref that answers each queue token with a marker, so that the test needs no Redis
function build(): { registry: QueuesRegistry; get: jest.Mock } {
  const get = jest.fn((token: string) => ({ token }))
  const registry = new QueuesRegistry({ get } as unknown as ModuleRef) // Only get() is used
  return { registry, get }
}

describe('QueuesRegistry', () => {
  it('looks a queue up by the token @nestjs/bullmq registers it under, outside its own module', () => {
    const { registry, get } = build()

    registry.get(QueueNames.EMAIL)

    expect(get).toHaveBeenCalledWith(getQueueToken(QueueNames.EMAIL), { strict: false })
  })

  it('lists every queue of the platform once, the dead-letter queue included', () => {
    const { registry } = build()

    const entries = registry.entries()

    expect(entries.map(([name]) => name).sort()).toEqual(Object.values(QueueNames).sort())
    for (const [name, queue] of entries) {
      expect((queue as unknown as { token: string }).token).toBe(getQueueToken(name)) // The marker of build()
    }
  })

  it('has no queue of its own: what it returns is what the module ref gave', () => {
    const { registry } = build()
    const queue = { name: 'x' } as unknown as Queue
    const fixed = new QueuesRegistry({ get: () => queue } as unknown as ModuleRef)

    expect(fixed.get(QueueNames.DEAD_LETTER)).toBe(queue)
    expect(registry.get(QueueNames.EMAIL)).not.toBe(queue)
  })
})
