import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import type { PrismaTransaction } from '@platform/core/database'
import { ErrorCodes, errorName, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { FiscalProviderRegistry } from './fiscal-provider.registry'

// Whether a tax id written for a party that is not a receiver (a supplier) has the shape of the country of the organization's fiscal
// provider (FIN-212). What a tax id looks like is the provider's rule, so no format of a country is written in core. An organization with
// no issuer, and a provider with no rule, accept what was written: the same reading as the fiscal data of a customer.
@Injectable()
export class FiscalPartyTaxIdService {
  constructor(
    private readonly providers: FiscalProviderRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalPartyTaxIdService.name)
  }

  async isPlausible(
    tx: Pick<PrismaTransaction, 'fiscalIssuer'>,
    organizationId: string,
    taxId: string
  ): Promise<boolean> {
    const issuer = await tx.fiscalIssuer.findUnique({
      where: { organizationId },
      select: { providerId: true }
    })
    if (issuer === null) return true
    const provider = this.providers.find(issuer.providerId)
    try {
      return provider?.validatePartyTaxId?.(taxId) ?? true
    } catch (error) {
      // What a provider throws may carry the value: only the name of the error is logged, never its message
      this.logger.error(
        { err: errorName(error), providerId: issuer.providerId },
        'a provider could not check the tax id of a party'
      )
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the provider could not check the tax id',
        HttpStatusCodes.CONFLICT
      )
    }
  }
}
