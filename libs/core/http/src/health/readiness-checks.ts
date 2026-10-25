import type { HealthIndicatorResult } from '@nestjs/terminus'

export type ReadinessCheck = () => PromiseLike<HealthIndicatorResult>

// Checks that only one service has, provided by a global module of that service: the worker adds
// "at least one BullMQ worker is running" (TDD_04 §4). Absent in the api.
export const READINESS_CHECKS = Symbol('READINESS_CHECKS')
