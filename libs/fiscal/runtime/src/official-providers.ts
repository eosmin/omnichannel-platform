import { FiscalSimulatorEnvironments } from '@platform/core/domain'
import type { FiscalDocumentProvider } from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'
import { svProvider } from '@platform/fiscal/sv'

// The composition root of the providers (like `official-plugins.ts` of the plugins runtime): the one file that imports a provider
// package. The simulator is registered in development and test only (TDD_18 §8.1), and only when NODE_ENV says so: an unset or unknown value, staging and production never get it; the real provider joins here,
// and nothing else in core changes (Step 4B.7, debt (c) of 4B.1).
export function officialFiscalProviders(nodeEnv: string | undefined): FiscalDocumentProvider[] {
  const providers: FiscalDocumentProvider[] = []
  if (nodeEnv !== undefined && FiscalSimulatorEnvironments.includes(nodeEnv)) {
    // The simulator first: it is the default a form offers
    providers.push(simulatorProvider())
    // The provider of a country builds its documents (Step 4B.7c-2) but cannot send, consult or invalidate them until Step 4B.7c-3 and
    // 4B.7c-4: until then it is registered where the simulator is, so no issuer of a staging or production deployment can choose it.
    // Its registration moves to the real condition (a deployment that has its credentials) when it can send.
    providers.push(svProvider())
  }
  return providers
}
