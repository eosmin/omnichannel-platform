import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common'
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client'

import { type MetricName } from '@platform/core/metrics'

import { HttpMetricsMiddleware } from './http-metrics.middleware'
import { MetricDefinitions, type MetricDefinition } from './metric-definitions'
import { getMetricToken, METRICS_REGISTRY } from './metric-tokens'
import { METRICS_ACCESS, type MetricsAccess } from './metrics-access'
import { MetricsController } from './metrics.controller'

// Every process metric (CPU, memory, event loop) carries this prefix
export const DEFAULT_METRICS_PREFIX = 'platform_'

function createMetric(name: MetricName, definition: MetricDefinition, registry: Registry): unknown {
  const common = {
    name,
    help: definition.help,
    labelNames: [...definition.labels],
    registers: [registry]
  }
  switch (definition.kind) {
    case 'counter':
      return new Counter(common)
    case 'gauge':
      return new Gauge(common)
    case 'histogram':
      return new Histogram({ ...common, buckets: [...(definition.buckets ?? [])] })
  }
}

const metricProviders: Provider[] = (
  Object.entries(MetricDefinitions) as [MetricName, MetricDefinition][]
).map(([name, definition]) => ({
  provide: getMetricToken(name),
  inject: [METRICS_REGISTRY],
  useFactory: (registry: Registry): unknown => createMetric(name, definition, registry)
}))

// A thin module over @prometheus-io/client: @willsoto/nestjs-prometheus still requires the
// deprecated prom-client (TDD_01 §2.4), so this offers the same shape, @InjectMetric, without it.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS_REGISTRY,
      useFactory: (): Registry => {
        const registry = new Registry()
        collectDefaultMetrics({ register: registry, prefix: DEFAULT_METRICS_PREFIX })
        return registry
      }
    },
    ...metricProviders,
    HttpMetricsMiddleware
  ],
  exports: [
    METRICS_REGISTRY,
    ...metricProviders.map(provider => (provider as { provide: string }).provide)
  ]
})
export class MetricsModule {
  // With the access the environment decides (the apps); the plain module is open, for the tests of a service
  static forRoot(access: MetricsAccess): DynamicModule {
    return { module: MetricsModule, providers: [{ provide: METRICS_ACCESS, useValue: access }] }
  }
}
