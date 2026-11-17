import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'

export const FISCAL_SIGNER_URL = Symbol('FISCAL_SIGNER_URL')

// The address of the signing service of the fiscal providers, from the validated env (null when there is none). A library outside libs/core
// may not read the env, so the fiscal runtime asks for this token.
@Module({
  providers: [{ provide: FISCAL_SIGNER_URL, useValue: env.FISCAL_SIGNER_URL ?? null }],
  exports: [FISCAL_SIGNER_URL]
})
export class FiscalSignerPlatformModule {}
