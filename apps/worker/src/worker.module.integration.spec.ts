import { Test } from '@nestjs/testing'

import {
  FiscalContingencyService,
  FiscalDocumentsService,
  FiscalProviderRegistry
} from '@platform/fiscal/runtime'

import { FinanceChainChecker } from './finance/finance-chain-checker.service'
import { FinanceReconciler } from './finance/finance-reconciler.service'
import { FiscalReconciler } from './finance/fiscal-reconciler.service'
import { InvitationEmailDelivery } from './invitations/invitation-email-delivery.service'
import { AnalyticsProcessor } from './processors/analytics.processor'
import { CustomerProfileProcessor } from './processors/customer-profile.processor'
import { EmailProcessor } from './processors/email.processor'
import { NotificationsProcessor } from './processors/notifications.processor'
import { OutboundProcessor } from './processors/outbound.processor'
import { InvitationEmailScheduler } from './schedulers/invitation-email.scheduler'
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
    // The contingency is reported by the heavy processor and its windows are checked by the daily check: built with the queue, or the worker
    // would not start
    expect(moduleRef.get(FiscalContingencyService, { strict: false })).toBeInstanceOf(
      FiscalContingencyService
    )
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

  // The email of an invitation waits in an outbox that the worker delivers: the processor of the email queue and the sweep must be built with
  // the real delivery (the test harness of the email path stubs it; this is the proof that the worker as it runs wires it, and that the
  // key of the credentials it opens the outbox with is provided), or the worker would not start and no invitation would get its email
  it('builds the email processor and the sweep of invitation emails with the real delivery', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile()

    const delivery = moduleRef.get(InvitationEmailDelivery, { strict: false })
    expect(delivery).toBeInstanceOf(InvitationEmailDelivery)
    const processor = moduleRef.get(EmailProcessor, { strict: false })
    expect((processor as unknown as { invitations: unknown }).invitations).toBe(delivery)
    expect(moduleRef.get(InvitationEmailScheduler, { strict: false })).toBeInstanceOf(
      InvitationEmailScheduler
    )
    await moduleRef.close()
  })
})
