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
      if (provider.id === '' || provider.id !== provider.id.trim()) {
        throw new Error('a fiscal provider has an empty id, or one with spaces around it')
      }
      const types = provider.manifest.documentTypes.map(type => type.id)
      // A type id is the provider's own, but it is never empty, never repeated and never the placeholder core keeps until a document is built
      if (
        new Set(types).size !== types.length ||
        types.some(type => type.trim() === '' || type === FiscalPendingDocumentType)
      ) {
        throw new Error(`the document types of the fiscal provider ${provider.id} are not valid`)
      }
      // A provider that numbers by document type is asked for the type before `build`: one that cannot answer would never be numbered
      if (
        provider.manifest.sequence?.perDocumentType === true &&
        provider.resolveDocumentType === undefined
      ) {
        throw new Error(
          `the fiscal provider ${provider.id} numbers by document type and has no resolveDocumentType`
        )
      }
      // A series by establishment or by point of sale needs that code from the issuer: the manifest must say so (the settings screen reads
      // `requiredIssuerFields`), and a document of an issuer that still lacks it is refused when it is numbered (`correlativeOf`)
      const sequence = provider.manifest.sequence
      const required = provider.manifest.requiredIssuerFields
      if (
        (sequence?.perEstablishment === true && !required.includes('establishmentCode')) ||
        (sequence?.perPointOfSale === true && !required.includes('pointOfSaleCode'))
      ) {
        throw new Error(
          `the fiscal provider ${provider.id} numbers by establishment or point of sale and does not require that code of the issuer`
        )
      }
      // A provider that declares a contingency mode must report it, and its numbers must make sense (a window and a size of event)
      const mode = provider.manifest.contingencyMode
      if (
        mode !== undefined &&
        (provider.reportContingency === undefined ||
          provider.deferDocument === undefined ||
          mode.reasons.length === 0 ||
          !mode.reasons.includes(mode.authorityDownReason) ||
          !(mode.transmitWithinHours > 0) ||
          !Number.isInteger(mode.maxDocumentsPerEvent) ||
          mode.maxDocumentsPerEvent < 1)
      ) {
        throw new Error(`the contingency mode of the fiscal provider ${provider.id} is not valid`)
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
