import { WorkerHost } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus'

// Readiness of the worker: at least one BullMQ worker is running (TDD_04 §4). A process whose
// workers all stopped is alive but does no work, so the platform should not count it as ready.
@Injectable()
export class BullWorkersIndicator {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly indicators: HealthIndicatorService
  ) {}

  isHealthy(key: string): HealthIndicatorResult {
    const session = this.indicators.check(key)
    const hosts = this.discovery
      .getProviders()
      .map((wrapper): unknown => wrapper.instance)
      .filter((instance): instance is WorkerHost => instance instanceof WorkerHost)
    const running = hosts.filter(host => isRunning(host)).length
    return running > 0 ? session.up({ running }) : session.down({ running, expected: hosts.length })
  }
}

function isRunning(host: WorkerHost): boolean {
  try {
    return host.worker.isRunning()
  } catch {
    return false // The getter throws until the module has created the worker
  }
}
