import type { FiscalDocumentProvider } from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'

// The composition root of the providers (like `official-plugins.ts` of the plugins runtime): the one file that imports a provider
// package. The simulator is registered in development and test only, never in production (TDD_18 §8.1); the real provider joins here,
// and nothing else in core changes (Step 4B.7, debt (c) of 4B.1).
export function officialFiscalProviders(nodeEnv: string | undefined): FiscalDocumentProvider[] {
  const providers: FiscalDocumentProvider[] = []
  if (nodeEnv !== 'production') providers.push(simulatorProvider())
  return providers
}
