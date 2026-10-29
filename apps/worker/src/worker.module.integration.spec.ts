import { Test } from '@nestjs/testing'

import { CustomerProfileProcessor } from './processors/customer-profile.processor'
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
    await moduleRef.close()
  })
})
