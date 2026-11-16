import { Inject, Injectable } from '@nestjs/common'

import type { FiscalDocumentProvider, FiscalProviderManifest } from '@platform/fiscal/sdk'

export const FISCAL_PROVIDERS = Symbol('FISCAL_PROVIDERS')

// The providers this deployment has, by the id each one owns. Core asks the registry for the id the issuer row names and never
// names one itself.
@Injectable()
export class FiscalProviderRegistry {
  private readonly byId: Map<string, FiscalDocumentProvider>

  constructor(@Inject(FISCAL_PROVIDERS) providers: readonly FiscalDocumentProvider[]) {
    const byId = new Map<string, FiscalDocumentProvider>()
    for (const provider of providers) {
      // A second provider under the same id would take the documents of the first one's issuer
      if (byId.has(provider.id)) throw new Error(`two fiscal providers share the id ${provider.id}`)
      byId.set(provider.id, provider)
    }
    this.byId = byId
  }

  find(id: string): FiscalDocumentProvider | undefined {
    return this.byId.get(id)
  }

  list(): {
    id: string
    countryCode: string
    manifest: FiscalProviderManifest
    contingency: string | null
  }[] {
    return [...this.byId.values()].map(provider => ({
      id: provider.id,
      countryCode: provider.countryCode,
      manifest: provider.manifest,
      contingency: provider.contingency?.description ?? null
    }))
  }
}
