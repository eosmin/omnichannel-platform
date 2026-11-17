import { FiscalSimulatorEnvironments } from '@platform/core/domain'
import type { FiscalDocumentProvider } from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'
import { officialSigner, SvTimeouts, svProvider } from '@platform/fiscal/sv'

// What a deployment gives the providers: the address of the signing service some of them need (null when it has none)
export interface FiscalProviderConfig {
  readonly signerUrl: string | null
}

// The composition root of the providers (like `official-plugins.ts` of the plugins runtime): the one file that imports a provider
// package. The simulator is registered in development and test only (TDD_18 §8.1), and only when NODE_ENV says so: an unset or unknown value,
// staging and production never get it. A provider that signs for real is registered where the deployment says it has what it needs: here
// the address of its signing service. The platform decides nothing else about it (Step 4B.7, debt (c) of 4B.1).
export function officialFiscalProviders(
  nodeEnv: string | undefined,
  config: FiscalProviderConfig = { signerUrl: null }
): FiscalDocumentProvider[] {
  const providers: FiscalDocumentProvider[] = []
  // The simulator first: it is the default a form offers
  if (nodeEnv !== undefined && FiscalSimulatorEnvironments.includes(nodeEnv)) {
    providers.push(simulatorProvider())
  }
  if (config.signerUrl !== null) {
    providers.push(
      svProvider({
        signer: officialSigner({
          baseUrl: config.signerUrl,
          fetch: (url, init) => fetch(url, init),
          timeoutMs: SvTimeouts.SIGNER_MS
        })
      })
    )
  }
  return providers
}
