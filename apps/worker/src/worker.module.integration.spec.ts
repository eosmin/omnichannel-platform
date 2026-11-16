import { Test } from '@nestjs/testing'

import { FiscalDocumentsService, FiscalProviderRegistry } from '@platform/fiscal/runtime'

import { FinanceChainChecker } from './finance/finance-chain-checker.service'
import { FinanceReconciler } from './finance/finance-reconciler.service'
import { FiscalReconciler } from './finance/fiscal-reconciler.service'
import { AnalyticsProcessor } from './processors/analytics.processor'
import { CustomerProfileProcessor } from './processors/customer-profile.processor'
import { NotificationsProcessor } from './processors/notifications.processor'
import { OutboundProcessor } from './processors/outbound.processor'
import { WorkerModule } from './worker.module'

// The dependency graph of the worker as it runs: a provider that asks for something its module does
// not import fails here, and not when the container starts. Compiled and not initialized, so that
// no processor takes a job and no cron runs.
describe('WorkerModule', () => {
  it('resolves every provider, the processors and schedulers included', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile()

    expect(moduleRef.get(OutboundProcessor)).toBeInstanceOf(OutboundProcessor)
    // It lives in a module of its own: the one that asks the registry for the plugin of a connection
    expect(moduleRef.get(CustomerProfileProcessor, { strict: false })).toBeInstanceOf(
      CustomerProfileProcessor
    )
    expect(moduleRef.get(NotificationsProcessor, { strict: false })).toBeInstanceOf(
      NotificationsProcessor
    )
    expect(moduleRef.get(AnalyticsProcessor, { strict: false })).toBeInstanceOf(AnalyticsProcessor)
    // The daily check of the books asks the heavy queue and the metrics: it must be built with them (it broke the worker once)
    expect(moduleRef.get(FinanceReconciler, { strict: false })).toBeInstanceOf(FinanceReconciler)
    // The weekly check of the chain needs the monitor of the books and its gauge: built with them, or the worker would not start
    expect(moduleRef.get(FinanceChainChecker, { strict: false })).toBeInstanceOf(
      FinanceChainChecker
    )
    // The daily check of the fiscal documents asks the heavy queue and the metrics, and the lifecycle: built with them, or the worker would not start
    expect(moduleRef.get(FiscalReconciler, { strict: false })).toBeInstanceOf(FiscalReconciler)
    // The fiscal documents are submitted by the heavy processor: the lifecycle must be built with the providers of the deployment, and the
    // simulator is one of them in test (it is never one in production)
    expect(moduleRef.get(FiscalDocumentsService, { strict: false })).toBeInstanceOf(
      FiscalDocumentsService
    )
    expect(moduleRef.get(FiscalProviderRegistry, { strict: false }).list().length).toBeGreaterThan(
      0
    )
    await moduleRef.close()
  })
})
