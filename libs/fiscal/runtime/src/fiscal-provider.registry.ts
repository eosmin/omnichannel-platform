import { Inject, Injectable } from '@nestjs/common'

import { FiscalPendingDocumentType } from '@platform/core/domain'
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
      if (provider.id.trim() === '') throw new Error('a fiscal provider has no id')
      const types = provider.manifest.documentTypes.map(type => type.id)
      // A type id is the provider's own, but it is never empty, never repeated and never the placeholder core keeps until a document is built
      if (
        new Set(types).size !== types.length ||
        types.some(type => type.trim() === '' || type === FiscalPendingDocumentType)
      ) {
        throw new Error(`the document types of the fiscal provider ${provider.id} are not valid`)
      }
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
