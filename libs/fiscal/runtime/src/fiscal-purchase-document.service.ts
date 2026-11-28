import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import type { PrismaTransaction } from '@platform/core/database'
import { ErrorCodes, errorName, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import type {
  FiscalExcludedSubjectPurchaseInput,
  FiscalPurchaseDocumentInput
} from '@platform/fiscal/sdk'

import { FiscalProviderRegistry } from './fiscal-provider.registry'

// What is wrong in the supplier's document of a purchase, by the rules of the organization's fiscal provider (D4b). What the classes and the
// types of a document are is the provider's rule, so no code of a country is written in core. An organization with no issuer, and a
// provider with no rule, accept what was written: the same reading as the tax id of a supplier.
@Injectable()
export class FiscalPurchaseDocumentService {
  constructor(
    private readonly providers: FiscalProviderRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalPurchaseDocumentService.name)
  }

  // The same for a purchase from an excluded subject (D20b): what the provider's manual finds wrong in what was written
  async excludedSubjectProblems(
    tx: Pick<PrismaTransaction, 'fiscalIssuer'>,
    organizationId: string,
    input: FiscalExcludedSubjectPurchaseInput
  ): Promise<readonly string[]> {
    const issuer = await tx.fiscalIssuer.findUnique({
      where: { organizationId },
      select: { providerId: true }
    })
    if (issuer === null) return []
    const provider = this.providers.find(issuer.providerId)
    try {
      return provider?.validateExcludedSubjectPurchase?.(input) ?? []
    } catch (error) {
      // What a provider throws may carry the value: only the name of the error is logged, never its message
      this.logger.error(
        { err: errorName(error), providerId: issuer.providerId },
        'a provider could not check a purchase from an excluded subject'
      )
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the provider could not check the purchase',
        HttpStatusCodes.CONFLICT
      )
    }
  }

  async problems(
    tx: Pick<PrismaTransaction, 'fiscalIssuer'>,
    organizationId: string,
    input: FiscalPurchaseDocumentInput
  ): Promise<readonly string[]> {
    const issuer = await tx.fiscalIssuer.findUnique({
      where: { organizationId },
      select: { providerId: true }
    })
    if (issuer === null) return []
    const provider = this.providers.find(issuer.providerId)
    try {
      return provider?.validatePurchaseDocument?.(input) ?? []
    } catch (error) {
      // What a provider throws may carry the value: only the name of the error is logged, never its message
      this.logger.error(
        { err: errorName(error), providerId: issuer.providerId },
        'a provider could not check the document of a purchase'
      )
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the provider could not check the document of the purchase',
        HttpStatusCodes.CONFLICT
      )
    }
  }
}
