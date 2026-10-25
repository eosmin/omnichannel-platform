import { WorkerHost } from '@nestjs/bullmq'
import type { DiscoveryService } from '@nestjs/core'
import { HealthIndicatorService } from '@nestjs/terminus'

import { BullWorkersIndicator } from './bull-workers.indicator'

// A processor whose BullMQ worker is in the given state: running, stopped, or not created yet
class FakeProcessor extends WorkerHost {
  constructor(private readonly state: 'running' | 'stopped' | 'missing') {
    super()
  }

  override get worker(): never {
    if (this.state === 'missing') throw new Error('"Worker" has not yet been initialized')
    return { isRunning: () => this.state === 'running' } as never // Only isRunning() is read
  }

  process(): Promise<void> {
    return Promise.resolve()
  }
}

function indicatorWith(...instances: unknown[]): BullWorkersIndicator {
  const discovery = {
    getProviders: () => [
      { instance: { unrelated: true } },
      ...instances.map(instance => ({ instance }))
    ]
  } as unknown as DiscoveryService // Only getProviders() is used
  return new BullWorkersIndicator(discovery, new HealthIndicatorService())
}

describe('BullWorkersIndicator', () => {
  it('is up when a worker is running, and counts only the running ones', () => {
    const result = indicatorWith(
      new FakeProcessor('running'),
      new FakeProcessor('stopped')
    ).isHealthy('bullmq')

    expect(result).toEqual({ bullmq: { status: 'up', running: 1 } })
  })

  it('is down when every worker stopped: the process is alive but does no work', () => {
    const result = indicatorWith(new FakeProcessor('stopped')).isHealthy('bullmq')

    expect(result).toEqual({ bullmq: { status: 'down', running: 0, expected: 1 } })
  })

  it('is down while the worker is not created yet, instead of throwing', () => {
    const result = indicatorWith(new FakeProcessor('missing')).isHealthy('bullmq')

    expect(result).toMatchObject({ bullmq: { status: 'down', running: 0 } })
  })

  it('is down when there is no processor at all', () => {
    expect(indicatorWith().isHealthy('bullmq')).toEqual({
      bullmq: { status: 'down', running: 0, expected: 0 }
    })
  })
})
