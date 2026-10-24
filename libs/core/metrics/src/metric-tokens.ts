import { Inject } from '@nestjs/common'

import type { MetricName } from '@platform/core/metrics'

export const METRICS_REGISTRY = 'METRICS_REGISTRY'

export function getMetricToken(name: MetricName): string {
  return `METRIC:${name}`
}

// @InjectMetric(MetricNames.ORDERS_CREATED) private readonly orders: Counter
export function InjectMetric(name: MetricName): ParameterDecorator {
  return Inject(getMetricToken(name))
}
