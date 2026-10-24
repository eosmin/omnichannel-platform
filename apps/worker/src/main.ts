import './instrument'

import { runHttpApp } from '@platform/core/http'

import { WorkerModule } from './worker.module'

// The worker listens too, only for /health, /health/ready and /metrics: the platform probes every
// service over HTTP.
void runHttpApp(WorkerModule)
